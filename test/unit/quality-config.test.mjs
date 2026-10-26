import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { qualityConfigStore, validateQualityTasks } from '../../src/lib/admin/quality-config-store.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const task = {
  id: 'task-a',
  name: '任务',
  account: 'test@example.com',
  slot: 'vm-92',
  model: 'test-model',
  prompt: '自定义题目\n保留原样  ',
  kind: 'candy',
  judge: 'contains',
  interval: 17,
  enabled: false,
  action: 'record',
}
test('quality configs survive store recreation, preserve question text, and isolate owners', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-config-'))
  try {
    const a = qualityConfigStore(root, 'alice')
    assert.deepEqual(a.read(), { revision: 0, tasks: [] })
    a.save([task], 0)
    assert.deepEqual(qualityConfigStore(root, 'alice').read().tasks, [task])
    assert.deepEqual(qualityConfigStore(root, 'bob').read().tasks, [])
    assert.throws(() => a.save([], 0), { status: 409 })
    assert.equal(a.read().tasks.length, 1)
    a.save([], 1)
    assert.deepEqual(qualityConfigStore(root, 'alice').read().tasks, [])
    assert.equal(fs.readdirSync(path.join(root, 'data', 'quality-preview')).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('quality settings reject invalid intervals and malformed tasks', () => {
  for (const interval of [0, -1, 1.5, '30', NaN, Infinity, 525601])
    assert.throws(() => validateQualityTasks([{ ...task, interval }]), { status: 400 })
  for (const patch of [
    { prompt: '  ' },
    { prompt: 'x'.repeat(10001) },
    { enabled: 'true' },
    { kind: 'execute' },
    { action: 'delete' },
  ])
    assert.throws(() => validateQualityTasks([{ ...task, ...patch }]))
  assert.throws(() => validateQualityTasks([task, task]))
  assert.deepEqual(validateQualityTasks([{ ...task, password: 'must not persist' }]), [task])
  assert.throws(() => qualityConfigStore('.', ''), { status: 403 })
})
test('quality route ACL permits only configuration methods for tenant role', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/quality-preview', 'user').ok, true)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/quality-preview', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/quality-preview', 'user').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/quality-preview', 'super').ok, false)
})
