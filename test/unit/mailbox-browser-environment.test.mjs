import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { browserRuntimeTarget, manageMailboxBrowserRuntime } from '../../src/lib/oauth/mailbox-browser-environment.mjs'

test('runtime target requires exact supported guest OS, Python ABI and architecture', () => {
  for (const [distro, version, python] of [
    ['ubuntu', '22.04', '3.10'],
    ['ubuntu', '24.04', '3.12'],
    ['debian', '12', '3.11'],
    ['debian', '13', '3.13'],
  ]) {
    for (const arch of ['amd64', 'arm64'])
      assert.equal(browserRuntimeTarget({ os: distro, os_version: version, python, arch }).python, python)
  }
  for (const info of [
    { os: 'alpine', os_version: '3.22', python: '3.12', arch: 'amd64' },
    { os: 'debian', os_version: '12', python: '3.12', arch: 'amd64' },
    { os: 'ubuntu', os_version: '24.04', python: '3.12', arch: 'riscv64' },
  ])
    assert.throws(() => browserRuntimeTarget(info), /browser_os_unsupported/)
})

test('installer detects the guest, caches verified bundles and streams into that slot without account data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-env-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  const cache = path.join(root, 'share/kin-mailbox-runtime/managed')
  fs.mkdirSync(cache, { recursive: true })
  const oldKey = 'debian-12-amd64-py3.11-1.64.1-r3'
  fs.writeFileSync(path.join(cache, oldKey + '.tar.gz'), 'old-headless-bundle')
  fs.writeFileSync(
    path.join(cache, oldKey + '.json'),
    JSON.stringify({ sha256: crypto.createHash('sha256').update('old-headless-bundle').digest('hex') }),
  )
  for (const file of ['mailbox-runtime-slot.py', 'build-mailbox-portable.py', 'mailbox-display.py'])
    fs.copyFileSync(path.join('scripts', file), path.join(root, 'scripts', file))
  const calls = [],
    info = { os: 'debian', os_version: '12', arch: 'amd64', python: '3.11', supported: true }
  const run = async (options) => {
    calls.push(options)
    if (options.output) {
      fs.writeFileSync(options.output, 'test-bundle')
      return ''
    }
    const job = JSON.parse(options.input)
    return JSON.stringify({
      ok: true,
      data: job.action === 'status' ? info : { ...info, installed: true, verified: true },
    })
  }
  const args = {
    projectRoot: root,
    vm: { id: 'vm-91', schedulable: true, runtime: { container: 'isolated-test-slot' } },
    action: 'install',
    run,
  }
  await manageMailboxBrowserRuntime(args)
  assert.equal(calls.filter((call) => call.output).length, 1)
  assert.ok(calls.find((call) => call.output).argv.includes('debian:12'))
  const install = calls.find((call) => call.archive)
  assert.ok(install.archive.endsWith('-r4.tar.gz'))
  assert.ok(install.argv.includes('isolated-test-slot'))
  const uidArg = install.argv.indexOf('-u')
  assert.notEqual(uidArg, -1)
  assert.equal(install.argv[uidArg + 1], '10091:987')
  for (const call of calls.filter((call) => call.argv[0] === 'exec'))
    assert.equal(call.argv[call.argv.indexOf('-u') + 1], '10091:987')
  assert.equal(JSON.parse(install.input).target.python, '3.11')
  assert.ok(!JSON.stringify(calls).includes('password'))
  await manageMailboxBrowserRuntime(args)
  assert.equal(calls.filter((call) => call.output).length, 1)
  fs.writeFileSync(install.archive, 'corrupted')
  await manageMailboxBrowserRuntime(args)
  assert.equal(calls.filter((call) => call.output).length, 2)
  calls.length = 0
  await manageMailboxBrowserRuntime({ ...args, vm: { ...args.vm, schedulable: false } })
  assert.ok(calls.find((call) => call.archive).argv.includes('isolated-test-slot'))
})
