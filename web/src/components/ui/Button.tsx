/** Button kit — one place for interactive-control chrome so pages stay
 * declarative. `variant` covers every button style used across the app. */

import { clsx } from 'clsx'
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
  testId?: string
}

export function Button(props: ButtonProps): ReactNode {
  const { variant = 'primary', size = 'sm', testId, className, type, ...rest } = props
  return (
    <button
      type={type ?? 'button'}
      data-testid={testId}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  )
}
