/** Live job progress (S-U4-1): primary source is the WS-fed reducer state;
 * while the socket is down, a visibility-aware poll of GET /api/jobs/{id}
 * fills in (S-U4-1.6). Steps render ✓ / ✗ / spinner, failures show the
 * redacted reason plus the no-rollback guidance. */

import { Check, Dot, Loader2, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { JobLive } from '../lib/reducer'
import type { JobSnapshot } from '../lib/types'
import { useApp } from '../state/AppStore'
import { usePolling } from '../state/usePolling'
import { Card } from './ui/Card'

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

function StepMark(props: { state: string }): ReactNode {
  if (props.state === 'ok') return <Check size={14} className="text-ok" aria-label="ok" />
  if (props.state === 'failed') return <X size={14} className="text-bad" aria-label="failed" />
  if (props.state === 'running')
    return <Loader2 size={14} className="animate-spin text-accent" aria-label="running" />
  return <Dot size={14} className="text-ink-faint" aria-label="pending" />
}

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
      <Card testId="job-progress-card" className="text-sm text-ink-dim">
        <span className="inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          job {props.jobId} — waiting for progress…
        </span>
      </Card>
    )
  }

  return (
    <Card testId="job-progress-card">
      <div className="mb-2 flex items-center gap-2.5 text-sm">
        <span className="font-medium">
          {live.kind} {live.agent ?? ''}
        </span>
        {/* keep the state as plain text for the E2E toHaveText contract */}
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
      <ul className="space-y-1 text-sm">
        {live.steps.map((step) => (
          <li key={step.name} className="flex items-center gap-2">
            <StepMark state={step.state} />
            <span className={step.state === 'failed' ? 'text-bad' : 'text-ink-dim'}>
              {step.name}
            </span>
          </li>
        ))}
      </ul>
      {live.state === 'failed' && (
        <p data-testid="job-progress-error" className="mt-2 text-sm text-bad">
          {live.error ?? 'failed'} — no automatic rollback; remove the agent to clean up (the
          workspace is preserved).
        </p>
      )}
    </Card>
  )
}
