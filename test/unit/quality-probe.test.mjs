import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runQualityStateProbe } from '../../src/lib/admin/quality-probe.mjs'
import { writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { slotNetworkForVm } from '../../src/lib/vm/egress.mjs'

const vm = { id: 'vm-01', platform: 'openai', proxy: { id: 'test-exit' }, runtime: { container: 'kin-01' } }
test('state probe executes inside bound network as slot user and sends secrets only on stdin', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-probe-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(projectRoot, 'scripts'))
  fs.mkdirSync(path.join(projectRoot, 'vms', vm.id), { recursive: true })
  fs.copyFileSync('scripts/quality-state-probe.py', path.join(projectRoot, 'scripts/quality-state-probe.py'))
  writeCodexAccounts(projectRoot, vm.id, [{ access_token: 'secret-token', chatgpt_account_id: 'secret-account' }])
  let args,
    input = ''
  const spawnImpl = (cmd, argv) => {
    assert.equal(cmd, 'docker')
    args = argv
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    child.stdin.on('data', (part) => {
      input += part.toString()
    })
    child.stdin.on('finish', () => {
      child.stdout.write(JSON.stringify({ verdict: 'healthy', reason: 'OK' }))
      child.emit('close', 0)
    })
    return child
  }
  const inspect = async () => ({ State: { Running: true }, HostConfig: { NetworkMode: slotNetworkForVm(vm) } })
  const result = await runQualityStateProbe({ projectRoot, vm, model: 'gpt-test', inspect, spawnImpl })
  assert.equal(result.verdict, 'healthy')
  assert.deepEqual(args.slice(0, 2), ['exec', '-i'])
  assert.ok(args.includes('-u'))
  assert.ok(args.includes('kin-01'))
  assert.ok(args.includes('python3'))
  assert.ok(!args.join(' ').includes('secret-token'))
  assert.ok(!args.join(' ').includes('secret-account'))
  assert.equal(JSON.parse(input).access_token, 'secret-token')
  assert.equal(JSON.parse(input).account_id, 'secret-account')
  for (const container of [
    { State: { Running: false } },
    { State: { Running: true, Paused: true } },
    { State: { Running: true }, HostConfig: { NetworkMode: 'host' } },
  ]) {
    const rejected = await runQualityStateProbe({
      projectRoot,
      vm,
      model: 'gpt-test',
      inspect: async () => container,
      spawnImpl: () => {
        throw Error('must not run on host or mismatched exit')
      },
    })
    assert.equal(rejected.verdict, 'inconclusive')
  }
})
