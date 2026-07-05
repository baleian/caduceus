/** Dashboard/System KPI tile — a headline number that FILLS its card instead
 * of hugging the top-left. Label + icon chip on top, big value on the bottom
 * with an optional delta. Values wear text tokens (dataviz rule); the icon
 * carries the accent, not the number. */

import { clsx } from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Card } from './Card'

export function StatTile(props: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: LucideIcon
  tone?: 'default' | 'ok' | 'warn' | 'bad'
  delta?: { value: string; dir: 'up' | 'down' | 'flat' }
  valueClassName?: string
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
    <Card testId={props.testId} compact className="flex min-h-[84px] flex-col justify-between gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-2xs font-medium tracking-wide text-ink-dim uppercase">
          {props.label}
        </p>
        {Icon && (
          <span className="shrink-0 rounded-md bg-accent/10 p-1.5 text-accent">
            <Icon size={15} strokeWidth={2} aria-hidden />
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <p
          className={clsx(
            'text-[26px] leading-none font-semibold tabular-nums',
            toneText,
            props.valueClassName,
          )}
        >
          {props.value}
        </p>
        {props.delta && (
          <span
            className={clsx(
              'mb-0.5 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-2xs font-medium tabular-nums',
              props.delta.dir === 'up' && 'bg-ok/10 text-ok',
              props.delta.dir === 'down' && 'bg-bad/10 text-bad',
              props.delta.dir === 'flat' && 'bg-ink-dim/10 text-ink-dim',
            )}
          >
            {props.delta.dir === 'up' ? '▲' : props.delta.dir === 'down' ? '▼' : '–'}
            {props.delta.value}
          </span>
        )}
      </div>
      {props.sub && <p className="truncate text-xs text-ink-dim">{props.sub}</p>}
    </Card>
  )
}
