import { createFileRoute } from '@tanstack/react-router'
import { OperationsPage } from '@/features/operations'

export const Route = createFileRoute('/_authenticated/credentials')({
  validateSearch: (
    search: Record<string, unknown>
  ): { tab?: 'credentials' | 'quality' } => ({
    tab: search.tab === 'quality' ? 'quality' : 'credentials',
  }),
  component: OperationsPage,
})
