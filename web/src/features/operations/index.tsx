import { useNavigate, useSearch } from '@tanstack/react-router'
import { Activity, KeyRound, Workflow } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Main } from '@/components/layout/main'
import { CredentialsPage } from '@/features/credentials'
import { QualityWorkspace } from './quality-workspace'

export function OperationsPage() {
  const { tab } = useSearch({ from: '/_authenticated/credentials' })
  const navigate = useNavigate({ from: '/credentials' })
  return (
    <Main fluid className='min-w-0'>
      <div className='mb-5 flex items-center gap-3'>
        <div className='flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary'>
          <Workflow className='size-5' />
        </div>
        <div>
          <h1 className='text-xl font-semibold tracking-tight'>智能运维</h1>
          <p className='mt-0.5 text-xs text-muted-foreground'>
            账号凭据与质量检测，集中管理。
          </p>
        </div>
      </div>
      <Tabs
        value={tab || 'credentials'}
        onValueChange={(value) =>
          void navigate({
            search: { tab: value === 'quality' ? 'quality' : 'credentials' },
          })
        }
      >
        <div className='mb-3 flex flex-wrap items-center justify-between gap-3 border-b pb-4'>
          <TabsList className='h-10 p-1'>
            <TabsTrigger value='credentials' className='px-5'>
              <KeyRound />
              账号凭据
            </TabsTrigger>
            <TabsTrigger value='quality' className='px-5'>
              <Activity />
              质量运维
            </TabsTrigger>
          </TabsList>
          {tab === 'quality' && (
            <span className='rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-300'>
              配置可保存 · 记录为演示 · 不执行检测
            </span>
          )}
        </div>
        <TabsContent value='credentials'>
          <CredentialsPage />
        </TabsContent>
        <TabsContent value='quality'>
          <QualityWorkspace />
        </TabsContent>
      </Tabs>
    </Main>
  )
}
