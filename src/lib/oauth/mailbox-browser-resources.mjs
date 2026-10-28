import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecContainer } from '../vm/slot-exec.mjs'
import { dockerJson } from '../cluster/docker-remote.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { mailboxError } from './codex-mailbox-store.mjs'

export const BROWSER_MEMORY_BYTES = 1536 * 1024 ** 2
const RESOURCE_KEYS = ['Memory', 'MemorySwap', 'NanoCpus', 'CpuPeriod', 'CpuQuota']

export function browserResourcePatch(config) {
  const patch = {}
  if (config.Memory > 0 && config.Memory < BROWSER_MEMORY_BYTES) {
    patch.Memory = BROWSER_MEMORY_BYTES
    if (config.MemorySwap >= 0 && config.MemorySwap < BROWSER_MEMORY_BYTES) patch.MemorySwap = BROWSER_MEMORY_BYTES
  }
  if (config.NanoCpus > 0) {
    if (config.NanoCpus > 1e9) patch.NanoCpus = 1e9
  } else {
    const period = config.CpuPeriod || 100_000
    if (!(config.CpuQuota > 0) || config.CpuQuota > period) {
      patch.CpuPeriod = period
      patch.CpuQuota = period
    }
  }
  return patch
}

/** A durable lease lets the next attempt repair limits after a panel interruption. */
export async function acquireBrowserResources({ projectRoot, vm, request = dockerJson }) {
  if (isKvmRuntime(vm)) return async () => {}
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(vm.id || '')) throw mailboxError('invalid_vm_id')
  const connect = slotHost(vm).dockerApi()
  const container = encodeURIComponent(slotExecContainer(vm))
  const prefix = '/containers/' + container
  const directory = path.join(projectRoot, 'data', 'browser-resource-leases')
  const file = path.join(directory, vm.id + '.json')
  const inspect = () => request(connect, { path: prefix + '/json' })
  const write = (value) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = file + '.' + crypto.randomUUID() + '.tmp'
    try {
      fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }
  const restore = async (lease) => {
    const current = await inspect()
    // A replacement container is a different resource owner.
    if (current.Id !== lease.container_id) {
      fs.rmSync(file, { force: true })
      return
    }
    const top = await request(connect, { path: prefix + '/top?ps_args=-eo%20pid,stat,comm' })
    if ((top.Processes || []).some((row) => !row[1]?.startsWith('Z') && /^(chrome|chromium|Xvfb)/.test(row[2] || ''))) {
      throw mailboxError('browser_resources_busy', 409)
    }
    const patch = {}
    const memoryEdited = ['Memory', 'MemorySwap'].some(
      (key) => key in lease.applied && (current.HostConfig[key] || 0) !== lease.applied[key],
    )
    const cpuEdited = ['NanoCpus', 'CpuPeriod', 'CpuQuota'].some(
      (key) => key in lease.applied && (current.HostConfig[key] || 0) !== lease.applied[key],
    )
    for (const key of Object.keys(lease.applied)) {
      // Preserve an operator's independent resource edits.
      if (memoryEdited && ['Memory', 'MemorySwap'].includes(key)) continue
      if (cpuEdited && ['NanoCpus', 'CpuPeriod', 'CpuQuota'].includes(key)) continue
      if ((current.HostConfig[key] || 0) === lease.applied[key]) {
        patch[key] = lease.original[key]
        // Docker treats zero in an update as "leave unchanged". Restore the
        // original unlimited CFS budget explicitly, using its default period.
        if (key === 'CpuQuota' && patch[key] === 0) patch[key] = -1
        if (key === 'CpuPeriod' && patch[key] === 0) patch[key] = 100_000
        if (key === 'MemorySwap' && patch[key] === 0) patch[key] = lease.original.Memory * 2
      }
    }
    if (Object.keys(patch).length) await request(connect, { method: 'POST', path: prefix + '/update', body: patch })
    fs.rmSync(file, { force: true })
  }
  if (fs.existsSync(file)) await restore(JSON.parse(fs.readFileSync(file, 'utf8')))
  const info = await inspect()
  if (!info.State?.Running || info.State?.Paused) throw mailboxError('slot_not_running', 409)
  const applied = browserResourcePatch(info.HostConfig)
  if (!Object.keys(applied).length) return async () => {}
  const lease = {
    container_id: info.Id,
    original: Object.fromEntries(RESOURCE_KEYS.map((key) => [key, info.HostConfig[key] || 0])),
    applied,
  }
  write(lease)
  try {
    await request(connect, { method: 'POST', path: prefix + '/update', body: applied })
  } catch (error) {
    // Retain the lease: an API timeout can occur after Docker applies the patch.
    throw Object.assign(mailboxError('browser_resources_failed', 502), { cause: error })
  }
  return async () => {
    // The supervisor has closed its entire browser process group before this.
    await restore(lease)
  }
}
