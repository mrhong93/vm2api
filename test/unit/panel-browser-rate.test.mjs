import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelRateLimiter, createRateLimiter } from '../../src/lib/core/security.mjs'

const request = (method, suffix = '', vm = 'vm-92') => ({
  method,
  url: `/api/panel/vms/${vm}/oauth/login${suffix}`,
})

test('a long screen session leaves normal panel requests and cancellation usable', (t) => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const allow = createPanelRateLimiter({ allowDefault: createRateLimiter() })
  for (let second = 0; second < 600; second++) {
    now = second * 1000
    assert.equal(allow('admin', request('POST', '/control')), true)
    if (second % 2 === 0) assert.equal(allow('admin', request('GET')), true)
    if (second % 5 === 0) assert.equal(allow('admin', { method: 'GET', url: '/api/panel/vms' }), true)
  }
  assert.equal(allow('admin', request('POST', '/cancel')), true)
})

test('browser controls remain bounded per user across slots, with reserved cancellation', () => {
  const allow = createPanelRateLimiter({ allowDefault: createRateLimiter() })
  for (let i = 0; i < 60; i++) assert.equal(allow('admin', request('POST', '/control', `vm-${i}`)), true)
  assert.equal(allow('admin', request('POST', '/control')), false)
  assert.equal(allow('admin', request('GET')), false)
  assert.equal(allow('another-user', request('POST', '/control')), true)
  assert.equal(allow('admin', request('POST', '/cancel')), true)
  assert.equal(allow('admin', { method: 'GET', url: '/api/panel/vms' }), true)
  for (let i = 0; i < 9; i++) assert.equal(allow('admin', request('POST', '/cancel')), true)
  assert.equal(allow('admin', request('POST', '/cancel')), false)
})

test('login start, other methods and unrelated paths still use the default policy', () => {
  const keys = []
  const allow = createPanelRateLimiter({
    allowDefault: (key) => {
      keys.push(key)
      return false
    },
  })
  for (const req of [
    request('POST'),
    request('DELETE', '/control'),
    request('GET', '/control'),
    request('POST', '/remote'),
    request('POST', '/control/extra'),
    { method: 'GET', url: '/v1/models' },
  ]) {
    assert.equal(allow('admin', req), false)
  }
  assert.deepEqual(keys, Array(6).fill('panel:admin'))
  assert.equal(allow('admin', request('POST', '/control?ignored=true')), true)
})
