/** System page (Q2=A): deep status (GET /api/status), job history, drift
 * alerts and the raw event log (bounded). Doctor stays CLI-only — if the
 * daemon is down this page cannot render at all. */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client'
import { JobProgressCard } from '../../components/JobProgressCard'
import { StatusBadge } from '../../components/StatusBadge'
import type { DeepStatus, JobSnapshot } from '../../lib/types'
import { useApp } from '../../state/AppStore'

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">System</h1>
        <button
          data-testid="system-refresh-button"
          className="rounded border border-edge px-3 py-1 text-sm hover:bg-panel"
          onClick={() => void refetch()}
        >
          Refresh
        </button>
      </div>

      {status && (
        <section
          className="rounded border border-edge bg-panel p-4"
          data-testid="system-deep-status"
        >
          <h2 className="mb-2 text-sm font-semibold">Deep status</h2>
          <p className="mb-2 font-mono text-xs text-ink-dim">upstream: {status.upstream}</p>
          <p className="mb-3 text-sm text-ink-dim">
            traffic totals — {status.traffic.requests} requests, {status.traffic.errors} errors
          </p>
          <ul className="space-y-1 text-sm">
            {Object.entries(status.agents).map(([name, summary]) => (
              <li key={name} className="flex items-center gap-2">
                <span className="w-40 font-medium">{name}</span>
                <StatusBadge value={summary} />
              </li>
            ))}
            {Object.keys(status.agents).length === 0 && (
              <li className="text-ink-dim">no agents registered</li>
            )}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Drift / orphan alerts</h2>
        {state.live.alerts.length === 0 ? (
          <p className="text-sm text-ink-dim">none this session</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="system-alerts-list">
            {state.live.alerts
              .slice()
              .reverse()
              .map((alert, index) => (
                <li key={index} className="rounded border border-warn/40 bg-warn/10 px-2 py-1">
                  <span className="font-mono text-xs text-ink-dim">{alert.ts}</span>{' '}
                  <span className="font-medium">{alert.kind}</span>
                  {alert.agent && <span> — {alert.agent}</span>}
                  <span className="ml-2 font-mono text-xs text-ink-dim">{alert.detail}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-ink-dim">no jobs yet</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="system-jobs-table">
            <thead>
              <tr className="border-b border-edge text-left text-xs uppercase tracking-wide text-ink-dim">
                <th className="px-2 py-1.5">id</th>
                <th className="px-2 py-1.5">kind</th>
                <th className="px-2 py-1.5">agent</th>
                <th className="px-2 py-1.5">state</th>
                <th className="px-2 py-1.5">created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <>
                  <tr
                    key={job.id}
                    className="cursor-pointer border-b border-edge/60 hover:bg-panel"
                    onClick={() => setExpanded(expanded === job.id ? null : job.id)}
                    data-testid={`system-job-${job.id}-row`}
                  >
                    <td className="px-2 py-1.5 font-mono text-xs">{job.id}</td>
                    <td className="px-2 py-1.5">{job.kind}</td>
                    <td className="px-2 py-1.5">{job.agent}</td>
                    <td className="px-2 py-1.5">
                      <StatusBadge value={job.state} />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs">{job.created_at}</td>
                  </tr>
                  {expanded === job.id && (
                    <tr key={`${job.id}-detail`}>
                      <td colSpan={5} className="px-2 py-2">
                        <JobProgressCard jobId={job.id} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Unrecognized events (forward compatibility)</h2>
        {state.live.eventLog.length === 0 ? (
          <p className="text-sm text-ink-dim">none</p>
        ) : (
          <ul
            className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-xs"
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
      </section>
    </div>
  )
}
