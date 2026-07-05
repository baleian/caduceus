/** Observability (observability-redesign S7) — the dedicated metrics surface.
 *
 * Two scopes (fleet ⇄ single agent via the scope picker / URL param), range
 * presets 24h/7d/30d plus a Live tab, and per-panel session narrow-down in
 * the agent scope. Two data sources with their nature always labeled:
 *   · usage   — hermes-native sessions (persistent), daemon aggregates
 *   · gateway — TrafficStats (volatile, "since daemon start")
 * Session narrow-down recomputes KPIs/series client-side from the per-session
 * rows (lib/obs.ts) — latency/errors can't narrow (gateway has no session id).
 * Polling swaps data without animation (§11: no motion on refresh). */

import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  RadioTower,
  RefreshCw,
  Telescope,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../../api/client'
import {
  ActivityChart,
  DistributionDonut,
  LatencyChart,
  RankBars,
  Sparkline,
  TokenStackChart,
  TrafficChart,
} from '../../components/lazy'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Skeleton } from '../../components/ui/Skeleton'
import {
  formatCount,
  formatDuration,
  formatMs,
  formatPct,
  formatUsd,
  shortDateTime,
} from '../../lib/format'
import { bucketRows, halfDelta, kpisFromRows } from '../../lib/obs'
import type { TrafficBucket } from '../../lib/timeseries'
import type {
  ObservabilityGateway,
  ObservabilityUsage,
  RankingRow,
  UsageBucket,
  UsageKpis,
  UsageRange,
  UsageSessionRow,
} from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { usePolling } from '../../state/usePolling'

type RangeTab = UsageRange | 'live'

const RANGE_TABS: { key: RangeTab; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'live', label: 'Live' },
]

const USAGE_POLL_MS = 15_000
const LIVE_POLL_MS = 5_000

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-faint'
const TD = 'px-3 py-2 whitespace-nowrap'

export function ObservabilityPage(): ReactNode {
  const { client, state, toast } = useApp()
  const navigate = useNavigate()
  const { agent: agentParam } = useParams<{ agent: string }>()
  const agentName = agentParam ?? null

  const [range, setRange] = useState<RangeTab>('24h')
  const [auto, setAuto] = useState(true)
  const [usage, setUsage] = useState<ObservabilityUsage | null>(null)
  const [gw, setGw] = useState<ObservabilityGateway | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const usageRange: UsageRange = range === 'live' ? '24h' : range

  const fetchUsage = useCallback(async () => {
    try {
      const fetched = await client.observabilityUsage(usageRange, agentName ?? undefined)
      setUsage(fetched)
      setUpdatedAt(new Date())
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'failed to load usage metrics')
    }
  }, [client, usageRange, agentName, toast])

  const fetchGw = useCallback(async () => {
    try {
      const window = range === 'live' ? '15m' : '1h'
      setGw(await client.observabilityGateway(window, agentName ?? undefined))
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'failed to load gateway metrics')
    }
  }, [client, range, agentName, toast])

  // immediate refetch on scope/range change; polling keeps it fresh after.
  useEffect(() => {
    setSessionId(null)
    setUsage(null) // don't show the previous scope's totals until the refetch lands
    void fetchUsage()
    void fetchGw()
  }, [fetchUsage, fetchGw])

  usePolling(fetchUsage, USAGE_POLL_MS, auto && range !== 'live')
  usePolling(fetchGw, range === 'live' ? LIVE_POLL_MS : USAGE_POLL_MS, auto)

  const refresh = useCallback(() => {
    void fetchUsage()
    void fetchGw()
  }, [fetchUsage, fetchGw])

  // -- scope derivation (fleet vs agent vs narrowed session) --------------------

  const scope = agentName && usage?.agent ? usage.agent : usage?.fleet
  const nowS = usage ? Date.parse(usage.generated_at) / 1000 : 0
  const allRows = useMemo(
    () => (agentName && usage?.agent ? usage.agent.sessions : []),
    [agentName, usage],
  )
  const narrowedRows = useMemo(
    () => (sessionId ? allRows.filter((r) => r.id === sessionId) : allRows),
    [allRows, sessionId],
  )
  const kpis: UsageKpis | null = useMemo(() => {
    if (!scope) return null
    if (agentName && sessionId) return kpisFromRows(narrowedRows, nowS)
    return scope.kpis
  }, [scope, agentName, sessionId, narrowedRows, nowS])
  const series: UsageBucket[] = useMemo(() => {
    if (!scope) return []
    if (agentName && sessionId) return bucketRows(narrowedRows, nowS, usageRange)
    return scope.series
  }, [scope, agentName, sessionId, narrowedRows, nowS, usageRange])

  const bucketS = usage?.bucket_s ?? 3600
  const agents = state.agents.map((a) => a.name)
  const narrowed = sessionId !== null

  function switchScope(next: string): void {
    void navigate(next === '' ? '/observability' : `/observability/${encodeURIComponent(next)}`)
  }

  return (
    <div data-testid="observability-page">
      {/* -- control bar (sticky) ------------------------------------------------ */}
      <div className="sticky top-0 z-20 -mx-8 mb-5 border-b border-edge/70 bg-surface/95 px-8 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Telescope size={17} className="text-accent" aria-hidden />
            Observability
          </span>
          <select
            data-testid="obs-scope-select"
            value={agentName ?? ''}
            onChange={(e) => switchScope(e.target.value)}
            className="rounded-lg border border-edge-strong bg-panel px-2.5 py-1.5 text-sm text-ink focus:outline-none"
            aria-label="scope"
          >
            <option value="">All agents (fleet)</option>
            {agents.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <div
            className="flex overflow-hidden rounded-lg border border-edge-strong"
            role="tablist"
            aria-label="time range"
          >
            {RANGE_TABS.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={range === tab.key}
                data-testid={`obs-range-${tab.key}`}
                onClick={() => setRange(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  range === tab.key
                    ? 'bg-accent/15 text-accent'
                    : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
                }`}
              >
                {tab.key === 'live' && (
                  <RadioTower size={11} className="mr-1 inline-block" aria-hidden />
                )}
                {tab.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-dim">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              auto
            </label>
            <Button
              variant="ghost"
              size="xs"
              testId="obs-refresh-button"
              onClick={refresh}
              title="refresh now"
            >
              <RefreshCw size={13} aria-hidden />
            </Button>
            <span className="text-xs tabular-nums text-ink-faint">
              {updatedAt
                ? `updated ${updatedAt.toLocaleTimeString('en-US', { hour12: false })}`
                : '—'}
            </span>
          </div>
        </div>
        {usage && usage.unreachable.length > 0 && (
          <p className="mt-2 text-xs text-warn">
            partial data — unreachable: {usage.unreachable.join(', ')}
          </p>
        )}
        {narrowed && (
          <p className="mt-2 flex items-center gap-2 text-xs text-ink-dim">
            <span className="rounded-md bg-accent/12 px-2 py-0.5 text-accent">
              narrowed to session {sessionId}
            </span>
            <button
              data-testid="obs-clear-session"
              onClick={() => setSessionId(null)}
              className="flex items-center gap-1 text-ink-dim hover:text-ink"
            >
              <X size={12} aria-hidden /> clear
            </button>
          </p>
        )}
      </div>

      {range === 'live' ? (
        <LiveView gw={gw} agentName={agentName} />
      ) : !usage || !scope || !kpis ? (
        <LoadingView />
      ) : kpis.sessions === 0 && !narrowed ? (
        <>
          <KpiStrip kpis={kpis} series={series} gw={gw} narrowed={narrowed} />
          <EmptyState
            icon={Telescope}
            title="no recorded activity in this scope"
            description="metrics appear as soon as an agent runs a session — persistent usage comes from hermes session accounting, live traffic from the gateway."
            testId="obs-empty"
          />
        </>
      ) : (
        <div className="space-y-5">
          <KpiStrip kpis={kpis} series={series} gw={gw} narrowed={narrowed} />

          <div className="grid gap-5 xl:grid-cols-2">
            <Card testId="obs-activity-card">
              <CardHeader
                title="Activity"
                subtitle={`requests & sessions · per ${bucketS >= 86_400 ? 'day' : bucketS >= 21_600 ? '6h' : 'hour'}`}
                actions={<PersistentBadge />}
              />
              <ActivityChart buckets={series} bucketS={bucketS} />
            </Card>
            <Card testId="obs-tokens-card">
              <CardHeader
                title="Token composition"
                subtitle="input · output · cache read · reasoning"
                actions={<PersistentBadge />}
              />
              <TokenStackChart buckets={series} bucketS={bucketS} />
            </Card>
          </div>

          {agentName === null ? (
            <FleetPanels usage={usage} onOpenAgent={(name) => switchScope(name)} />
          ) : (
            <AgentPanels
              scope={scope}
              gw={gw}
              rows={allRows}
              sessionId={sessionId}
              onSelectSession={(id) => setSessionId((cur) => (cur === id ? null : id))}
            />
          )}
        </div>
      )}
    </div>
  )
}

/* -- KPI strip ------------------------------------------------------------------ */

function KpiStrip(props: {
  kpis: UsageKpis
  series: UsageBucket[]
  gw: ObservabilityGateway | null
  narrowed: boolean
}): ReactNode {
  const { kpis, series, gw } = props
  const tokenTotals = series.map((b) => b.input_tokens + b.output_tokens)
  const errorRate = gw && gw.totals.requests > 0 ? gw.totals.errors / gw.totals.requests : 0
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
      <KpiTile
        testId="obs-kpi-requests"
        label="Requests"
        value={formatCount(kpis.requests)}
        spark={series.map((b) => b.requests)}
        delta={halfDelta(series, 'requests')}
      />
      <KpiTile
        label="Sessions"
        value={formatCount(kpis.sessions)}
        sub={`${kpis.active_sessions} active · avg ${formatDuration(kpis.avg_duration_s)}`}
        spark={series.map((b) => b.sessions)}
        delta={halfDelta(series, 'sessions')}
      />
      <KpiTile
        label="Tokens"
        value={formatCount(kpis.input_tokens + kpis.output_tokens)}
        sub={`${formatCount(kpis.input_tokens)} in · ${formatCount(kpis.output_tokens)} out`}
        spark={tokenTotals}
        delta={halfDelta(series, 'input_tokens')}
      />
      <KpiTile
        label="Cost (est.)"
        value={formatUsd(kpis.cost_usd)}
        sub={kpis.actual_cost_usd > 0 ? `actual ${formatUsd(kpis.actual_cost_usd)}` : undefined}
        spark={series.map((b) => b.cost_usd)}
        delta={halfDelta(series, 'cost_usd')}
      />
      <KpiTile
        label="Cache hit"
        value={formatPct(kpis.cache_hit_ratio)}
        sub={`${formatCount(kpis.cache_read_tokens)} cached reads`}
      />
      <KpiTile
        label="Error rate"
        value={formatPct(errorRate)}
        sub={gw ? `${formatCount(gw.totals.errors)} errors` : undefined}
        tone={errorRate > 0.05 ? 'bad' : undefined}
        volatile={props.narrowed ? 'no session breakdown' : 'since daemon start'}
      />
      <KpiTile
        label="Latency p50"
        value={gw ? formatMs(gw.latency.p50) : '—'}
        sub={gw ? `p95 ${formatMs(gw.latency.p95)} · avg ${formatMs(gw.latency.avg)}` : undefined}
        volatile={props.narrowed ? 'no session breakdown' : 'since daemon start'}
      />
    </div>
  )
}

function KpiTile(props: {
  label: string
  value: ReactNode
  sub?: ReactNode
  spark?: number[]
  delta?: number | null
  tone?: 'bad'
  volatile?: string
  testId?: string
}): ReactNode {
  const delta = props.delta ?? null
  const DeltaIcon = delta === null ? Minus : delta >= 0.005 ? ArrowUpRight : delta <= -0.005 ? ArrowDownRight : Minus
  return (
    <Card testId={props.testId} className="flex flex-col gap-1 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium tracking-wide text-ink-dim uppercase">
          {props.label}
        </span>
        {props.volatile && (
          <span
            className="shrink-0 rounded-full bg-panel-2 px-1.5 py-0.5 text-[9px] text-ink-faint"
            title={`gateway-scoped metric — ${props.volatile}; resets on daemon restart`}
          >
            live
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <span
          className={`text-xl leading-none font-semibold tabular-nums ${props.tone === 'bad' ? 'text-bad' : 'text-ink'}`}
        >
          {props.value}
        </span>
        {delta !== null && (
          <span className="flex items-center text-[11px] tabular-nums text-ink-dim">
            <DeltaIcon size={11} aria-hidden />
            {formatPct(Math.abs(delta))}
          </span>
        )}
      </div>
      {props.spark && props.spark.some((v) => v > 0) ? (
        <Sparkline values={props.spark} height={28} />
      ) : (
        <div className="h-7" />
      )}
      {props.sub && <p className="truncate text-[11px] text-ink-faint">{props.sub}</p>}
    </Card>
  )
}

/* -- fleet-only panels ------------------------------------------------------------ */

type RankMeasure = 'requests' | 'cost_usd' | 'tokens'

const tokenSum = (r: RankingRow): number =>
  (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.output_tokens ?? 0)

function FleetPanels(props: {
  usage: ObservabilityUsage
  onOpenAgent: (name: string) => void
}): ReactNode {
  const [measure, setMeasure] = useState<RankMeasure>('requests')
  const ranking = props.usage.fleet.ranking
  const isTokens = measure === 'tokens'
  const fmt = measure === 'cost_usd' ? formatUsd : formatCount
  const max = isTokens
    ? Math.max(...ranking.map(tokenSum), 1)
    : Math.max(...ranking.map((r) => r[measure]), 1)
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card testId="obs-ranking-card">
        <CardHeader
          title="Agents"
          subtitle={
            isTokens
              ? 'token usage by type — click an agent to narrow'
              : 'ranked comparison — click an agent to narrow'
          }
          actions={
            <div className="flex overflow-hidden rounded-lg border border-edge">
              {(
                [
                  ['requests', 'requests'],
                  ['tokens', 'tokens'],
                  ['cost_usd', 'cost'],
                ] as [RankMeasure, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setMeasure(key)}
                  className={`px-2 py-1 text-[11px] font-medium ${
                    measure === key ? 'bg-accent/15 text-accent' : 'text-ink-dim hover:bg-panel-2'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
        <ul className="space-y-1.5">
          {ranking.map((row) => {
            const total = isTokens ? tokenSum(row) : row[measure]
            return (
              <li key={row.agent}>
                <button
                  data-testid={`obs-rank-${row.agent}`}
                  onClick={() => props.onOpenAgent(row.agent)}
                  className="group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2"
                  title={`open ${row.agent}`}
                >
                  <span className="w-28 truncate text-sm text-ink">{row.agent}</span>
                  <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                    {isTokens ? (
                      <span
                        className="absolute inset-y-0 left-0 flex overflow-hidden rounded-full"
                        style={{
                          width: `${Math.max(2, (total / max) * 100)}%`,
                          opacity: row.reachable ? 1 : 0.35,
                        }}
                      >
                        <TokenSeg value={row.input_tokens} total={total} color="var(--color-viz-1)" />
                        <TokenSeg
                          value={row.cache_read_tokens}
                          total={total}
                          color="var(--color-viz-2)"
                        />
                        <TokenSeg
                          value={row.output_tokens}
                          total={total}
                          color="var(--color-viz-3)"
                        />
                      </span>
                    ) : (
                      <span
                        className={`absolute inset-y-0 left-0 rounded-full ${row.reachable ? 'bg-[var(--color-viz-1)]' : 'bg-[var(--color-viz-1)]/35'}`}
                        style={{ width: `${Math.max(2, (total / max) * 100)}%` }}
                      />
                    )}
                  </span>
                  <span className="w-16 text-right text-xs tabular-nums text-ink-dim">
                    {isTokens ? formatCount(total) : fmt(row[measure])}
                  </span>
                  {!row.reachable && (
                    <span className="rounded-full bg-warn/15 px-1.5 py-0.5 text-[9px] text-warn">
                      unreachable
                    </span>
                  )}
                </button>
              </li>
            )
          })}
          {ranking.length === 0 && <p className="px-2 py-3 text-xs text-ink-faint">no agents</p>}
        </ul>
        {isTokens && ranking.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-edge pt-2 text-[11px] text-ink-dim">
            <LegendDot color="var(--color-viz-1)" label="input" />
            <LegendDot color="var(--color-viz-2)" label="cache read" />
            <LegendDot color="var(--color-viz-3)" label="output" />
          </div>
        )}
      </Card>
      <DistributionCard scope={props.usage.fleet} />
    </div>
  )
}

function TokenSeg(props: { value: number; total: number; color: string }): ReactNode {
  if (!(props.total > 0) || !(props.value > 0)) return null
  return (
    <span
      className="h-full"
      style={{ width: `${(props.value / props.total) * 100}%`, backgroundColor: props.color }}
    />
  )
}

function LegendDot(props: { color: string; label: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: props.color }} />
      {props.label}
    </span>
  )
}

/* -- shared distribution card ------------------------------------------------------ */

function DistributionCard(props: {
  scope: { by_model: { model?: string; requests: number }[]; by_source: { source?: string; requests: number }[] }
}): ReactNode {
  return (
    <Card testId="obs-distribution-card">
      <CardHeader title="Distribution" subtitle="requests by model · by source" actions={<PersistentBadge />} />
      <div className="grid gap-4 sm:grid-cols-2">
        <DistributionDonut
          slices={props.scope.by_model.map((r) => ({ name: r.model ?? 'unknown', value: r.requests }))}
          centerLabel="requests"
        />
        <RankBars
          rows={props.scope.by_source.map((r) => ({ label: r.source ?? 'unknown', value: r.requests }))}
          height={190}
        />
      </div>
    </Card>
  )
}

/* -- agent-only panels ------------------------------------------------------------- */

function AgentPanels(props: {
  scope: NonNullable<ObservabilityUsage['agent']> | ObservabilityUsage['fleet']
  gw: ObservabilityGateway | null
  rows: UsageSessionRow[]
  sessionId: string | null
  onSelectSession: (id: string) => void
}): ReactNode {
  const { gw } = props
  return (
    <>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card testId="obs-latency-card">
          <CardHeader
            title="Latency"
            subtitle="per-bucket average · p50–p95 window band"
            actions={<VolatileBadge since={gw?.since} note="latency & errors carry no session id — agent level only" />}
          />
          {gw ? (
            <LatencyChart
              buckets={gw.series}
              bucketS={gw.bucket_s}
              p50={gw.latency.p50}
              p95={gw.latency.p95}
            />
          ) : (
            <Skeleton className="h-[220px]" />
          )}
        </Card>
        <DistributionCard scope={props.scope} />
      </div>

      <Card testId="obs-sessions-card" padded={false} className="overflow-hidden">
        <CardHeader
          className="px-4 pt-4"
          title="Sessions"
          subtitle="click a row to narrow every persistent panel to that session"
          actions={<PersistentBadge />}
        />
        <div className="max-h-[380px] overflow-x-auto overflow-y-auto">
          <table className="w-full text-sm" data-testid="obs-sessions-table">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-edge">
                <th className={TH}>session</th>
                <th className={TH}>model</th>
                <th className={TH}>source</th>
                <th className={TH}>started</th>
                <th className={TH}>duration</th>
                <th className={`${TH} text-right`}>msgs</th>
                <th className={`${TH} text-right`}>tools</th>
                <th className={`${TH} text-right`}>requests</th>
                <th className={`${TH} text-right`}>tokens</th>
                <th className={`${TH} text-right`}>cost</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => {
                const selected = props.sessionId === row.id
                return (
                  <tr
                    key={row.id ?? Math.random()}
                    data-testid={`obs-session-row-${row.id}`}
                    onClick={() => row.id && props.onSelectSession(row.id)}
                    className={`cursor-pointer border-b border-edge/60 transition-colors ${
                      selected ? 'bg-accent/10' : 'hover:bg-panel-2'
                    }`}
                  >
                    <td className={`${TD} max-w-[220px] truncate font-mono text-xs`}>
                      {row.title || row.id}
                    </td>
                    <td className={TD}>{row.model ?? '—'}</td>
                    <td className={TD}>{row.source ?? '—'}</td>
                    <td className={`${TD} tabular-nums`}>{shortDateTime(row.started_at)}</td>
                    <td className={`${TD} tabular-nums`}>{formatDuration(row.duration_s)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{formatCount(row.messages)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{formatCount(row.tool_calls)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{formatCount(row.requests)}</td>
                    <td className={`${TD} text-right tabular-nums`}>
                      {formatCount(row.input_tokens + row.output_tokens)}
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>{formatUsd(row.cost_usd)}</td>
                  </tr>
                )
              })}
              {props.rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-6 text-center text-xs text-ink-faint">
                    no sessions recorded yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}

/* -- live view ---------------------------------------------------------------------- */

function LiveView(props: { gw: ObservabilityGateway | null; agentName: string | null }): ReactNode {
  const { gw } = props
  if (!gw) return <LoadingView />
  const buckets: TrafficBucket[] = gw.series.map((b) => ({
    start: b.start_s * 1000,
    requests: b.requests,
    errors: b.errors,
    avgLatencyMs: b.avg_latency_ms,
  }))
  const errorRate = gw.totals.requests > 0 ? gw.totals.errors / gw.totals.requests : 0
  return (
    <div className="space-y-5" data-testid="obs-live-view">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Requests" value={formatCount(gw.totals.requests)} volatile="since daemon start" />
        <KpiTile
          label="Errors"
          value={formatCount(gw.totals.errors)}
          tone={gw.totals.errors > 0 ? 'bad' : undefined}
          volatile="since daemon start"
        />
        <KpiTile label="Error rate" value={formatPct(errorRate)} volatile="since daemon start" />
        <KpiTile label="Latency avg" value={formatMs(gw.latency.avg)} volatile="window" />
        <KpiTile
          label="p50 / p95"
          value={`${formatMs(gw.latency.p50)} / ${formatMs(gw.latency.p95)}`}
          volatile="window"
        />
        <KpiTile label="Max" value={formatMs(gw.latency.max)} volatile="window" />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card testId="obs-live-throughput-card">
          <CardHeader
            title="Throughput"
            subtitle="requests & errors · 10s buckets · last 15 min"
            actions={<VolatileBadge since={gw.since} />}
          />
          <TrafficChart buckets={buckets} />
        </Card>
        <Card testId="obs-live-latency-card">
          <CardHeader
            title="Latency"
            subtitle="per-bucket average · p50–p95 window band"
            actions={<VolatileBadge since={gw.since} />}
          />
          <LatencyChart buckets={gw.series} bucketS={gw.bucket_s} p50={gw.latency.p50} p95={gw.latency.p95} />
        </Card>
      </div>

      <Card padded={false} className="overflow-hidden" testId="obs-live-recent-card">
        <CardHeader className="px-4 pt-4" title="Recent requests" subtitle="newest last — ring tail (≤100)" />
        <div className="max-h-[320px] overflow-x-auto overflow-y-auto">
          <table className="w-full text-sm" data-testid="obs-live-recent-table">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-edge">
                <th className={TH}>time</th>
                {props.agentName === null && <th className={TH}>agent</th>}
                <th className={TH}>model</th>
                <th className={TH}>status</th>
                <th className={`${TH} text-right`}>latency</th>
              </tr>
            </thead>
            <tbody>
              {[...gw.recent].reverse().map((row, i) => (
                <tr key={`${row.ts}-${i}`} className="border-b border-edge/60">
                  <td className={`${TD} font-mono text-xs`}>{row.ts.slice(11, 19)}</td>
                  {props.agentName === null && <td className={TD}>{row.agent}</td>}
                  <td className={`${TD} max-w-[200px] truncate`}>{row.model}</td>
                  <td className={TD}>
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums ${
                        row.status >= 400 ? 'bg-bad/15 text-bad' : 'bg-ok/15 text-ok'
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{formatMs(row.latency_ms)}</td>
                </tr>
              ))}
              {gw.recent.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-ink-faint">
                    no traffic since daemon start
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

/* -- small shared bits ---------------------------------------------------------------- */

function PersistentBadge(): ReactNode {
  return (
    <span
      className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-ink-faint"
      title="hermes-native session accounting — persists across daemon restarts"
    >
      persistent
    </span>
  )
}

function VolatileBadge(props: { since?: string; note?: string }): ReactNode {
  const since = props.since ? ` · since ${props.since.slice(11, 19)}` : ''
  return (
    <span
      className="rounded-full bg-warn/10 px-2 py-0.5 text-[10px] text-warn"
      title={`gateway in-memory metric — resets on daemon restart${props.note ? `; ${props.note}` : ''}`}
    >
      live{since}
    </span>
  )
}

function LoadingView(): ReactNode {
  return (
    <div className="space-y-5" data-testid="obs-loading">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-[104px]" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-[300px]" />
        <Skeleton className="h-[300px]" />
      </div>
      <Skeleton className="h-[260px]" />
    </div>
  )
}
