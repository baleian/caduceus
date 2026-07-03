/** System (Q2=A, redesign §6.6): deep status (GET /api/status), job history,
 * drift alerts and the raw event log (bounded). Doctor stays CLI-only — if
 * the daemon is down this page cannot render at all. */

import { RefreshCw } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client'
import { JobProgressCard } from '../../components/JobProgressCard'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { PageHeader } from '../../components/ui/PageHeader'
import type { DeepStatus, JobSnapshot } from '../../lib/types'
import { useApp } from '../../state/AppStore'

const TH_CLASS = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-faint'

export function SystemPage(): ReactNode {
  const { client, state, toast } = useApp()
  const [status, setStatus] = useState<DeepStatus | null>(null)
  const [jobs, setJobs] = useState<JobSnapshot[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

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

  return (
    <div>
      <PageHeader
        title="System"
        description="daemon health, jobs and events"
        actions={
          <Button variant="outline" testId="system-refresh-button" onClick={() => void refetch()}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {status && (
            <Card testId="system-deep-status">
              <CardHeader
                title="Deep status"
                subtitle={
                  <>
                    {status.traffic.requests} requests · {status.traffic.errors} errors
                  </>
                }
              />
              <p className="mb-3 rounded-lg bg-panel-2 px-3 py-2 font-mono text-xs text-ink-dim">
                upstream: {status.upstream}
              </p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {Object.entries(status.agents).map(([name, summary]) => (
                  <li
                    key={name}
                    className="flex items-center justify-between rounded-lg border border-edge px-3 py-2 text-sm"
                  >
                    <span className="truncate font-medium">{name}</span>
                    <StatusBadge value={summary} />
                  </li>
                ))}
                {Object.keys(status.agents).length === 0 && (
                  <li className="text-sm text-ink-dim">no agents registered</li>
                )}
              </ul>
            </Card>
          )}

          <Card padded={false}>
            <CardHeader title="Jobs" className="px-4 pt-4" />
            {jobs.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-ink-dim">no jobs yet</p>
            ) : (
              <div className="overflow-x-auto pb-2">
                <table className="w-full border-collapse text-sm" data-testid="system-jobs-table">
                  <thead>
                    <tr className="border-b border-edge">
                      <th className={TH_CLASS}>id</th>
                      <th className={TH_CLASS}>kind</th>
                      <th className={TH_CLASS}>agent</th>
                      <th className={TH_CLASS}>state</th>
                      <th className={TH_CLASS}>created</th>
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
                          <td className="px-3 py-2 font-mono text-xs text-ink-dim">
                            {job.created_at}
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
                      className="rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs"
                    >
                      <span className="font-medium text-warn">{alert.kind}</span>
                      {alert.agent && <span> — {alert.agent}</span>}
                      <span className="mt-0.5 block font-mono text-[11px] text-ink-dim">
                        {alert.ts} {alert.detail}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Unrecognized events" subtitle="forward compatibility" />
            {state.live.eventLog.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-dim">none</p>
            ) : (
              <ul
                className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-xs"
                data-testid="system-event-log"
              >
                {state.live.eventLog
                  .slice()
                  .reverse()
                  .map((event, index) => (
                    <li key={index} className="text-ink-dim">
                      {event.ts} {event.kind} {event.agent ?? ''}
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
