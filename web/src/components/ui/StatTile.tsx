/** Dashboard stat tile — one headline number with a label and optional
 * context line. Values wear text tokens (dataviz rule); the icon carries the
 * accent, not the number. */

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Card } from './Card'

export function StatTile(props: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: LucideIcon
  tone?: 'default' | 'ok' | 'warn' | 'bad'
  testId?: string
}): ReactNode {
  const Icon = props.icon
  const toneText =
    props.tone === 'ok'
      ? 'text-ok'
      : props.tone === 'warn'
        ? 'text-warn'
        : props.tone === 'bad'
          ? 'text-bad'
          : 'text-ink'
  return (
    <Card testId={props.testId} className="flex items-start gap-3">
      {Icon && (
        <span className="mt-0.5 rounded-lg bg-accent/10 p-2 text-accent">
          <Icon size={16} strokeWidth={2} aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-xs font-medium tracking-wide text-ink-dim uppercase">
          {props.label}
        </p>
        <p className={`mt-1 text-2xl leading-none font-semibold tabular-nums ${toneText}`}>
          {props.value}
        </p>
        {props.sub && <p className="mt-1.5 truncate text-xs text-ink-dim">{props.sub}</p>}
      </div>
    </Card>
  )
}
