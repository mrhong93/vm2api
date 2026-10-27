import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  BackupItem,
  BackupSchedule,
  BackupStorage,
  RemoteBackup,
  RemoteBackupsPayload,
} from '@/types/panel-routing'
import { toast } from 'sonner'
import { ApiError, api, panelFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  backupConfigQueryOptions,
  backupsQueryOptions,
  backupStorageQueryOptions,
} from '@/features/settings/queries'

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm'
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—'
const size = (bytes = 0) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(2)} MB`
const kind = (value?: string) =>
  value === 'pre_restore'
    ? '恢复前快照'
    : value === 'scheduled'
      ? '定时'
      : '手动'

function ScheduleForm({
  saved,
  next,
  busy,
  refresh,
}: {
  saved: BackupSchedule
  next?: string | null
  busy: boolean
  refresh: () => Promise<void>
}) {
  const [value, setValue] = useState(saved)
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/backups/config', {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    onSuccess: async () => {
      toast.success('备份计划已保存')
      await refresh()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>自动备份</CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='flex items-center justify-between'>
          <Label htmlFor='backup-enabled'>启用定时备份</Label>
          <Switch
            id='backup-enabled'
            checked={value.enabled}
            onCheckedChange={(enabled) => setValue({ ...value, enabled })}
          />
        </div>
        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-2'>
            <Label htmlFor='backup-interval'>间隔（小时）</Label>
            <Input
              id='backup-interval'
              type='number'
              min={1}
              max={720}
              value={value.interval_hours}
              onChange={(e) =>
                setValue({ ...value, interval_hours: Number(e.target.value) })
              }
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='backup-retention'>保留最近几份</Label>
            <Input
              id='backup-retention'
              type='number'
              min={1}
              max={100}
              value={value.retention}
              onChange={(e) =>
                setValue({ ...value, retention: Number(e.target.value) })
              }
            />
          </div>
        </div>
        <p className='text-xs text-muted-foreground'>
          下次备份：{date(next)}
          。本地模式保留指定份数；启用存储桶后，份数用于远端保留，本地按下方时间清理，远端超额清理时也会移除对应本地副本。恢复前快照额外保留最近
          3 份。
        </p>
        <Button
          variant='outline'
          onClick={() => save.mutate()}
          disabled={busy || save.isPending}
          loading={save.isPending}
        >
          保存计划
        </Button>
      </CardContent>
    </Card>
  )
}

function StorageForm({
  saved,
  busy,
  refresh,
}: {
  saved: BackupStorage
  busy: boolean
  refresh: () => Promise<void>
}) {
  const [value, setValue] = useState({
    ...saved,
    access_key: '',
    secret_key: '',
    encryption_password: '',
  })
  const change = (
    key:
      | 'endpoint'
      | 'region'
      | 'bucket'
      | 'prefix'
      | 'access_key'
      | 'secret_key'
      | 'encryption_password',
    v: string
  ) => setValue({ ...value, [key]: v })
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/backups/storage', {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    onSuccess: async () => {
      toast.success('存储桶配置已保存')
      await refresh()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const test = useMutation({
    mutationFn: () =>
      api('/api/panel/backups/storage/test', {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    onSuccess: () => toast.success('存储桶写入、读取、列举及删除测试通过'),
    onError: (e: Error) => toast.error(e.message),
  })
  const locked = busy || save.isPending || test.isPending
  return (
    <Card>
      <CardHeader>
        <CardTitle>存储桶</CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='flex items-center justify-between'>
          <Label htmlFor='storage-enabled'>上传备份到存储桶</Label>
          <Switch
            id='storage-enabled'
            checked={value.enabled}
            onCheckedChange={(enabled) => setValue({ ...value, enabled })}
          />
        </div>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='storage-provider'>服务商</Label>
            <select
              id='storage-provider'
              className={selectClass}
              value={value.provider}
              onChange={(e) =>
                setValue({
                  ...value,
                  provider: e.target.value as BackupStorage['provider'],
                  force_path_style: false,
                })
              }
            >
              <option value='cos'>腾讯云 COS</option>
              <option value='oss'>阿里云 OSS</option>
              <option value='s3'>S3 兼容存储</option>
            </select>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='storage-local-retention'>
              上传成功后保留本地副本
            </Label>
            <select
              id='storage-local-retention'
              className={selectClass}
              value={value.local_retention_hours}
              onChange={(e) =>
                setValue({
                  ...value,
                  local_retention_hours: Number(e.target.value) as 0 | 24,
                })
              }
            >
              <option value={0}>不保留，校验成功后立即清理</option>
              <option value={24}>最多保留 24 小时</option>
            </select>
          </div>
          <div className='space-y-2 sm:col-span-2'>
            <Label htmlFor='storage-endpoint'>Endpoint</Label>
            <Input
              id='storage-endpoint'
              value={value.endpoint}
              onChange={(e) => change('endpoint', e.target.value)}
              placeholder={
                value.provider === 'cos'
                  ? 'https://cos.ap-guangzhou.myqcloud.com'
                  : value.provider === 'oss'
                    ? 'https://s3.oss-cn-hangzhou.aliyuncs.com'
                    : 'https://s3.example.com'
              }
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='storage-region'>地域</Label>
            <Input
              id='storage-region'
              value={value.region}
              onChange={(e) => change('region', e.target.value)}
              placeholder={
                value.provider === 'cos' ? 'ap-guangzhou' : 'cn-hangzhou'
              }
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='storage-bucket'>桶名</Label>
            <Input
              id='storage-bucket'
              value={value.bucket}
              onChange={(e) => change('bucket', e.target.value)}
              placeholder={
                value.provider === 'cos' ? 'backup-1250000000' : 'vm2api-backup'
              }
            />
          </div>
          <div className='space-y-2 sm:col-span-2'>
            <Label htmlFor='storage-prefix'>本实例专用目录</Label>
            <Input
              id='storage-prefix'
              value={value.prefix}
              onChange={(e) => change('prefix', e.target.value)}
              placeholder='vm2api/'
            />
          </div>
          {(['access_key', 'secret_key', 'encryption_password'] as const).map(
            (key) => (
              <div
                key={key}
                className={
                  key === 'encryption_password'
                    ? 'space-y-2 sm:col-span-2'
                    : 'space-y-2'
                }
              >
                <Label htmlFor={`storage-${key}`}>
                  {key === 'access_key'
                    ? 'Access Key / SecretId'
                    : key === 'secret_key'
                      ? 'Secret Key'
                      : '备份加密密码（至少 12 位）'}
                </Label>
                <Input
                  id={`storage-${key}`}
                  type='password'
                  autoComplete='new-password'
                  value={value[key]}
                  onChange={(e) => change(key, e.target.value)}
                  placeholder={
                    saved[`has_${key}`] ? '已保存，留空沿用' : '尚未设置'
                  }
                />
              </div>
            )
          )}
        </div>
        {value.provider === 's3' && (
          <div className='flex items-center gap-3'>
            <Switch
              id='storage-path-style'
              checked={value.force_path_style}
              onCheckedChange={(force_path_style) =>
                setValue({ ...value, force_path_style })
              }
            />
            <Label htmlFor='storage-path-style'>
              路径寻址（按存储服务要求开启）
            </Label>
          </div>
        )}
        <p className='text-xs text-muted-foreground'>
          备份先在本地生成并加密，上传和远端校验成功后才清理本地文件。上传失败保留本地副本并自动重试。备份加密密码请异地单独保存，换机恢复时仍需填写。
        </p>
        <p className='text-xs text-muted-foreground'>
          请使用本实例专用目录和对应读写、列举、删除权限；按份数清理会删除该目录内较旧的
          vm2api 备份。
        </p>
        <div className='flex gap-2'>
          <Button
            variant='outline'
            onClick={() => test.mutate()}
            disabled={locked}
            loading={test.isPending}
          >
            测试连接
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={locked}
            loading={save.isPending}
          >
            保存存储配置
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

type RestoreTarget = { id: string; file_name?: string; index_key?: string }

export function BackupPane() {
  const qc = useQueryClient()
  const list = useQuery(backupsQueryOptions())
  const cfg = useQuery(backupConfigQueryOptions())
  const storage = useQuery(backupStorageQueryOptions())
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null)
  const [removeTarget, setRemoveTarget] = useState<BackupItem | null>(null)
  const [password, setPassword] = useState('')
  const [remote, setRemote] = useState<RemoteBackupsPayload | null>(null)
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['panel', 'backups'] })
    await qc.invalidateQueries({ queryKey: ['panel', 'backups-config'] })
  }
  const refreshStorage = async () => {
    setRemote(null)
    await qc.invalidateQueries({ queryKey: ['panel', 'backups-storage'] })
  }
  const create = useMutation({
    mutationFn: () =>
      api<{ item: BackupItem }>('/api/panel/backups', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async ({ item }) => {
      if (item.upload_status === 'failed')
        toast.warning('本地备份已创建，上传失败；已保留文件等待重试')
      else
        toast.success(
          item.upload_status === 'uploaded'
            ? '备份已上传并校验'
            : '本地备份已创建'
        )
      setRemote(null)
      await refresh()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const upload = useMutation({
    mutationFn: (id: string) =>
      api<{ item: BackupItem }>(
        `/api/panel/backups/${encodeURIComponent(id)}/upload`,
        { method: 'POST', body: '{}' }
      ),
    onSuccess: async ({ item }) => {
      if (item.upload_status === 'failed')
        toast.error(item.upload_error || '上传失败，本地副本已保留')
      else toast.success('备份已上传并校验')
      setRemote(null)
      await refresh()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已清理本地备份')
      setRemoveTarget(null)
      await refresh()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const restore = useMutation({
    mutationFn: (target: RestoreTarget) =>
      api(
        target.index_key
          ? '/api/panel/backups/remote/restore'
          : `/api/panel/backups/${encodeURIComponent(target.id)}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({
            confirm: true,
            index_key: target.index_key,
            password: password || undefined,
          }),
        }
      ),
    onSuccess: async () => {
      toast.success('备份已恢复，请检查槽位和代理配置后再开机')
      setRestoreTarget(null)
      setPassword('')
      setRemote(null)
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const scan = useMutation({
    mutationFn: (cursor?: string | null) =>
      api<RemoteBackupsPayload>(
        `/api/panel/backups/remote${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
      ),
    onSuccess: (page, cursor) =>
      setRemote((old) => ({
        ...page,
        items: [...(cursor ? old?.items || [] : []), ...page.items].sort(
          (a, b) => b.created_at.localeCompare(a.created_at)
        ),
        errors: [...(cursor ? old?.errors || [] : []), ...page.errors],
      })),
    onError: (e: Error) => toast.error(e.message),
  })
  const busy =
    !!list.data?.busy ||
    create.isPending ||
    upload.isPending ||
    restore.isPending ||
    remove.isPending
  const items = list.data?.items || []
  const openRestore = (target: RestoreTarget) => {
    setPassword('')
    setRestoreTarget(target)
  }

  async function download(item: BackupItem) {
    const res = await panelFetch(
      `/api/panel/backups/${encodeURIComponent(item.id)}/download`
    )
    if (!res.ok) throw new ApiError('下载失败', res.status)
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = item.file_name || `backup-${item.id}.tar.gz`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className='space-y-6'>
      <Card>
        <CardHeader className='flex flex-row items-center justify-between gap-3'>
          <CardTitle>备份与恢复</CardTitle>
          <Button
            onClick={() => create.mutate()}
            disabled={busy}
            loading={create.isPending}
          >
            立即备份
          </Button>
        </CardHeader>
        <CardContent className='space-y-2 text-sm text-muted-foreground'>
          <p>
            包含数据库、账号池与槽位凭据、绑定关系、注册记录、浏览器会话、质量运维配置及记录、代理和路由配置。
          </p>
          <p>
            保存本机可访问的持久资料；集群节点未挂载的数据和虚拟机磁盘需另行备份。浏览器运行包可重新安装，缓存和日志不打包。浏览器会话跨机器后可能需要重新授权。
          </p>
          <p>
            恢复前请关闭所有槽位并结束浏览器任务，恢复期间暂停请求。部署配置作为参考文件恢复，检查目标机器路径后再应用。本地未加密备份含敏感凭据，请妥善保管。
          </p>
          {busy && (
            <p role='status' className='text-primary'>
              备份或恢复正在执行，请等待完成。
            </p>
          )}
        </CardContent>
      </Card>
      {(cfg.isError || storage.isError || list.isError) && (
        <p role='alert' className='text-sm text-destructive'>
          {cfg.error?.message || storage.error?.message || list.error?.message}
        </p>
      )}
      <div className='grid items-start gap-6 xl:grid-cols-2'>
        {cfg.data && (
          <ScheduleForm
            key={JSON.stringify(cfg.data.config)}
            saved={cfg.data.config}
            next={cfg.data.next_auto_at}
            busy={busy}
            refresh={refresh}
          />
        )}
        {storage.data && (
          <StorageForm
            key={JSON.stringify(storage.data.storage)}
            saved={storage.data.storage}
            busy={busy}
            refresh={refreshStorage}
          />
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>本机备份记录</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>备份</TableHead>
                <TableHead>时间 / 大小</TableHead>
                <TableHead>保存状态</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <div className='font-mono text-xs'>{b.id}</div>
                    <div className='text-xs text-muted-foreground'>
                      {kind(b.kind)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{date(b.created_at)}</div>
                    <div className='text-xs text-muted-foreground'>
                      {size(b.size_bytes)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>
                      {b.status === 'failed'
                        ? '备份失败'
                        : b.upload_status === 'uploaded'
                          ? '已上传存储桶'
                          : b.upload_status === 'failed'
                            ? '上传失败，等待重试'
                            : b.upload_status === 'pending' ||
                                b.upload_status === 'uploading'
                              ? '等待上传 / 上传中'
                              : '仅本地'}
                    </div>
                    <div className='text-xs text-muted-foreground'>
                      {b.file_exists
                        ? b.local_expires_at
                          ? `本地清理：${date(b.local_expires_at)}`
                          : '本地副本可用'
                        : b.remote?.index_key
                          ? '本地副本已清理，可从存储桶恢复'
                          : '无本地文件'}
                    </div>
                    {(b.upload_error || b.error) && (
                      <div className='max-w-sm text-xs text-destructive'>
                        {b.upload_error || b.error}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className='flex flex-wrap gap-2'>
                      {b.file_exists && (
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy}
                          onClick={() =>
                            download(b).catch((e: Error) =>
                              toast.error(e.message)
                            )
                          }
                        >
                          下载
                        </Button>
                      )}
                      {b.status === 'ok' &&
                        b.file_exists &&
                        storage.data?.storage.enabled &&
                        b.upload_status !== 'uploaded' && (
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={busy}
                            onClick={() => upload.mutate(b.id)}
                          >
                            上传 / 重试
                          </Button>
                        )}
                      {b.status === 'ok' &&
                        (b.file_exists || b.remote?.index_key) && (
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={busy}
                            onClick={() =>
                              openRestore({ id: b.id, file_name: b.file_name })
                            }
                          >
                            恢复
                          </Button>
                        )}
                      {(b.file_exists || b.status === 'failed') && (
                        <Button
                          size='sm'
                          variant='ghost'
                          disabled={busy}
                          onClick={() => setRemoveTarget(b)}
                        >
                          清理本地
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!items.length && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className='py-8 text-center text-muted-foreground'
                  >
                    {list.isPending ? '加载中…' : '尚无备份记录'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className='flex flex-row items-center justify-between gap-3'>
          <CardTitle>从存储桶恢复</CardTitle>
          <Button
            variant='outline'
            disabled={busy || scan.isPending || !storage.data?.storage.enabled}
            loading={scan.isPending}
            onClick={() => scan.mutate(undefined)}
          >
            扫描存储桶
          </Button>
        </CardHeader>
        <CardContent className='space-y-4'>
          <p className='text-sm text-muted-foreground'>
            新机器填写原存储桶、目录和加密密码后即可扫描，无需本机历史记录。选择备份后会下载、校验并恢复，恢复前自动创建当前状态的快照。
          </p>
          {remote && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>远端备份</TableHead>
                    <TableHead>时间 / 大小</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {remote.items.map((b: RemoteBackup) => (
                    <TableRow key={b.index_key}>
                      <TableCell>
                        <div className='font-mono text-xs'>{b.id}</div>
                        <div className='text-xs text-muted-foreground'>
                          {kind(b.kind)} · 已加密
                        </div>
                      </TableCell>
                      <TableCell>
                        {date(b.created_at)}
                        <div className='text-xs text-muted-foreground'>
                          {size(b.size_bytes)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy}
                          onClick={() => openRestore(b)}
                        >
                          下载并恢复
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!remote.items.length && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className='py-8 text-center text-muted-foreground'
                      >
                        此目录暂无可恢复备份
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              {remote.errors.length > 0 && (
                <p role='alert' className='text-sm text-destructive'>
                  已跳过 {remote.errors.length}{' '}
                  条无法读取、文件缺失或校验不一致的备份索引。
                </p>
              )}
              {remote.next_cursor && (
                <Button
                  variant='outline'
                  disabled={scan.isPending || busy}
                  onClick={() => scan.mutate(remote.next_cursor)}
                >
                  加载更多
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={!!restoreTarget}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) setRestoreTarget(null)
        }}
        title='确认恢复备份'
        desc={`将使用 ${restoreTarget?.id || ''} 覆盖当前数据库与持久资料。请先关闭所有槽位和浏览器任务；恢复完成后检查配置并手动开机。`}
        confirmText={restore.isPending ? '正在恢复…' : '确认恢复'}
        cancelBtnText='取消'
        destructive
        isLoading={restore.isPending}
        disabled={busy && !restore.isPending}
        handleConfirm={() => {
          if (restoreTarget) restore.mutate(restoreTarget)
        }}
      >
        <div className='space-y-2'>
          <Label htmlFor='restore-password'>此备份的加密密码</Label>
          <Input
            id='restore-password'
            type='password'
            autoComplete='new-password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder='留空使用已保存的密码；未加密备份无需填写'
          />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoveTarget(null)
        }}
        title='清理本地备份'
        desc={
          removeTarget?.remote?.index_key
            ? '仅删除本地副本，存储桶中的备份会继续保留。'
            : '此备份没有已确认的远端副本，清理后将无法使用它恢复。'
        }
        confirmText='确认清理'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget.id)
        }}
      />
    </div>
  )
}
