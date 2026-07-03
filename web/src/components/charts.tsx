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
  Bar,
  BarChart,
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

export interface UsageRow {
  agent: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

/** Per-agent token usage, horizontal stacked bars. Fixed series order
 * input → cache → output (validated adjacency); 1px panel stroke acts as the
 * spacer between stacked segments. */
export function UsageBarChart(props: { rows: UsageRow[]; height?: number }): ReactNode {
  const height = props.height ?? Math.max(120, 28 * props.rows.length + 72)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={props.rows}
        layout="vertical"
        margin={{ top: 4, right: 12, bottom: 0, left: 8 }}
      >
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => v.toLocaleString('en-US')}
        />
        <YAxis
          type="category"
          dataKey="agent"
          width={110}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: 'var(--color-panel-2)', opacity: 0.5 }}
          formatter={(v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? ''))}
        />
        <Legend wrapperStyle={LEGEND_STYLE} iconSize={9} />
        <Bar
          dataKey="inputTokens"
          name="input"
          stackId="tokens"
          fill="var(--color-viz-1)"
          stroke="var(--color-panel)"
          strokeWidth={1}
          isAnimationActive={false}
        />
        <Bar
          dataKey="cacheReadTokens"
          name="cache read"
          stackId="tokens"
          fill="var(--color-viz-2)"
          stroke="var(--color-panel)"
          strokeWidth={1}
          isAnimationActive={false}
        />
        <Bar
          dataKey="outputTokens"
          name="output"
          stackId="tokens"
          fill="var(--color-viz-3)"
          stroke="var(--color-panel)"
          strokeWidth={1}
          radius={[0, 3, 3, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
