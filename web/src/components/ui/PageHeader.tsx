import type { ReactNode } from 'react'

/** Consistent page top row: title/description left, actions right. */
export function PageHeader(props: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}): ReactNode {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.description && <p className="mt-1 text-sm text-ink-dim">{props.description}</p>}
      </div>
      {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
    </div>
  )
}
