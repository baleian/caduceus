/** System (Q2=A, redesign §6.6): daemon-level diagnostics — deep status, job
 * history, drift/orphan alerts and the raw event log (bounded). It is the
 * source-of-truth for full job history + the alert log (the Dashboard shows
 * only summaries linking here). Doctor stays CLI-only. */

import { Activity, ArrowLeftRight, Bot, Percent, RefreshCw, TriangleAlert } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client'
import { JobProgressCard } from '../../components/JobProgressCard'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { PageHeader } from '../../components/ui/PageHeader'
import { StatTile } from '../../components/ui/StatTile'
import { formatCount, formatPct, timeAgo } from '../../lib/format'
import { humanizeDetail, humanizeKind } from '../../lib/humanize'
import type { DeepStatus, JobSnapshot } from '../../lib/types'
import { useApp } from '../../state/AppStore'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-faint'
const REACHABLE = new Set(['ok', 'running', 'healthy'])

export function SystemPage(): ReactNode {
  const { client, state, toast } = useApp()
  const [status, setStatus] = useState<DeepStatus | null>(null)
  const [jobs, setJobs] = useState<JobSnapshot[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refetch = useCallback(async () => {
    try {
      const [deep, jobList] = await Promise.all([client.deepStatus(), client.listJobs()])
      setStatus(deep)
      setJobs(jobList.slice().reverse())
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'failed to load system status')
    }
  }, [client, toast])

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

  const agentEntries = status ? Object.entries(status.agents) : []
  const reachable = agentEntries.filter(([, v]) => REACHABLE.has(v)).length
  const requests = status?.traffic.requests ?? 0
  const errors = status?.traffic.errors ?? 0
  const errorRate = requests > 0 ? errors / requests : 0

  return (
    <div>
      <PageHeader
        title="System"
        description="daemon diagnostics — status, jobs and events"
        divider
        actions={
          <Button
            variant="outline"
            testId="system-refresh-button"
            busy={refreshing}
            onClick={() => void doRefresh()}
          >
            <RefreshCw size={13} aria-hidden /> Refresh
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Requests" icon={Activity} value={formatCount(requests)} sub="since daemon start" />
        <StatTile
          label="Errors"
          icon={TriangleAlert}
          tone={errors > 0 ? 'bad' : 'default'}
          value={formatCount(errors)}
          sub="gateway responses"
        />
        <StatTile
          label="Agents"
          icon={Bot}
          value={
            <>
              {reachable}
              <span className="text-base font-normal text-ink-dim"> / {agentEntries.length}</span>
            </>
          }
          sub="reachable"
        />
        <StatTile
          label="Error rate"
          icon={Percent}
          tone={errorRate > 0.05 ? 'bad' : 'default'}
          value={formatPct(errorRate)}
          sub="errors / requests"
        />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {status && (
            <Card testId="system-deep-status">
              <CardHeader
                title="Deep status"
                subtitle={
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                    <ArrowLeftRight size={12} aria-hidden /> {status.upstream}
                  </span>
                }
              />
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {agentEntries.map(([name, summary]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between gap-2 rounded-lg border border-edge px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate font-medium">{name}</span>
                    <StatusBadge value={summary} />
                  </div>
                ))}
                {agentEntries.length === 0 && (
                  <p className="text-sm text-ink-dim">no agents registered</p>
                )}
              </div>
            </Card>
          )}

          <Card padded={false}>
            <CardHeader title="Jobs" className="px-4 pt-4" subtitle="provisioning history" />
            {jobs.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-ink-dim">no jobs yet</p>
            ) : (
              <div className="overflow-x-auto pb-2">
                <table className="w-full border-collapse text-sm" data-testid="system-jobs-table">
                  <thead>
                    <tr className="border-b border-edge">
                      <th className={TH}>id</th>
                      <th className={TH}>kind</th>
                      <th className={TH}>agent</th>
                      <th className={TH}>state</th>
                      <th className={TH}>created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <Fragment key={job.id}>
                        <tr
                          className="cursor-pointer border-b border-edge/60 last:border-0 hover:bg-panel-2"
                          onClick={() => setExpanded(expanded === job.id ? null : job.id)}
                          data-testid={`system-job-${job.id}-row`}
                        >
                          <td className="px-3 py-2 font-mono text-xs">{job.id}</td>
                          <td className="px-3 py-2">{job.kind}</td>
                          <td className="px-3 py-2">{job.agent}</td>
                          <td className="px-3 py-2">
                            <StatusBadge value={job.state} />
                          </td>
                          <td
                            className="px-3 py-2 text-xs text-ink-faint"
                            title={job.created_at}
                          >
                            {timeAgo(job.created_at)}
                          </td>
                        </tr>
                        {expanded === job.id && (
                          <tr>
                            <td colSpan={5} className="px-3 py-2">
                              <JobProgressCard jobId={job.id} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Drift / orphan alerts" subtitle="this session" />
            {state.live.alerts.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-dim">none this session</p>
            ) : (
              <ul className="space-y-2 text-sm" data-testid="system-alerts-list">
                {state.live.alerts
                  .slice()
                  .reverse()
                  .map((alert, index) => (
                    <li
                      key={index}
                      className="rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-warn">{humanizeKind(alert.kind)}</span>
                        <span className="text-[11px] text-ink-faint">{timeAgo(alert.ts)}</span>
                      </div>
                      {alert.agent && <span className="text-ink-dim">{alert.agent}</span>}
                      {alert.detail && (
                        <p className="mt-0.5 text-[11px] text-ink-dim">
                          {humanizeDetail(alert.detail)}
                        </p>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Events" subtitle="unrecognized — forward compatibility" />
            {state.live.eventLog.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-dim">none</p>
            ) : (
              <ul
                className="max-h-72 space-y-1 overflow-y-auto text-xs"
                data-testid="system-event-log"
              >
                {state.live.eventLog
                  .slice()
                  .reverse()
                  .map((event, index) => (
                    <li key={index} className="flex items-center justify-between gap-2 text-ink-dim">
                      <span className="min-w-0 truncate">
                        {humanizeKind(event.kind)}
                        {event.agent ? <span className="text-ink-faint"> · {event.agent}</span> : null}
                      </span>
                      <span className="shrink-0 text-[11px] text-ink-faint">{timeAgo(event.ts)}</span>
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
