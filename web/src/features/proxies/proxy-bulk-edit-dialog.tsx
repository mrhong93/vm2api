import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  applyBulkDomainForward,
  type ProxyBulkEditResult,
} from './proxy-bulk-edit'
import type { ProxyEditResult } from './proxy-results'
import { proxyBoundIds, proxyLabel } from './proxy-sort'
import { useRefreshProxies } from './queries'

export function ProxyBulkEditDialog({
  proxies,
  onClose,
}: {
  /** Snapshot the explicit selection when opening, including across filters. */
  proxies: VmProxySnap[]
  onClose: () => void
}) {
  const refresh = useRefreshProxies()
  const [enabled, setEnabled] = useState(true)
  const [results, setResults] = useState<Map<string, ProxyBulkEditResult>>(
    new Map()
  )
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const changes = proxies.filter((p) => (p.domain_forward === true) !== enabled)
  const boundCount = new Set(changes.flatMap(proxyBoundIds)).size
  const failed = proxies.filter((p) => results.get(p.id!)?.status === 'error')
  const updated = [...results.values()].filter(
    (r) => r.status === 'updated'
  ).length
  const skipped = [...results.values()].filter(
    (r) => r.status === 'unchanged'
  ).length
  const started = results.size > 0

  const save = useMutation({
    mutationFn: (targets: VmProxySnap[]) => {
      setProgress({ done: 0, total: targets.length })
      return applyBulkDomainForward(
        targets,
        enabled,
        (id, patch) =>
          api<ProxyEditResult>(`/api/panel/proxies/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(patch),
          }),
        (result) => {
          setResults((previous) => new Map(previous).set(result.id, result))
          setProgress((previous) => ({ ...previous, done: previous.done + 1 }))
        }
      )
    },
    onSuccess: (round) => {
      const errors = round.filter((r) => r.status === 'error').length
      if (errors)
        toast.warning(`本轮处理完成，${errors} 条未成功，可查看原因并重试`)
      else toast.success('批量设置完成')
    },
    onSettled: () => refresh(),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent showCloseButton={!save.isPending}>
        <DialogHeader>
          <DialogTitle>批量编辑代理</DialogTitle>
          <DialogDescription>
            已选择 {proxies.length} 条代理，仅修改域名转发设置。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-3'>
          <Select
            value={enabled ? 'on' : 'off'}
            onValueChange={(value) => setEnabled(value === 'on')}
            disabled={save.isPending || started}
          >
            <SelectTrigger aria-label='域名转发批量设置' className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='on'>开启域名转发</SelectItem>
              <SelectItem value='off'>关闭域名转发</SelectItem>
            </SelectContent>
          </Select>
          <p className='text-xs text-muted-foreground'>
            将修改 {changes.length} 条，设置相同的{' '}
            {proxies.length - changes.length} 条自动跳过。
            逐条处理，失败后继续处理其余代理。
          </p>
          {boundCount > 0 ? (
            <p className='text-xs text-[color:var(--status-caution)]'>
              涉及 {boundCount}{' '}
              个槽位，应用时相应出口会短暂断开，正在进行的请求可能需要重试。
            </p>
          ) : null}
          <div className='max-h-64 overflow-y-auto rounded-md border'>
            <ul className='divide-y text-xs'>
              {proxies.map((proxy) => {
                const result = results.get(proxy.id!)
                return (
                  <li key={proxy.id} className='space-y-1 px-3 py-2'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='min-w-0 truncate'>
                        {proxyLabel(proxy)}
                      </span>
                      <span className='shrink-0 text-muted-foreground'>
                        域名转发：{proxy.domain_forward ? '开' : '关'} →{' '}
                        {enabled ? '开' : '关'}
                      </span>
                    </div>
                    {result ? (
                      <p
                        className={
                          result.status === 'error'
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                        }
                      >
                        {result.message}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
          <p
            role='status'
            aria-live='polite'
            className='text-xs text-muted-foreground'
          >
            {save.isPending
              ? `正在处理 ${progress.done}/${progress.total}，请保持页面打开。`
              : started
                ? `已应用 ${updated} 条，跳过 ${skipped} 条，未成功 ${failed.length} 条。`
                : '确认选择范围后再应用。'}
          </p>
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={save.isPending} onClick={onClose}>
            {started ? '完成' : '取消'}
          </Button>
          {!started || save.isPending ? (
            <Button
              loading={save.isPending}
              disabled={save.isPending || changes.length === 0}
              onClick={() => save.mutate(proxies)}
            >
              确认并应用
            </Button>
          ) : failed.length > 0 ? (
            <Button onClick={() => save.mutate(failed)}>
              重试未成功项（{failed.length}）
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
