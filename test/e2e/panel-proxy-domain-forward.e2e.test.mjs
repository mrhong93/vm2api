import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('proxy bind and domain-only edits preserve the preference without changing credentials or scheduling', async () => {
  const gw = await startGateway()
  try {
    const imported = await api(gw, 'POST', '/api/panel/proxies/import', {
      body: { text: 'socks5://fixture:fixture-password@192.0.2.20:1080' },
    })
    assert.equal(imported.status, 200, imported.text)
    const id = (imported.json.data || imported.json).items[0].id
    const enabled = await api(gw, 'PUT', `/api/panel/proxies/${id}`, { body: { domain_forward: true } })
    assert.equal(enabled.status, 200, enabled.text)
    const bound = await api(gw, 'POST', `/api/panel/proxies/${id}/bind`, { body: { vm_id: 'vm-sim-01' } })
    assert.equal(bound.status, 200, bound.text)
    const file = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const original = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(original.proxy.domain_forward, true)
    // Simulate an older snapshot, then reapply the already-enabled pool flag.
    delete original.proxy.domain_forward
    original.schedule_off = true
    original.schedule_manual = true
    original.schedulable = false
    fs.writeFileSync(file, JSON.stringify(original))
    for (const value of [true, false, true]) {
      const changed = await api(gw, 'PUT', `/api/panel/proxies/${id}`, { body: { domain_forward: value } })
      assert.equal(changed.status, 200, changed.text)
      assert.deepEqual((changed.json.data || changed.json).workers, [])
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(saved.proxy.domain_forward, value)
      for (const key of ['id', 'host', 'port', 'url', 'username', 'password']) {
        assert.equal(saved.proxy[key], original.proxy[key], key)
      }
      assert.equal(saved.schedulable, false)
      assert.equal(saved.schedule_off, true)
    }
  } finally {
    await gw.stop()
  }
})
