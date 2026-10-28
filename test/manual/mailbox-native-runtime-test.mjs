/** Actual slot supervisor + native callback + Docker resource lease, offline only. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dockerJson, localDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { runMailboxSlotProcess } from '../../src/lib/oauth/codex-mailbox-runtime.mjs'
import { BROWSER_MEMORY_BYTES } from '../../src/lib/oauth/mailbox-browser-resources.mjs'

const [projectRoot, container] = process.argv.slice(2)
assert.equal(process.env.VM2API_NATIVE_OFFLINE_FIXTURE, '1', 'Explicit offline fixture opt-in is required')
assert.match(container || '', /^vm2api-native-fixture-[a-zA-Z0-9_.-]+$/)
assert.ok(path.isAbsolute(projectRoot))
const connect = localDocker()
const prefix = '/containers/' + encodeURIComponent(container)
const before = await dockerJson(connect, { path: prefix + '/json' })
assert.equal(before.HostConfig.NetworkMode, 'none', 'Never use an existing or networked slot')
assert.equal(before.HostConfig.ReadonlyRootfs, true)
const vm = { id: 'vm-05', runtime: { container }, locale: 'ja_JP.UTF-8', timezone: 'Asia/Tokyo' }
await runMailboxSlotProcess({ projectRoot, vm, action: 'prepare' })

let send, ready
const started = new Promise((resolve) => {
  ready = resolve
})
const pending = new Map()
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 70_000)
const task = runMailboxSlotProcess({
  projectRoot,
  vm,
  action: 'login',
  signal: controller.signal,
  payload: {
    native: true,
    email: 'fixture@example.invalid',
    state: 'native-runtime-fixture',
    auth_url: 'https://auth.openai.com/oauth/authorize?state=native-runtime-fixture',
  },
  onStage: (stage) => {
    if (stage === 'native_manual_login') ready()
  },
  onControl: (value) => {
    send = value
  },
  onEvent: (event) => {
    const request = pending.get(event.id)
    if (!request) return
    pending.delete(event.id)
    event.ok ? request.resolve(event.data) : request.reject(new Error(event.error_code))
  },
})
task.catch(() => {})
function control(op, data = {}) {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, op, ...data })
  })
}
try {
  await Promise.race([
    started,
    task.then(() => {
      throw new Error('Browser ended before readiness')
    }),
  ])
  const active = await dockerJson(connect, { path: prefix + '/json' })
  assert.ok(active.HostConfig.Memory >= BROWSER_MEMORY_BYTES)
  await delay(3000)
  await control('key', { key: 'Control+l' })
  await control('key', { key: 'Control+a' })
  await control('text', { text: 'http://localhost:1455/auth/callback?state=native-runtime-fixture&code=fictional' })
  await control('key', { key: 'Enter' })
  const result = await task
  assert.equal(result.native, true)
  assert.match(result.callback, /code=fictional/)
  assert.equal(result.resource_cleanup_error_code, undefined)
  const restored = await dockerJson(connect, { path: prefix + '/json' })
  assert.equal(restored.HostConfig.Memory, before.HostConfig.Memory)
  assert.equal(restored.HostConfig.MemorySwap, before.HostConfig.MemorySwap)
  assert.equal(restored.HostConfig.NanoCpus, before.HostConfig.NanoCpus)
  assert.ok(restored.HostConfig.CpuQuota <= 0)
  assert.equal(fs.existsSync(path.join(projectRoot, 'data/browser-resource-leases/vm-05.json')), false)
  const top = await dockerJson(connect, { path: prefix + '/top?ps_args=-eo%20pid,stat,comm' })
  assert.ok(
    !(top.Processes || []).some((row) => !row[1]?.startsWith('Z') && /^(chrome|chromium|Xvfb)/.test(row[2] || '')),
  )
  console.log(
    JSON.stringify({
      native_slot_supervisor_callback: 'passed',
      resource_restore: 'passed',
      live_browser_processes: 0,
      real_accounts_used: false,
      network: 'none',
    }),
  )
} finally {
  clearTimeout(timeout)
  controller.abort()
  await task.catch(() => {})
}
