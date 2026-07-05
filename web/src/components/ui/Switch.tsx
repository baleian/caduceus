/** Toggle with a real track+thumb so an operable control never reads as a
 * read-only StatusBadge (audit A4). Backs the Skills + allow-private-urls
 * toggles. Keeps role="switch" + aria-checked + the call-site data-testid. */

import { clsx } from 'clsx'
import type { ReactNode } from 'react'

export function Switch(props: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: ReactNode // trailing state text, e.g. "enabled" / "allowed"
  onColor?: 'accent' | 'ok' // ok for security-style opt-ins
  size?: 'sm' | 'md'
  testId?: string
  'aria-label'?: string
}): ReactNode {
  const { checked, onChange, disabled, size = 'sm', onColor = 'accent', testId } = props
  const d =
    size === 'md'
      ? { track: 'h-5 w-9', thumb: 'size-4', on: 'translate-x-4' }
      : { track: 'h-[18px] w-8', thumb: 'size-3.5', on: 'translate-x-[14px]' }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={props['aria-label']}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 disabled:pointer-events-none disabled:opacity-40"
    >
      <span
        className={clsx(
          'relative inline-flex shrink-0 items-center rounded-full border transition-colors',
          d.track,
          checked
            ? onColor === 'ok'
              ? 'border-transparent bg-ok'
              : 'border-transparent bg-accent-strong'
            : 'border-edge-strong bg-panel-2',
        )}
      >
        <span
          className={clsx(
            'absolute left-0.5 rounded-full bg-white shadow-sm transition-transform',
            d.thumb,
            checked ? d.on : 'translate-x-0',
          )}
        />
      </span>
      {props.label && (
        <span className={clsx('text-xs font-medium', checked ? 'text-ink' : 'text-ink-dim')}>
          {props.label}
        </span>
      )}
    </button>
  )
}
