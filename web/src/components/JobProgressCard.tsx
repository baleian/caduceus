/** Live job progress (S-U4-1): primary source is the WS-fed reducer state;
 * while the socket is down, a visibility-aware poll of GET /api/jobs/{id}
 * fills in (S-U4-1.6). Steps render ✓ / ✗ / spinner, failures show the
 * redacted reason plus the no-rollback guidance. */

import { useEffect, useState, type ReactNode } from 'react'

import type { JobLive } from '../lib/reducer'
import type { JobSnapshot } from '../lib/types'
import { useApp } from '../state/AppStore'
import { usePolling } from '../state/usePolling'

function fromSnapshot(snapshot: JobSnapshot): JobLive {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    agent: snapshot.agent,
    state: snapshot.state === 'failed' ? 'failed' : snapshot.state === 'done' ? 'done' : 'running',
    steps: snapshot.steps,
    error: snapshot.error,
  }
}

const STEP_MARK: Record<string, string> = { ok: '✓', failed: '✗', running: '⟳', pending: '·' }

export function JobProgressCard(props: { jobId: string; onDone?: () => void }): ReactNode {
  const { client, state } = useApp()
  const [polled, setPolled] = useState<JobLive | null>(null)

  const live = state.live.jobs[props.jobId] ?? polled
  const finished = live?.state === 'done' || live?.state === 'failed'
  const wsDown = state.connection !== 'connected'

  usePolling(
    async () => {
      try {
        setPolled(fromSnapshot(await client.getJob(props.jobId)))
      } catch {
        // job may not be visible yet; keep polling until finished
      }
    },
    1_500,
    wsDown && !finished,
  )

  const { onDone } = props
  useEffect(() => {
    if (finished) onDone?.()
  }, [finished, onDone])

  if (!live) {
    return (
      <div
        data-testid="job-progress-card"
        className="rounded border border-edge bg-panel p-3 text-sm"
      >
        job {props.jobId} — waiting for progress…
      </div>
    )
  }

  return (
    <div data-testid="job-progress-card" className="rounded border border-edge bg-panel p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="font-medium">
          {live.kind} {live.agent ?? ''}
        </span>
        <span
          data-testid="job-progress-state"
          className={
            live.state === 'done'
              ? 'text-ok'
              : live.state === 'failed'
                ? 'text-bad'
                : 'text-ink-dim'
          }
        >
          {live.state}
        </span>
      </div>
      <ul className="space-y-0.5 text-sm">
        {live.steps.map((step) => (
          <li key={step.name} className="flex items-center gap-2">
            <span
              className={
                step.state === 'ok'
                  ? 'text-ok'
                  : step.state === 'failed'
                    ? 'text-bad'
                    : 'animate-pulse text-ink-dim'
              }
            >
              {STEP_MARK[step.state] ?? '·'}
            </span>
            <span className={step.state === 'failed' ? 'text-bad' : ''}>{step.name}</span>
          </li>
        ))}
      </ul>
      {live.state === 'failed' && (
        <p data-testid="job-progress-error" className="mt-2 text-sm text-bad">
          {live.error ?? 'failed'} — no automatic rollback; remove the agent to clean up (the
          workspace is preserved).
        </p>
      )}
    </div>
  )
}
