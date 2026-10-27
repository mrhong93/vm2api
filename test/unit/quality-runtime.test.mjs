import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QualityRunner, qualityRecordStore } from '../../src/lib/admin/quality-runtime.mjs'
import { qualityConfigStore } from '../../src/lib/admin/quality-config-store.mjs'
import { judgeCandy } from '../../src/lib/admin/quality-judge.mjs'
import { handleQualityConfig } from '../../src/lib/admin/quality-config-routes.mjs'

const task = {
  id: 'candy',
  name: 'quality',
  slot: 'vm-01',
  account: 'test@example.com',
  model: 'gpt-test',
  prompt: '  original question\n  ',
  kind: 'candy',
  judge: 'contains',
  interval: 1,
  enabled: true,
  action: 'pause',
  reasoningEffort: 'xhigh',
}
const response = (text = '21') => ({
  ok: true,
  complete: true,
  vm_id: 'vm-01',
  text: text.slice(0, 4000),
  stop_reason: 'completed',
  body: { status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] },
})
function fixture(t, overrides = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-runtime-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const vm = {
    id: 'vm-01',
    platform: 'openai',
    status: 'running',
    schedulable: true,
    owner_user_id: 'alice',
    proxy: { id: 'p1' },
    runtime: { container: 'kin-01' },
  }
  let now = Date.now(),
    actor = { role: 'user', enabled: true }
  const calls = [],
    paused = []
  const runner = new QualityRunner({
    projectRoot,
    now: () => now,
    list: () => [vm],
    models: () => [{ id: 'gpt-test' }],
    resolveOwner: () => actor,
    accountOf: () => task.account,
    runChat: async (id, opts) => {
      calls.push({ id, opts })
      return response()
    },
    pause: (id) => paused.push(id),
    ...overrides,
  })
  t.after(() => runner.stop())
  const config = qualityConfigStore(projectRoot, 'alice')
  config.save([task], 0)
  const drain = async () => {
    await Promise.all([...runner.running.values()].map((x) => x.promise))
  }
  return {
    runner,
    config,
    vm,
    calls,
    paused,
    drain,
    setActor: (v) => {
      actor = v
    },
    advance: (ms) => {
      now += ms
    },
  }
}
test('real candy request pins slot and effort, preserves original prompt and judges full answer beyond 4000', async (t) => {
  let opts
  const f = fixture(t, {
    runChat: async (id, params) => {
      assert.equal(id, task.slot)
      opts = params
      return response('x'.repeat(5000) + '\n答案 21')
    },
  })
  assert.equal(f.runner.run('alice', 'candy').result, 'running')
  await f.drain()
  const record = f.runner.records('alice')[0]
  assert.equal(record.result, 'passed')
  assert.ok(record.output.length > 5000)
  assert.equal(opts.prompt, task.prompt)
  assert.equal(opts.preservePrompt, true)
  assert.equal(opts.reasoning_effort, 'xhigh')
  assert.equal(new QualityRunner({ ...f.runner }).records('alice')[0].id, record.id)
  assert.deepEqual(f.paused, [])
})
test('HTTP 200, partial streams, wrong slot and empty answers never pass or pause', async (t) => {
  for (const result of [
    { ...response(), complete: false, stop_reason: null, body: { status: 'completed', output_text: '21' } },
    { ...response(), ok: false },
    response(''),
    { ...response(), debug: { hit_vm: 'vm-02' } },
  ]) {
    const f = fixture(t, { runChat: async () => result })
    f.runner.run('alice', 'candy')
    await f.drain()
    assert.equal(f.runner.records('alice')[0].result, 'error')
    assert.deepEqual(f.paused, [])
  }
})
test('only definite failed answer closes schedule, action failure preserves original evidence', async (t) => {
  const f = fixture(t, { runChat: async () => response('答案 29') })
  f.runner.run('alice', 'candy')
  await f.drain()
  assert.deepEqual(f.paused, ['vm-01'])
  assert.equal(f.runner.records('alice')[0].result, 'failed')
  const g = fixture(t, {
    runChat: async () => response('答案 29'),
    pause: () => {
      throw Error('private backend error')
    },
  })
  g.runner.run('alice', 'candy')
  await g.drain()
  const record = g.runner.records('alice')[0]
  assert.equal(record.result, 'failed')
  assert.equal(record.output, '答案 29')
  assert.match(record.action, /未关闭调度/)
})
test('changed task, binding, exit, revoked owner or deletion during request cannot pause a slot', async (t) => {
  for (const change of ['disabled', 'deleted', 'edited', 'proxy', 'owner', 'revoked']) {
    let finish
    const f = fixture(t, {
      runChat: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    f.runner.run('alice', 'candy')
    await Promise.resolve()
    if (change === 'disabled') f.config.save([{ ...task, enabled: false }], 1)
    if (change === 'deleted') f.config.save([], 1)
    if (change === 'edited') f.config.save([{ ...task, prompt: 'changed' }], 1)
    if (change === 'proxy') f.vm.proxy = { id: 'p2' }
    if (change === 'owner') f.vm.owner_user_id = 'bob'
    if (change === 'revoked') f.setActor({ role: 'user', enabled: false })
    finish(response('29'))
    await f.drain()
    assert.deepEqual(f.paused, [], change)
    assert.equal(qualityRecordStore(f.runner.projectRoot, 'alice').read()[0].output, '29')
  }
})
test('tenant ownership and current account are checked before any request', (t) => {
  const f = fixture(t)
  f.vm.owner_user_id = 'bob'
  assert.throws(() => f.runner.run('alice', 'candy'), { status: 404 })
  f.vm.owner_user_id = 'alice'
  f.runner.accountOf = () => 'replacement@example.com'
  assert.throws(() => f.runner.run('alice', 'candy'), /账号/)
  f.setActor(null)
  assert.throws(() => f.runner.run('alice', 'candy'), { status: 403 })
  assert.deepEqual(f.calls, [])
})
test('same account candy/probe are exclusive; inconclusive probe never pauses', async (t) => {
  let finish
  const f = fixture(t, {
    runChat: () =>
      new Promise((r) => {
        finish = r
      }),
    probe: async () => ({ verdict: 'inconclusive', reason: 'no ticket', failure: 'no_ticket' }),
  })
  f.config.save([task, { ...task, id: 'probe', kind: 'probe' }], 1)
  f.runner.run('alice', 'candy')
  await Promise.resolve()
  assert.throws(() => f.runner.run('alice', 'probe'), { status: 409 })
  finish(response())
  await f.drain()
  f.runner.run('alice', 'probe')
  await f.drain()
  assert.equal(f.runner.records('alice').find((r) => r.kind === 'probe').result, 'error')
  assert.deepEqual(f.paused, [])
})
test('minute scheduler persists history, disabled scheduling stays idle, manual disabled tasks never auto-pause', async (t) => {
  const f = fixture(t)
  f.runner.tick()
  assert.equal(f.calls.length, 0)
  f.advance(60001)
  f.runner.tick()
  await f.drain()
  assert.equal(f.calls.length, 1)
  f.runner.tick()
  await f.drain()
  assert.equal(f.calls.length, 1)
  f.vm.schedulable = false
  f.advance(60001)
  f.runner.tick()
  await f.drain()
  assert.equal(f.calls.length, 1)
  assert.equal(f.runner.records('alice')[0].result, 'skipped')
  f.config.save([{ ...task, enabled: false }], 1)
  f.runner.runChat = async () => response('29')
  f.runner.run('alice', 'candy')
  await f.drain()
  assert.deepEqual(f.paused, [])
  assert.equal(f.runner.records('alice')[0].result, 'failed')
})
test('manual execution postpones next scheduled run and stale targets get persistent errors', async (t) => {
  const f = fixture(t)
  f.runner.tick()
  f.advance(30000)
  f.runner.run('alice', 'candy')
  await f.drain()
  f.advance(30001)
  f.runner.tick()
  await f.drain()
  assert.equal(f.calls.length, 1)
  f.vm.owner_user_id = 'bob'
  f.advance(30000)
  f.runner.tick()
  await f.drain()
  assert.equal(f.calls.length, 1)
  assert.equal(f.runner.records('alice')[0].result, 'error')
})
test('restart marks running records interrupted; stopped runner never applies late result', async (t) => {
  let finish
  const f = fixture(t, {
    runChat: () =>
      new Promise((r) => {
        finish = r
      }),
  })
  f.runner.run('alice', 'candy')
  await Promise.resolve()
  f.runner.stop()
  finish(response('29'))
  await f.drain()
  assert.deepEqual(f.paused, [])
  f.runner.start()
  assert.equal(f.runner.records('alice')[0].result, 'error')
  f.runner.stop()
})
test('numeric judging accepts 21 tokens but rejects 121, decimals and negative values', () => {
  for (const text of ['21', '答案 **21**', '完整解释\n21颗']) assert.equal(judgeCandy(text, 'contains'), true)
  for (const text of ['121', '210', '21.5', '-21', '1.21']) assert.equal(judgeCandy(text, 'contains'), false)
})
test('run endpoint returns accepted real record and rejects stale revision or cross-owner records', async (t) => {
  const f = fixture(t)
  let result, status
  const context = {
    projectRoot: f.runner.projectRoot,
    runner: f.runner,
    readBody: async () => ({ revision: 1 }),
    json: (_, s, value) => {
      status = s
      result = value
    },
    ok: (data) => ({ ok: true, data }),
  }
  const req = { method: 'POST', panelRole: 'user', panelUserId: 'alice' },
    res = { setHeader() {} }
  await handleQualityConfig(req, res, '/api/panel/quality-preview/candy/run', context)
  assert.equal(status, 202)
  assert.equal(result.data.record.result, 'running')
  await f.drain()
  await handleQualityConfig(req, res, '/api/panel/quality-preview/candy/run', {
    ...context,
    readBody: async () => ({ revision: 0 }),
  })
  assert.equal(status, 409)
  await handleQualityConfig(
    { ...req, method: 'GET', panelUserId: 'bob' },
    res,
    '/api/panel/quality-preview/records',
    context,
  )
  assert.equal(status, 200)
  assert.deepEqual(result.data.items, [])
})
