/** Dashboard (redesign §6.1, Q2=A): the landing page — fleet health, live
 * traffic, token usage and recent activity in one 16:9-friendly screen. All
 * data comes from existing APIs and the WS-fed store; no new backend. */

import { Activity, AlertTriangle, Bot, CircleDollarSign, ListChecks, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { TrafficChart, UsageBarChart } from '../../components/lazy'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Skeleton } from '../../components/ui/Skeleton'
import { StatTile } from '../../components/ui/StatTile'
import { bucketRequests } from '../../lib/timeseries'
import type { ActiveAlert, GatewayInfo, JobSnapshot } from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { useAgentUsage } from '../../state/useAgentUsage'
import { usePolling } from '../../state/usePolling'

const BUCKET_MS = 30_000
const BUCKET_COUNT = 30 // 15 minutes of live traffic

const fmt = (n: number): string => n.toLocaleString('en-US')

export function DashboardPage(): ReactNode {
  const { client, state, refetchAgents, toast, dismissAlert } = useApp()
  const { usage } = useAgentUsage()
  const [info, setInfo] = useState<GatewayInfo | null>(null)
  const [jobs, setJobs] = useState<JobSnapshot[]>([])
  const [now, setNow] = useState(() => Date.now())
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
      setJobs(jobList.slice().reverse().slice(0, 6))
    } catch {
      // daemon reachability is already surfaced by the connection badge
    }
  }, [client, refetchAgents])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // advance the live traffic window even when no new events arrive
  usePolling(
    () => {
      setNow(Date.now())
      return Promise.resolve()
    },
    10_000,
    true,
  )

  const buckets = useMemo(
    () => bucketRequests(state.live.recentRequests, now, BUCKET_MS, BUCKET_COUNT),
    [state.live.recentRequests, now],
  )

  const running = state.agents.filter(
    (a) => (state.live.agents[a.name]?.process ?? a.process) === 'running',
  ).length
  const totalCost = usage?.reduce((n, u) => n + u.costUsd, 0)
  const activeJobs = jobs.filter((j) => j.state !== 'done' && j.state !== 'failed').length
  const usageRows = (usage ?? []).filter((u) => u.reachable)
  const hasTokenData = usageRows.some((u) => u.inputTokens + u.cacheReadTokens + u.outputTokens > 0)
  // Q3=A: current conditions only — the System board keeps the session history
  const alerts = Object.values(state.activeAlerts)
    .sort((a, b) => (a.since < b.since ? 1 : -1))
    .slice(0, 8)

  return (
    <div data-testid="dashboard-page">
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-5">
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
        <StatTile
          label="Requests"
          icon={Activity}
          value={fmt(info?.traffic.totals.requests ?? 0)}
          sub={info ? `since ${info.traffic.since}` : undefined}
        />
        <StatTile
          label="Errors"
          icon={AlertTriangle}
          tone={(info?.traffic.totals.errors ?? 0) > 0 ? 'bad' : 'default'}
          value={fmt(info?.traffic.totals.errors ?? 0)}
          sub="gateway error responses"
        />
        <StatTile
          label="Est. cost"
          icon={CircleDollarSign}
          value={totalCost === undefined ? '…' : `$${totalCost.toFixed(2)}`}
          sub="all agents, hermes sessions"
        />
        <StatTile label="Jobs" icon={ListChecks} value={activeJobs} sub={`${jobs.length} recent`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader
              title="Live traffic"
              subtitle="proxied requests observed by this page (15 min window)"
            />
            {state.live.recentRequests.length === 0 ? (
              <p className="py-10 text-center text-sm text-ink-dim">
                no proxied requests since this page loaded
              </p>
            ) : (
              <TrafficChart buckets={buckets} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Token usage by agent"
              subtitle="cumulative input / cache read / output, summed from hermes sessions"
            />
            {usage === null ? (
              <Skeleton className="h-32" />
            ) : !hasTokenData ? (
              <p className="py-10 text-center text-sm text-ink-dim">
                {usageRows.length === 0 ? 'no reachable agents yet' : 'no token usage recorded yet'}
              </p>
            ) : (
              <UsageBarChart rows={usageRows} />
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Fleet"
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
                    <Button variant="gradient" size="sm">
                      <Plus size={14} aria-hidden /> New agent
                    </Button>
                  </Link>
                }
              />
            ) : (
              <ul className="space-y-1">
                {state.agents.map((agent) => {
                  const live = state.live.agents[agent.name]
                  return (
                    <li key={agent.name}>
                      <Link
                        to={`/agents/${encodeURIComponent(agent.name)}`}
                        className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2"
                      >
                        <span className="truncate font-medium">{agent.name}</span>
                        <StatusBadge value={live?.process ?? agent.process} />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Alerts" subtitle="active now" />
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
                        {alert.kind === 'drift' ? `drift: ${alert.reason ?? ''}` : `orphan ${alert.resource ?? ''}`}
                      </span>
                      <span className="text-ink"> — {alert.kind === 'drift' ? alert.agent : alert.name}</span>
                      <span className="mt-0.5 block font-mono text-[11px] text-ink-dim">
                        since {alert.since}
                      </span>
                    </div>
                    {alert.kind === 'orphan' && (alert.resource === 'profile' || alert.resource === 'container') && (
                      <Button
                        variant="outline"
                        size="xs"
                        className="shrink-0"
                        disabled={resolving.has(alert.key)}
                        onClick={() => void cleanupOrphan(alert)}
                        testId={`dashboard-orphan-cleanup-${alert.name ?? ''}`}
                      >
                        {resolving.has(alert.key) ? 'cleaning…' : 'clean up'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent jobs"
              actions={
                <Link to="/system">
                  <Button variant="ghost" size="xs">
                    history
                  </Button>
                </Link>
              }
            />
            {jobs.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-dim">no jobs yet</p>
            ) : (
              <ul className="space-y-1.5">
                {jobs.map((job) => (
                  <li key={job.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{job.kind}</span>
                      <span className="text-ink-dim"> {job.agent}</span>
                    </span>
                    <StatusBadge value={job.state} />
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
