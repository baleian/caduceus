import { clsx } from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'

export function Card(
  props: HTMLAttributes<HTMLDivElement> & { testId?: string; padded?: boolean },
): ReactNode {
  const { className, testId, padded = true, ...rest } = props
  return (
    <div
      data-testid={testId}
      className={clsx(
        'rounded-xl border border-edge bg-panel shadow-sm shadow-black/5',
        padded && 'p-4',
        className,
      )}
      {...rest}
    />
  )
}

/** Card section title row: left title/subtitle, right actions. */
export function CardHeader(props: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={clsx('mb-3 flex items-start justify-between gap-3', props.className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{props.title}</h2>
        {props.subtitle && <p className="mt-0.5 text-xs text-ink-dim">{props.subtitle}</p>}
      </div>
      {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
    </div>
  )
}
