import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecArgv, slotExecContainer } from '../vm/slot-exec.mjs'
import { inspectContainerOrNull } from '../cluster/docker-remote.mjs'
import { slotNetworkForVm } from '../vm/egress.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { CODEX_APP_VERSION, CODEX_CATALOG_ORIGINATOR, CODEX_USER_AGENT } from '../protocol/codex-models.mjs'

const failure = (failure, reason) => ({ verdict: 'inconclusive', failure, reason })
export async function runQualityStateProbe({
  projectRoot,
  vm,
  model,
  signal,
  inspect = inspectContainerOrNull,
  spawnImpl = spawn,
}) {
  if (!isCodexVm(vm)) return failure('unsupported', '门票探针仅支持 GPT OAuth 槽位')
  const host = slotHost(vm)
  if (host.native) return failure('unsupported', '当前运行方式尚不支持槽位门票探针')
  const container = await inspect(host.dockerApi(), slotExecContainer(vm))
  if (!container?.State?.Running || container.State.Paused) return failure('slot_not_running', '槽位未运行')
  if (!slotNetworkForVm(vm) || container.HostConfig?.NetworkMode !== slotNetworkForVm(vm))
    return failure('slot_egress_mismatch', '槽位网络与绑定出口不一致')
  const account = readCodexAccounts(projectRoot, vm.id)[0]
  if (!account?.access_token) return failure('no_credential', '槽位没有可用 OAuth 凭据')
  if (signal?.aborted) return failure('cancelled', '检测已取消')
  const source = fs.readFileSync(path.join(projectRoot, 'scripts/quality-state-probe.py'), 'utf8')
  const argv = slotExecArgv(vm, ['python3', '-u', '-c', source], { user: host.execUser(vm), interactive: true })
  return new Promise((resolve) => {
    let output = '',
      done = false
    const child = spawnImpl('docker', argv, { env: host.dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = () => {
      child.kill('SIGKILL')
      finish(failure('cancelled', '检测已取消或超时'))
    }
    const timer = setTimeout(abort, 100_000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => {})
    child.stderr.resume()
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > 100_000) abort()
    })
    child.once('error', () => finish(failure('slot_exec_failed', '槽位探针进程未启动')))
    child.once('close', (code) => {
      try {
        const result = JSON.parse(output)
        if (code !== 0 || !['healthy', 'degraded', 'inconclusive'].includes(result.verdict)) throw Error()
        finish(result)
      } catch {
        finish(failure('probe_failed', '槽位探针没有返回有效结果'))
      }
    })
    // Token/cookies/tickets never appear in argv, server logs or persisted files.
    child.stdin.end(
      JSON.stringify({
        access_token: account.access_token,
        account_id: account.chatgpt_account_id || '',
        model,
        user_agent: CODEX_USER_AGENT,
        originator: CODEX_CATALOG_ORIGINATOR,
        version: CODEX_APP_VERSION,
      }) + '\n',
    )
  })
}
