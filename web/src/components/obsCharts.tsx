/** Observability chart kit (observability-redesign S6, dataviz method).
 *
 * Same conventions as charts.tsx: recessive grid/axes, thin marks, series on
 * validated viz tokens (viz-1..4 — six checks re-run for the 4-slot palette,
 * light + dark), status red reserved for errors, hover tooltips by default,
 * no animation on live-refreshed data (polling swaps data, not motion).
 * Fixed series order everywhere — colors follow the entity, never the rank. */

import type { ReactNode } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { bucketLabel, formatCount, formatMs } from '../lib/format'
import { foldSlices, type DonutSlice } from '../lib/obs'
import type { GatewayBucket, UsageBucket } from '../lib/types'

export type { DonutSlice }

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
const CURSOR = { stroke: 'var(--color-edge-strong)' } as const

const countTip = (v: unknown): string => (typeof v === 'number' ? formatCount(v) : String(v ?? ''))

/** Requests area + sessions line on one count axis (usage activity). */
export function ActivityChart(props: {
  buckets: UsageBucket[]
  bucketS: number
  height?: number
}): ReactNode {
  const data = props.buckets.map((b) => ({ ...b, label: bucketLabel(b.start_s, props.bucketS) }))
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={32} />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          tickFormatter={formatCount}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CURSOR} formatter={countTip} />
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
          dataKey="sessions"
          name="sessions"
          stroke="var(--color-viz-2)"
          strokeWidth={2}
          fill="var(--color-viz-2)"
          fillOpacity={0.12}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Token composition over time — stacked areas, fixed order in/out/cache/reasoning. */
export function TokenStackChart(props: {
  buckets: UsageBucket[]
  bucketS: number
  height?: number
}): ReactNode {
  const data = props.buckets.map((b) => ({ ...b, label: bucketLabel(b.start_s, props.bucketS) }))
  const series: { key: keyof UsageBucket; name: string; token: string }[] = [
    { key: 'input_tokens', name: 'input', token: 'var(--color-viz-1)' },
    { key: 'output_tokens', name: 'output', token: 'var(--color-viz-2)' },
    { key: 'cache_read_tokens', name: 'cache read', token: 'var(--color-viz-3)' },
    { key: 'reasoning_tokens', name: 'reasoning', token: 'var(--color-viz-4)' },
  ]
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={32} />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          tickFormatter={formatCount}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CURSOR} formatter={countTip} />
        <Legend wrapperStyle={LEGEND_STYLE} iconSize={9} />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            stackId="tokens"
            dataKey={s.key}
            name={s.name}
            stroke={s.token}
            strokeWidth={1.5}
            fill={s.token}
            fillOpacity={0.3}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Gateway latency: per-bucket avg line over a window-level p50–p95 band.
 * Band is a reference region (scope percentiles), not a per-bucket series —
 * honest about what the ring can answer. Zero-request buckets gap the line. */
export function LatencyChart(props: {
  buckets: GatewayBucket[]
  bucketS: number
  p50: number
  p95: number
  height?: number
}): ReactNode {
  const data = props.buckets.map((b) => ({
    label: bucketLabel(b.start_s, props.bucketS),
    avg: b.requests > 0 ? b.avg_latency_ms : null,
  }))
  const showBand = props.p95 > 0
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 220}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={32} />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => formatMs(v)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={CURSOR}
          formatter={(v) => (typeof v === 'number' ? formatMs(v) : '—')}
        />
        {showBand ? (
          <ReferenceArea
            y1={props.p50}
            y2={props.p95}
            fill="var(--color-viz-1)"
            fillOpacity={0.14}
            stroke="var(--color-viz-1)"
            strokeOpacity={0.35}
            strokeDasharray="4 4"
            label={{
              value: 'p50–p95',
              position: 'insideTopRight',
              fill: 'var(--color-ink-faint)',
              fontSize: 10,
            }}
          />
        ) : null}
        <Line
          type="monotone"
          dataKey="avg"
          name="avg latency"
          stroke="var(--color-viz-1)"
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

const DONUT_TOKENS = [
  'var(--color-viz-1)',
  'var(--color-viz-2)',
  'var(--color-viz-3)',
  'var(--color-viz-4)',
]
const OTHER_TOKEN = 'var(--color-ink-faint)'

/** Distribution donut (model/source) with a center headline total. */
export function DistributionDonut(props: {
  slices: DonutSlice[]
  centerLabel: string
  height?: number
}): ReactNode {
  const folded = foldSlices(props.slices)
  const total = folded.reduce((n, s) => n + s.value, 0)
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={props.height ?? 200}>
        <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={countTip} />
          <Legend wrapperStyle={LEGEND_STYLE} iconSize={9} layout="vertical" align="right" verticalAlign="middle" />
          <Pie
            data={folded}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={2}
            stroke="var(--color-panel)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {folded.map((slice, i) => (
              <Cell
                key={slice.name}
                fill={slice.name === 'other' ? OTHER_TOKEN : DONUT_TOKENS[i % DONUT_TOKENS.length]}
              />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pr-[30%]">
        <span className="text-lg font-semibold text-ink">{formatCount(total)}</span>
        <span className="text-[11px] text-ink-faint">{props.centerLabel}</span>
      </div>
    </div>
  )
}

export interface RankRow {
  label: string
  value: number
  dim?: boolean
}

/** Horizontal ranking bars, one measure — value direct-labeled at the end.
 * Single series → single hue; identity lives on the y label, not the color. */
export function RankBars(props: {
  rows: RankRow[]
  format?: (value: number) => string
  height?: number
}): ReactNode {
  const fmt = props.format ?? formatCount
  const height = props.height ?? Math.max(96, 34 * props.rows.length + 40)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={props.rows}
        layout="vertical"
        margin={{ top: 4, right: 48, bottom: 0, left: 8 }}
      >
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={fmt} />
        <YAxis
          type="category"
          dataKey="label"
          width={110}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: 'var(--color-panel-2)', opacity: 0.5 }}
          formatter={(v) => (typeof v === 'number' ? fmt(v) : String(v ?? ''))}
        />
        <Bar
          dataKey="value"
          name="value"
          fill="var(--color-viz-1)"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
          label={{
            position: 'right',
            fill: 'var(--color-ink-dim)',
            fontSize: 11,
            formatter: (v: unknown) => (typeof v === 'number' ? fmt(v) : ''),
          }}
        >
          {props.rows.map((row) => (
            <Cell key={row.label} fillOpacity={row.dim ? 0.35 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Axis-less trend for KPI tiles. Not interactive by design (stat tile rule). */
export function Sparkline(props: {
  values: number[]
  token?: string
  height?: number
}): ReactNode {
  const token = props.token ?? 'var(--color-viz-1)'
  const data = props.values.map((v, i) => ({ i, v }))
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <Area
          type="monotone"
          dataKey="v"
          stroke={token}
          strokeWidth={1.5}
          fill={token}
          fillOpacity={0.12}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
