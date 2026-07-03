import { clsx } from 'clsx'
import type { ReactNode } from 'react'

export function Skeleton(props: { className?: string }): ReactNode {
  return <div className={clsx('animate-pulse rounded-lg bg-panel-2', props.className)} />
}
