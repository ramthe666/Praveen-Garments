import { Hourglass } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'

interface ModuleComingSoonProps {
  moduleName: string
  /** What the module will provide when it ships. */
  description: string
  plannedFor?: string
}

/**
 * Standard "Module coming in the next phase" state (per Phase 1 spec).
 * No fake data, no dead controls — just a clear, professional placeholder.
 */
export function ModuleComingSoon({
  moduleName,
  description,
  plannedFor = 'a later phase',
}: ModuleComingSoonProps) {
  return (
    <EmptyState
      icon={<Hourglass />}
      title={`${moduleName} is coming in ${plannedFor}`}
      description={description}
    />
  )
}
