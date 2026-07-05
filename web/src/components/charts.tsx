/** Chart kit (dataviz method): recessive grid/axes, thin marks, validated
 * series palette (viz-1/2/3 tokens — light+dark checked), status red reserved
 * for errors, hover tooltips by default, text in text tokens.
 *
 * Series colors ride on CSS custom properties so theme switches restyle the
 * SVG without re-render. */

import type { ReactNode } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { TrafficBucket } from '../lib/timeseries'

const AXIS_TICK = { fill: 'var(--color-ink-faint)', fontSize: 11 } as const
const GRID_STROKE = 'var(--color-edge)'

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-panel)',
  border: '1px solid var(--color-edge-strong)',
  borderRadius: '0.5rem',
  fontSize: '12px',
  color: 'var(--color-ink)',
} as const

const LEGEND_STYLE = { fontSize: '12px', color: 'var(--color-ink-dim)' } as const

function timeLabel(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Live request traffic: requests as a soft area, errors as a status-red bar
 * overlay (errors are a state, not a series-4). */
export function TrafficChart(props: { buckets: TrafficBucket[]; height?: number }): ReactNode {
  const data = props.buckets.map((b) => ({ ...b, label: timeLabel(b.start) }))
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={32} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ stroke: 'var(--color-edge-strong)' }} />
        <Legend wrapperStyle={LEGEND_STYLE} iconSize={9} />
        <Area
          type="monotone"
          dataKey="requests"
          name="requests"
          stroke="var(--color-viz-1)"
          strokeWidth={2}
          fill="var(--color-viz-1)"
          fillOpacity={0.18}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="errors"
          name="errors"
          stroke="var(--color-bad)"
          strokeWidth={2}
          fill="var(--color-bad)"
          fillOpacity={0.15}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// (UsageBarChart removed — per-agent token usage now lives on Observability's
// stacked ranking bar; the Dashboard token summary is a compact readout.)
