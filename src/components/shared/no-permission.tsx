import { ShieldAlert } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'

/**
 * Rendered when an authenticated user reaches a module their role cannot
 * access. Nav items are already hidden, but URLs remain guessable — this is
 * the in-app backstop (RLS is the real enforcement at the data layer).
 */
export function NoPermission({ moduleName }: { moduleName: string }) {
  return (
    <EmptyState
      icon={<ShieldAlert />}
      title="Access restricted"
      description={`Your role does not have permission to open ${moduleName}. Contact your administrator if you believe this is a mistake.`}
    />
  )
}
