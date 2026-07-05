/** Code-split wrappers: recharts (~400KB) and the markdown/highlight stack
 * (~250KB) load as separate chunks so the shell paints fast; callers keep the
 * same props as the eager components. */

import { lazy, Suspense, type ComponentProps, type ReactNode } from 'react'

import type { TrafficChart as EagerTrafficChart } from './charts'
import type { Markdown as EagerMarkdown } from './Markdown'
import type {
  ActivityChart as EagerActivityChart,
  DistributionDonut as EagerDistributionDonut,
  LatencyChart as EagerLatencyChart,
  RankBars as EagerRankBars,
  Sparkline as EagerSparkline,
  TokenStackChart as EagerTokenStackChart,
} from './obsCharts'
import { Skeleton } from './ui/Skeleton'

const TrafficChartInner = lazy(() => import('./charts').then((m) => ({ default: m.TrafficChart })))
const MarkdownInner = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))
const ActivityChartInner = lazy(() =>
  import('./obsCharts').then((m) => ({ default: m.ActivityChart })),
)
const TokenStackChartInner = lazy(() =>
  import('./obsCharts').then((m) => ({ default: m.TokenStackChart })),
)
const LatencyChartInner = lazy(() =>
  import('./obsCharts').then((m) => ({ default: m.LatencyChart })),
)
const DistributionDonutInner = lazy(() =>
  import('./obsCharts').then((m) => ({ default: m.DistributionDonut })),
)
const RankBarsInner = lazy(() => import('./obsCharts').then((m) => ({ default: m.RankBars })))
const SparklineInner = lazy(() => import('./obsCharts').then((m) => ({ default: m.Sparkline })))

export function TrafficChart(props: ComponentProps<typeof EagerTrafficChart>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[220px]" />}>
      <TrafficChartInner {...props} />
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

export function ActivityChart(props: ComponentProps<typeof EagerActivityChart>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[240px]" />}>
      <ActivityChartInner {...props} />
    </Suspense>
  )
}

export function TokenStackChart(props: ComponentProps<typeof EagerTokenStackChart>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[240px]" />}>
      <TokenStackChartInner {...props} />
    </Suspense>
  )
}

export function LatencyChart(props: ComponentProps<typeof EagerLatencyChart>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[220px]" />}>
      <LatencyChartInner {...props} />
    </Suspense>
  )
}

export function DistributionDonut(props: ComponentProps<typeof EagerDistributionDonut>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[200px]" />}>
      <DistributionDonutInner {...props} />
    </Suspense>
  )
}

export function RankBars(props: ComponentProps<typeof EagerRankBars>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-[160px]" />}>
      <RankBarsInner {...props} />
    </Suspense>
  )
}

export function Sparkline(props: ComponentProps<typeof EagerSparkline>): ReactNode {
  return (
    <Suspense fallback={<Skeleton className="h-9" />}>
      <SparklineInner {...props} />
    </Suspense>
  )
}
