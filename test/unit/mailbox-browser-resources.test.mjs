import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acquireBrowserResources,
  browserResourcePatch,
  BROWSER_MEMORY_BYTES,
} from '../../src/lib/oauth/mailbox-browser-resources.mjs'

function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-resources-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const config = { Memory: 1024 ** 3, MemorySwap: 1024 ** 3, NanoCpus: 0, CpuPeriod: 0, CpuQuota: 0 }
  const calls = []
  let runningBrowser = false
  const request = async (_connect, { path: target, body }) => {
    calls.push({ target, body })
    if (target.endsWith('/json'))
      return { Id: 'fixture-container', State: { Running: true }, HostConfig: { ...config } }
    if (target.includes('/top?'))
      return {
        Processes: runningBrowser
          ? [['123', 'Sl', 'chrome']]
          : [
              ['120', 'S', 'worker'],
              ['121', 'Z', 'chrome'],
            ],
      }
    if (target.endsWith('/update')) Object.assign(config, body)
    return {}
  }
  return {
    projectRoot,
    config,
    calls,
    request,
    vm: { id: 'vm-01' },
    setBrowser: (value) => {
      runningBrowser = value
    },
    lease: path.join(projectRoot, 'data/browser-resource-leases/vm-01.json'),
  }
}

test('temporary limits restore memory, swap and CPU after the browser exits', async (t) => {
  const h = fixture(t)
  const original = { ...h.config }
  const release = await acquireBrowserResources(h)
  assert.equal(h.config.Memory, BROWSER_MEMORY_BYTES)
  assert.equal(h.config.MemorySwap, BROWSER_MEMORY_BYTES)
  assert.equal(h.config.CpuQuota / h.config.CpuPeriod, 1)
  assert.ok(fs.existsSync(h.lease))
  await release()
  assert.deepEqual(h.config, { ...original, CpuPeriod: 100000, CpuQuota: -1 })
  assert.equal(fs.existsSync(h.lease), false)
})

test('interrupted limits are recovered on the next attempt without touching a live browser', async (t) => {
  const h = fixture(t)
  const original = { ...h.config }
  await acquireBrowserResources(h)
  h.setBrowser(true)
  await assert.rejects(acquireBrowserResources(h), { code: 'browser_resources_busy' })
  assert.equal(h.config.Memory, BROWSER_MEMORY_BYTES)
  h.setBrowser(false)
  const release = await acquireBrowserResources(h)
  await release()
  assert.deepEqual(h.config, { ...original, CpuPeriod: 100000, CpuQuota: -1 })
})

test('cleanup preserves independent operator edits to the memory pair', async (t) => {
  const h = fixture(t)
  const release = await acquireBrowserResources(h)
  h.config.Memory = 2 * 1024 ** 3
  h.config.MemorySwap = 3 * 1024 ** 3
  await release()
  assert.equal(h.config.Memory, 2 * 1024 ** 3)
  assert.equal(h.config.MemorySwap, 3 * 1024 ** 3)
  assert.equal(h.config.NanoCpus, 0)
})

test('larger memory and stricter CPU limits are retained; unlimited memory remains unlimited', () => {
  assert.deepEqual(browserResourcePatch({ Memory: 2 * 1024 ** 3, MemorySwap: -1, NanoCpus: 5e8 }), {})
  assert.deepEqual(browserResourcePatch({ Memory: 0, MemorySwap: -1, NanoCpus: 0 }), {
    CpuPeriod: 100000,
    CpuQuota: 100000,
  })
  assert.deepEqual(browserResourcePatch({ Memory: 2 * 1024 ** 3, CpuPeriod: 100000, CpuQuota: 200000 }), {
    CpuPeriod: 100000,
    CpuQuota: 100000,
  })
})
