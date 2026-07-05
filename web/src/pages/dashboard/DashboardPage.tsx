/** Dashboard (redesign §6.1, Q2=A) — the ENTRY HUB. Summary KPIs + deeplinks
 * into the source-of-truth pages (Agents / Observability / System); it no longer
 * re-hosts the heavy traffic & token charts (those live on Observability). All
 * data comes from existing APIs and the WS-fed store; no new backend. */

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CircleDollarSign,
  ListChecks,
  Plus,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatTile } from '../../components/ui/StatTile'
import { formatCost, formatCount, timeAgo } from '../../lib/format'
import type { ActiveAlert, GatewayInfo, JobSnapshot } from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { useAgentUsage } from '../../state/useAgentUsage'

export function DashboardPage(): ReactNode {
  const { client, state, refetchAgents, toast, dismissAlert } = useApp()
  const { usage } = useAgentUsage()
  const [info, setInfo] = useState<GatewayInfo | null>(null)
  const [jobs, setJobs] = useState<JobSnapshot[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [resolving, setResolving] = useState<ReadonlySet<string>>(() => new Set())

  const cleanupOrphan = useCallback(
    async (alert: ActiveAlert) => {
      const resource = alert.resource
      const name = alert.name
      if ((resource !== 'profile' && resource !== 'container') || !name) return
      setResolving((s) => new Set(s).add(alert.key))
      try {
        await client.resolveOrphan(resource, name)
        dismissAlert(alert.key) // optimistic; the snapshot poll is authoritative
        toast('info', `cleaning up orphan ${resource} — ${name}`)
      } catch {
        toast('error', `cleanup failed — ${name}`)
      } finally {
        setResolving((s) => {
          const next = new Set(s)
          next.delete(alert.key)
          return next
        })
      }
    },
    [client, dismissAlert, toast],
  )

  const refetch = useCallback(async () => {
    void refetchAgents()
    try {
      const [gateway, jobList] = await Promise.all([client.gatewayInfo(), client.listJobs()])
      setInfo(gateway)
      setJobs(jobList.slice().reverse())
    } catch {
      // daemon reachability is already surfaced by the connection badge
    }
  }, [client, refetchAgents])

  useEffect(() => {
    void refetch()
  }, [refetch])

  async function doRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }

  const running = state.agents.filter(
    (a) => (state.live.agents[a.name]?.process ?? a.process) === 'running',
  ).length
  const usageRows = (usage ?? []).filter((u) => u.reachable)
  const totalCost = usage?.reduce((n, u) => n + u.costUsd, 0)
  const totals = usageRows.reduce(
    (acc, u) => ({
      input: acc.input + u.inputTokens,
      cache: acc.cache + u.cacheReadTokens,
      output: acc.output + u.outputTokens,
    }),
    { input: 0, cache: 0, output: 0 },
  )
  const hasTokenData = totals.input + totals.cache + totals.output > 0
  const activeJobs = jobs.filter((j) => j.state !== 'done' && j.state !== 'failed').length
  const recentJobs = jobs.slice(0, 8)
  const requests = info?.traffic.totals.requests ?? 0
  const errors = info?.traffic.totals.errors ?? 0
  // Q3=A: current conditions only — the System board keeps the session history
  const alerts = Object.values(state.activeAlerts)
    .sort((a, b) => (a.since < b.since ? 1 : -1))
    .slice(0, 8)

  return (
    <div data-testid="dashboard-page">
      <PageHeader
        title="Dashboard"
        description="fleet health at a glance"
        divider
        actions={
          <>
            <Button variant="outline" busy={refreshing} onClick={() => void doRefresh()}>
              <RefreshCw size={13} aria-hidden /> Refresh
            </Button>
            <Link to="/agents">
              <Button variant="primary">
                <Plus size={14} aria-hidden /> New agent
              </Button>
            </Link>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiLink to="/agents">
          <StatTile
            label="Agents"
            icon={Bot}
            value={
              <>
                {running}
                <span className="text-base font-normal text-ink-dim"> / {state.agents.length}</span>
              </>
            }
            sub="running / registered"
            testId="dashboard-stat-agents"
          />
        </KpiLink>
        <KpiLink to="/observability">
          <StatTile label="Requests" icon={Activity} value={formatCount(requests)} sub="LLM calls" />
        </KpiLink>
        <KpiLink to="/observability">
          <StatTile
            label="Errors"
            icon={AlertTriangle}
            tone={errors > 0 ? 'bad' : 'default'}
            value={formatCount(errors)}
            sub="failed calls"
          />
        </KpiLink>
        <KpiLink to="/observability">
          <StatTile
            label="Est. cost"
            icon={CircleDollarSign}
            value={totalCost === undefined ? '…' : formatCost(totalCost)}
            sub="all agents"
          />
        </KpiLink>
        <KpiLink to="/system">
          <StatTile label="Jobs" icon={ListChecks} value={activeJobs} sub={`${jobs.length} recent`} />
        </KpiLink>
        <KpiLink to="/system">
          <StatTile
            label="Alerts"
            icon={ShieldAlert}
            tone={alerts.length > 0 ? 'warn' : 'default'}
            value={alerts.length}
            sub="active now"
          />
        </KpiLink>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader
              title="Fleet"
              subtitle={`${running} of ${state.agents.length} running`}
              actions={
                <Link to="/agents">
                  <Button variant="ghost" size="xs">
                    view all
                  </Button>
                </Link>
              }
            />
            {state.agents.length === 0 ? (
              <EmptyState
                icon={Bot}
                title="No agents yet"
                description="Create your first agent to get started."
                action={
                  <Link to="/agents">
                    <Button variant="outline" size="sm">
                      <Plus size={14} aria-hidden /> New agent
                    </Button>
                  </Link>
                }
              />
            ) : (
              <>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {state.agents.slice(0, 12).map((agent) => {
                    const live = state.live.agents[agent.name]
                    return (
                      <li key={agent.name}>
                        <Link
                          to={`/agents/${encodeURIComponent(agent.name)}`}
                          className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-panel-2"
                        >
                          <span className="min-w-0 truncate font-medium">{agent.name}</span>
                          <StatusBadge value={live?.process ?? agent.process} />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
                {state.agents.length > 12 && (
                  <Link
                    to="/agents"
                    className="mt-2 block text-center text-xs text-accent hover:underline"
                  >
                    +{state.agents.length - 12} more →
                  </Link>
                )}
              </>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent jobs"
              subtitle={activeJobs > 0 ? `${activeJobs} active` : 'provisioning history'}
              actions={
                <Link to="/system">
                  <Button variant="ghost" size="xs">
                    history
                  </Button>
                </Link>
              }
            />
            {recentJobs.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-dim">no jobs yet</p>
            ) : (
              <ul className="grid gap-1 sm:grid-cols-2">
                {recentJobs.map((job) => (
                  <li
                    key={job.id}
                    className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-panel-2"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{job.kind}</span>
                      <span className="text-ink-dim"> {job.agent}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-ink-faint">{timeAgo(job.created_at)}</span>
                      <StatusBadge value={job.state} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Token usage"
              subtitle="summed across agents"
              actions={
                <Link
                  to="/observability"
                  data-testid="dashboard-open-observability-link"
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline"
                >
                  Observability <ArrowUpRight size={12} aria-hidden />
                </Link>
              }
            />
            {usage === null ? (
              <Skeleton className="h-20" />
            ) : !hasTokenData ? (
              <p className="py-4 text-center text-sm text-ink-dim">no token usage yet</p>
            ) : (
              <dl className="space-y-1.5 text-sm">
                <UsageRow label="input" value={formatCount(totals.input)} />
                <UsageRow label="cache read" value={formatCount(totals.cache)} />
                <UsageRow label="output" value={formatCount(totals.output)} />
                <div className="flex justify-between border-t border-edge pt-1.5">
                  <dt className="text-ink-dim">est. cost</dt>
                  <dd className="font-mono text-xs">{formatCost(totalCost)}</dd>
                </div>
              </dl>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Alerts"
              subtitle="active now"
              actions={
                alerts.length > 0 ? (
                  <Link to="/system">
                    <Button variant="ghost" size="xs">
                      history
                    </Button>
                  </Link>
                ) : undefined
              }
            />
            {alerts.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-dim">no active alerts</p>
            ) : (
              <ul className="space-y-2" data-testid="dashboard-active-alerts">
                {alerts.map((alert) => (
                  <li
                    key={alert.key}
                    className="flex items-start justify-between gap-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-warn">
                        {alert.kind === 'drift'
                          ? `drift: ${alert.reason ?? ''}`
                          : `orphan ${alert.resource ?? ''}`}
                      </span>
                      <span className="text-ink">
                        {' '}
                        — {alert.kind === 'drift' ? alert.agent : alert.name}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-dim">
                        {timeAgo(alert.since)}
                      </span>
                    </div>
                    {alert.kind === 'orphan' &&
                      (alert.resource === 'profile' || alert.resource === 'container') && (
                        <Button
                          variant="outline"
                          size="xs"
                          className="shrink-0"
                          busy={resolving.has(alert.key)}
                          onClick={() => void cleanupOrphan(alert)}
                          testId={`dashboard-orphan-cleanup-${alert.name ?? ''}`}
                        >
                          clean up
                        </Button>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function KpiLink(props: { to: string; children: ReactNode }): ReactNode {
  return (
    <Link
      to={props.to}
      className="block rounded-lg outline-none ring-accent/40 transition hover:ring-2 focus-visible:ring-2"
    >
      {props.children}
    </Link>
  )
}

function UsageRow(props: { label: string; value: string }): ReactNode {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-dim">{props.label}</dt>
      <dd className="font-mono text-xs tabular-nums">{props.value}</dd>
    </div>
  )
}
