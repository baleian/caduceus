/** Code-split wrappers: recharts (~400KB) and the markdown/highlight stack
 * (~250KB) load as separate chunks so the shell paints fast; callers keep the
 * same props as the eager components. */

import { lazy, Suspense, type ComponentProps, type ReactNode } from 'react'

import type {
  TrafficChart as EagerTrafficChart,
  UsageBarChart as EagerUsageBarChart,
} from './charts'
import type { Markdown as EagerMarkdown } from './Markdown'
import { Skeleton } from './ui/Skeleton'

const TrafficChartInner = lazy(() => import('./charts').then((m) => ({ default: m.TrafficChart })))
const UsageBarChartInner = lazy(() =>
  import('./charts').then((m) => ({ default: m.UsageBarChart })),
)
const MarkdownInner = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))

export function TrafficChart(props: ComponentProps<typeof EagerTrafficChart>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[220px]" />}>
      <TrafficChartInner {...props} />
    </Suspense>
  )
}

export function UsageBarChart(props: ComponentProps<typeof EagerUsageBarChart>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[160px]" />}>
      <UsageBarChartInner {...props} />
    </Suspense>
  )
}

export function Markdown(props: ComponentProps<typeof EagerMarkdown>): ReactNode {
  return (
    <Suspense fallback={<pre className="text-sm whitespace-pre-wrap">{props.text}</pre>}>
      <MarkdownInner {...props} />
    </Suspense>
  )
}
