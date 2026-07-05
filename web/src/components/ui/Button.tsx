/** Button kit — one place for interactive-control chrome so pages stay
 * declarative. `variant` covers every button style used across the app.
 *
 * Hierarchy contract (enforced app-wide): at most ONE enabled {gradient|primary}
 * per screen. gradient = the single brand moment; primary = the one standard
 * action; everything else steps down to outline → ghost. Destructive uses
 * danger (final confirm) / dangerGhost (in-context entry point). */

import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'gradient' | 'outline' | 'ghost' | 'danger' | 'dangerGhost'
export type ButtonSize = 'xs' | 'sm' | 'md'

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-strong text-white hover:brightness-110 shadow-sm shadow-accent-strong/20 border border-transparent',
  gradient:
    'bg-brand-gradient text-white hover:brightness-110 shadow-sm shadow-accent/30 border border-transparent',
  outline: 'border border-edge-strong text-ink hover:bg-panel-2',
  ghost: 'border border-transparent text-ink-dim hover:bg-panel-2 hover:text-ink',
  danger: 'bg-bad text-white hover:brightness-110 border border-transparent',
  dangerGhost: 'border border-bad/40 text-bad hover:bg-bad/10',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'px-2 py-1 text-xs gap-1',
  sm: 'px-3 py-1.5 text-sm gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Show a spinner and force-disable while an async action is in flight. */
  busy?: boolean
  testId?: string
}

export function Button(props: ButtonProps): ReactNode {
  const {
    variant = 'primary',
    size = 'sm',
    busy = false,
    disabled,
    testId,
    className,
    type,
    children,
    ...rest
  } = props
  return (
    <button
      type={type ?? 'button'}
      data-testid={testId}
      disabled={disabled || busy}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {busy && <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}
