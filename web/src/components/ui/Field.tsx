/** Shared form-control chrome: label + control + error line, and the input
 * class constants every form uses (single place to restyle). */

import type { ReactNode } from 'react'

export const INPUT_CLASS =
  'w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none'
export const INPUT_MONO_CLASS = `${INPUT_CLASS} font-mono`

export function Field(props: {
  label: ReactNode
  error?: string | undefined
  hint?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-dim">{props.label}</span>
      {props.children}
      {props.hint && !props.error && (
        <span className="mt-1 block text-xs text-ink-faint">{props.hint}</span>
      )}
      {props.error && <span className="mt-1 block text-xs text-bad">{props.error}</span>}
    </label>
  )
}
