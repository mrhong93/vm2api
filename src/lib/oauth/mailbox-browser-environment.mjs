import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { mailboxError } from './codex-mailbox-store.mjs'

const VERSION = '1.64.1'
const TARGETS = new Map([
  ['ubuntu:22.04', '3.10'],
  ['ubuntu:24.04', '3.12'],
  ['debian:12', '3.11'],
  ['debian:13', '3.13'],
])

export function browserRuntimeTarget(info) {
  if (
    !TARGETS.has(`${info.os}:${info.os_version}`) ||
    TARGETS.get(`${info.os}:${info.os_version}`) !== info.python ||
    !['amd64', 'arm64'].includes(info.arch)
  )
    throw mailboxError('browser_os_unsupported', 409)
  return { os: info.os, os_version: info.os_version, arch: info.arch, python: info.python }
}

export function browserBuilderScript(packer, downloadProxy = '') {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  // Optional operator-supplied download proxy, scoped to the disposable builder.
  const proxy = downloadProxy
    ? `export http_proxy=${quote(downloadProxy)} https_proxy=${quote(downloadProxy)} HTTP_PROXY=${quote(downloadProxy)} HTTPS_PROXY=${quote(downloadProxy)}\n`
    : ''
  return `set -eu
${proxy}export DEBIAN_FRONTEND=noninteractive
export PLAYWRIGHT_BROWSERS_PATH=/opt/kin-mailbox/browsers
(
 apt-get update -qq
 apt-get install -y --no-install-recommends python3 python3-venv ca-certificates
 python3 -m venv /opt/kin-mailbox/venv
 /opt/kin-mailbox/venv/bin/python -m pip install --disable-pip-version-check playwright==${VERSION}
 /opt/kin-mailbox/venv/bin/python -m playwright install --with-deps chromium
) >&2
exec /opt/kin-mailbox/venv/bin/python -c ${quote(packer)}
`
}

// Keep installer output private: package tools can include network/proxy details.
export async function runBrowserDocker({ argv, env, input, archive, output, signal, timeout = 120_000 }) {
  if (signal?.aborted) throw mailboxError('login_cancelled', 409)
  const child = spawn('docker', argv, { env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let text = '',
    overflow = false
  let timedOut = false
  const abort = () => child.kill('SIGKILL')
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, timeout)
  signal?.addEventListener('abort', abort, { once: true })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(mailboxError('browser_runtime_operation_failed', 502)))
    child.once('close', (code) => {
      if (signal?.aborted) reject(mailboxError('login_cancelled', 409))
      else if (code !== 0 || overflow || timedOut) reject(mailboxError('browser_runtime_operation_failed', 502))
      else resolve(text)
    })
  })
  const outputDone = output ? pipeline(child.stdout, fs.createWriteStream(output, { mode: 0o600 })) : Promise.resolve()
  if (!output)
    child.stdout.on('data', (chunk) => {
      text += chunk.toString('utf8')
      if (text.length > 32_000) {
        overflow = true
        abort()
      }
    })
  child.stdin.write(input || '')
  const inputDone = archive ? pipeline(fs.createReadStream(archive), child.stdin) : Promise.resolve(child.stdin.end())
  try {
    const [result] = await Promise.all([completed, outputDone, inputDone])
    return result
  } catch (error) {
    abort()
    await Promise.allSettled([completed, outputDone, inputDone])
    // A structured slot error is safe to return; never return raw stderr.
    try {
      const reply = JSON.parse(text)
      if (reply.ok === false && /^[a-z_]{1,60}$/.test(reply.code)) throw mailboxError(reply.code, 409)
    } catch (parsed) {
      if (parsed.code && /^[a-z_]{1,60}$/.test(parsed.code)) throw parsed
    }
    throw error.code ? error : mailboxError('browser_runtime_operation_failed', 502)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function manageMailboxBrowserRuntime({
  projectRoot,
  vm,
  action,
  signal,
  onStage = () => {},
  run = runBrowserDocker,
}) {
  const host = slotHost(vm)
  if (host.native) throw mailboxError('browser_os_unsupported', 409)
  const env = host.dockerEnv()
  const runner = fs.readFileSync(path.join(projectRoot, 'scripts/mailbox-runtime-slot.py'), 'utf8')
  // Docker slots drop all capabilities: UID 0 cannot traverse the slot user's
  // 0700 home or drop privileges for the launch check. Use the browser's owner.
  const user = isKvmRuntime(vm) ? '0' : host.execUser(vm)
  const command = slotExecArgv(vm, ['python3', '-u', '-c', runner], { user, interactive: true })
  const slot = async (operation, target, archive) => {
    const jobId = crypto.randomUUID()
    let output
    try {
      output = await run({
        argv: command,
        env,
        signal,
        archive,
        timeout: 240_000,
        input: JSON.stringify({ action: operation, target, job_id: jobId }) + '\n',
      })
    } catch (error) {
      if (operation !== 'status') {
        // Killing a docker CLI does not kill exec's guest process. Wait for its
        // rollback before the service releases the slot maintenance lock.
        await run({
          argv: command,
          env,
          timeout: 30_000,
          input: JSON.stringify({ action: 'cancel', job_id: jobId }) + '\n',
        })
      }
      throw error
    }
    let reply
    try {
      reply = JSON.parse(output)
    } catch {
      throw mailboxError('browser_runtime_operation_failed', 502)
    }
    if (!reply.ok)
      throw mailboxError(/^[a-z_]{1,60}$/.test(reply.code) ? reply.code : 'browser_runtime_operation_failed', 409)
    return reply.data
  }
  if (action === 'status') return slot('status')
  if (action === 'uninstall') {
    onStage('uninstalling_browser')
    return slot('uninstall')
  }
  if (action !== 'install') throw mailboxError('invalid_browser_operation')
  onStage('detecting_browser_os')
  const target = browserRuntimeTarget(await slot('status'))
  const cache = path.join(projectRoot, 'share/kin-mailbox-runtime/managed')
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  const key = `${target.os}-${target.os_version}-${target.arch}-py${target.python}-${VERSION}-r3`
  const archive = path.join(cache, key + '.tar.gz')
  const manifest = path.join(cache, key + '.json')
  let valid = false
  try {
    valid = JSON.parse(fs.readFileSync(manifest, 'utf8')).sha256 === (await sha256(archive))
  } catch {
    /* Cache miss. */
  }
  if (!valid) {
    onStage('building_browser_runtime')
    const name = `vm2api-browser-build-${crypto.randomUUID()}`
    const temporary = archive + `.${crypto.randomUUID()}.tmp`
    try {
      await run({
        argv: [
          'run',
          '--rm',
          '--log-driver',
          'none',
          '--name',
          name,
          '--platform',
          `linux/${target.arch}`,
          '-i',
          `${target.os}:${target.os_version}`,
          'sh',
          '-s',
        ],
        env,
        signal,
        timeout: 20 * 60_000,
        output: temporary,
        input: browserBuilderScript(
          fs.readFileSync(path.join(projectRoot, 'scripts/build-mailbox-portable.py'), 'utf8'),
          process.env.VM2API_BROWSER_BUILD_PROXY || '',
        ),
      })
      const hash = await sha256(temporary)
      fs.renameSync(temporary, archive)
      fs.writeFileSync(manifest, JSON.stringify({ ...target, version: VERSION, sha256: hash }), { mode: 0o600 })
    } catch (error) {
      try {
        await run({ argv: ['rm', '-f', name], env, timeout: 30_000 })
      } catch {
        /* Already removed. */
      }
      throw error.code === 'login_cancelled' ? error : mailboxError('browser_packages_failed', 502)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  if (signal?.aborted) throw mailboxError('login_cancelled', 409)
  onStage('installing_browser_runtime')
  return slot('install', target, archive)
}
