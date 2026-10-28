import type { VmProxySnap } from '@/types/panel-vm'
import { describe, expect, it, vi } from 'vitest'
import {
  applyBulkDomainForward,
  editableDomainProxies,
} from './proxy-bulk-edit'

describe('bulk proxy domain forwarding', () => {
  it('excludes local and unidentified proxies and applies each selected ID only once', () => {
    const proxies: VmProxySnap[] = [
      { id: 'px-a' },
      { id: 'px-a' },
      { id: 'px-local' },
      { id: 'px-local-node' },
      { id: 'px-l', kind: 'local' },
      { host: 'example.test' },
      { id: 'px-b', enabled: false },
    ]
    expect(editableDomainProxies(proxies).map((p) => p.id)).toEqual([
      'px-a',
      'px-b',
    ])
  })

  it('sends only the domain flag, skips unchanged settings and reports progress', async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ workers: [], egress: { ok: true } })
    const progress = vi.fn()
    const results = await applyBulkDomainForward(
      [{ id: 'px-a' }, { id: 'px-b', domain_forward: true }],
      true,
      update,
      progress
    )
    expect(update.mock.calls).toEqual([['px-a', { domain_forward: true }]])
    expect(results.map((r) => r.status)).toEqual(['updated', 'unchanged'])
    expect(progress.mock.calls.map(([result]) => result.id)).toEqual([
      'px-a',
      'px-b',
    ])
  })

  it('waits for each exit before editing the next one', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const update = vi.fn(async (id: string) => {
      if (id === 'px-a') await pending
      return { egress: { ok: true } }
    })
    const running = applyBulkDomainForward(
      [{ id: 'px-a' }, { id: 'px-b' }],
      true,
      update
    )
    expect(update).toHaveBeenCalledTimes(1)
    release()
    await running
    expect(update.mock.calls.map(([id]) => id)).toEqual(['px-a', 'px-b'])
  })

  it('continues after a rejected request and after a saved setting whose exit failed', async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('proxy unavailable'))
      .mockResolvedValueOnce({
        egress: { ok: false, error: 'egress_port_busy' },
      })
      .mockResolvedValueOnce({ egress: { ok: true } })
    const results = await applyBulkDomainForward(
      [{ id: 'px-a' }, { id: 'px-b' }, { id: 'px-c' }],
      true,
      update
    )
    expect(results.map((r) => r.status)).toEqual(['error', 'error', 'updated'])
    expect(results[0].message).toBe('proxy unavailable')
    expect(results[1].message).toContain('已保存，但出口转发重启失败')
    expect(results[1].message).toContain('egress_port_busy')
  })

  it('can disable forwarding while leaving already disabled proxies untouched', async () => {
    const update = vi.fn().mockResolvedValue({ egress: null })
    const results = await applyBulkDomainForward(
      [{ id: 'px-a', domain_forward: true }, { id: 'px-b' }],
      false,
      update
    )
    expect(update.mock.calls).toEqual([['px-a', { domain_forward: false }]])
    expect(results.map((r) => r.status)).toEqual(['updated', 'unchanged'])
  })

  it('retries only failed selections using the original edit snapshot', async () => {
    const proxies = [{ id: 'px-a' }, { id: 'px-b' }]
    const update = vi
      .fn()
      .mockResolvedValueOnce({ egress: { ok: false, error: 'start_failed' } })
      .mockResolvedValueOnce({ egress: { ok: true } })
      .mockResolvedValueOnce({ egress: { ok: true } })
    const first = await applyBulkDomainForward(proxies, true, update)
    const retry = proxies.filter((p) =>
      first.some((r) => r.id === p.id && r.status === 'error')
    )
    const second = await applyBulkDomainForward(retry, true, update)
    expect(update.mock.calls.map(([id]) => id)).toEqual([
      'px-a',
      'px-b',
      'px-a',
    ])
    expect(second[0].status).toBe('updated')
  })
})
