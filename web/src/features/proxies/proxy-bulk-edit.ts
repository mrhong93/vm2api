import type { VmProxySnap } from '@/types/panel-vm'
import { type ProxyEditResult, editOutcome } from './proxy-results'
import { proxyIsLocal } from './proxy-sort'

export type ProxyBulkEditResult = {
  id: string
  status: 'updated' | 'unchanged' | 'error'
  message: string
}

export function editableDomainProxies(proxies: VmProxySnap[]): VmProxySnap[] {
  const seen = new Set<string>()
  return proxies.filter((proxy) => {
    if (!proxy.id || proxyIsLocal(proxy) || seen.has(proxy.id)) return false
    seen.add(proxy.id)
    return true
  })
}

/** Apply one exit at a time; a failed exit must not prevent the remaining edits. */
export async function applyBulkDomainForward(
  proxies: VmProxySnap[],
  enabled: boolean,
  update: (
    id: string,
    patch: { domain_forward: boolean }
  ) => Promise<ProxyEditResult>,
  onResult: (result: ProxyBulkEditResult) => void = () => {}
): Promise<ProxyBulkEditResult[]> {
  const results: ProxyBulkEditResult[] = []
  for (const proxy of editableDomainProxies(proxies)) {
    const id = proxy.id!
    let result: ProxyBulkEditResult
    if ((proxy.domain_forward === true) === enabled) {
      result = { id, status: 'unchanged', message: '设置相同，已跳过' }
    } else {
      try {
        const outcome = editOutcome(
          await update(id, { domain_forward: enabled })
        )
        result = {
          id,
          status: outcome.level === 'success' ? 'updated' : 'error',
          message: outcome.text,
        }
      } catch (error) {
        result = {
          id,
          status: 'error',
          message: error instanceof Error ? error.message : '请求失败',
        }
      }
    }
    results.push(result)
    onResult(result)
  }
  return results
}
