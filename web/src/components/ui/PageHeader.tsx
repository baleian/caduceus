import { clsx } from 'clsx'
import type { ReactNode } from 'react'

/** Consistent page top row: title/description left, actions right. */
export function PageHeader(props: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  divider?: boolean
}): ReactNode {
  return (
    <div
      className={clsx(
        'mb-4 flex flex-wrap items-start justify-between gap-3',
        props.divider && 'border-b border-edge pb-4',
      )}
    >
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.description && <p className="mt-1 text-sm text-ink-dim">{props.description}</p>}
      </div>
      {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
    </div>
  )
}
