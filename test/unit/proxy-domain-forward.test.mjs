import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { configuredDomainForward } from '../../src/lib/vm/egress.mjs'

test('egress uses the persisted pool preference for missing and stale slot flags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-domain-preference-'))
  let pool
  try {
    const db = openDatabase({ dbPath: ':memory:', dataDir: root })
    pool = new ProxyPool({ db })
    pool.stopScheduler()
    pool.importLines('socks5://fixture:fixture-password@192.0.2.20:1080')
    const id = pool.snapshot().proxies[0].id
    pool.update(id, { domain_forward: true })
    assert.equal(configuredDomainForward({ id }), true)
    assert.equal(configuredDomainForward({ id, domain_forward: false }), true)
    pool.update(id, { domain_forward: false })
    assert.equal(configuredDomainForward({ id, domain_forward: true }), false)
    assert.equal(configuredDomainForward({ id: 'unknown', domain_forward: true }), true)
    assert.equal(configuredDomainForward({ id: 'unknown' }), false)
  } finally {
    pool?.stopScheduler()
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('standalone egress keeps the supplied preference when no pool is open', () => {
  assert.equal(configuredDomainForward({ id: 'fixture', domain_forward: true }), true)
  assert.equal(configuredDomainForward({ id: 'fixture', domain_forward: false }), false)
  assert.equal(configuredDomainForward({ id: 'fixture' }), false)
})
