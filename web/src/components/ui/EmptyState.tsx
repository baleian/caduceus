import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function EmptyState(props: {
  icon: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  testId?: string
}): ReactNode {
  const Icon = props.icon
  return (
    <div
      data-testid={props.testId}
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge-strong px-6 py-14 text-center"
    >
      <span className="rounded-xl bg-panel-2 p-3 text-ink-faint">
        <Icon size={22} strokeWidth={1.75} aria-hidden />
      </span>
      <p className="mt-1 text-sm font-medium text-ink">{props.title}</p>
      {props.description && <p className="max-w-sm text-xs text-ink-dim">{props.description}</p>}
      {props.action && <div className="mt-2">{props.action}</div>}
    </div>
  )
}
