/** PU4-3 — event reducer: consecutive-duplicate idempotence, full-stream
 * replay convergence (WS replay + live overlap), bounded invariants.
 * Plus alert-ux toast-policy invariants over arbitrary interleavings. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  ALERT_LIMIT,
  EVENT_LOG_LIMIT,
  initialLiveState,
  RECENT_LIMIT,
  reduceEvent,
  type LiveState,
} from '../../src/lib/reducer'
import { initialShellState, shellReducer, type ShellAction } from '../../src/state/AppStore'
import type { CoreEvent } from '../../src/lib/types'

const KNOWN_KINDS = [
  'job.step',
  'job.failed',
  'job.done',
  'process.state',
  'health.changed',
  'traffic.request',
  'drift.detected',
  'orphan.detected',
]

let tsCounter = 0

const coreEvent: fc.Arbitrary<CoreEvent> = fc
  .record({
    kind: fc.oneof(fc.constantFrom(...KNOWN_KINDS), fc.stringMatching(/^[a-z.]{1,12}$/)),
    agent: fc.option(fc.constantFrom('a1', 'a2', 'a3'), { nil: null }),
    jobId: fc.constantFrom('j1', 'j2', 'j3'),
    jobKind: fc.constantFrom('create', 'remove', 'other'),
    step: fc.constantFrom('validate', 'registry-add', 'profile', 'start'),
    stepState: fc.constantFrom('running', 'ok'),
    to: fc.constantFrom('healthy', 'unhealthy', 'unreachable'),
    state: fc.constantFrom('running', 'stopped', 'exited'),
    model: fc.constantFrom('m1', 'm2'),
  })
  .map(({ kind, agent, jobId, jobKind, step, stepState, to, state, model }) => ({
    kind,
    agent,
    data: {
      job_id: jobId,
      kind: jobKind,
      step,
      state: kind === 'process.state' ? state : stepState,
      to,
      model,
      status: 200,
      latency_ms: 10,
      error: 'boom',
    },
    ts: `2026-07-03T00:00:${String(tsCounter++ % 60).padStart(2, '0')}Z-${tsCounter}`,
  }))

function fold(state: LiveState, events: readonly CoreEvent[]): LiveState {
  return events.reduce(reduceEvent, state)
}

describe('PU4-3 live-state reducer', () => {
  it('is idempotent for consecutive duplicates', () => {
    fc.assert(
      fc.property(fc.array(coreEvent, { maxLength: 30 }), fc.nat(29), (events, at) => {
        if (events.length === 0) return
        const target = events[at % events.length]!
        const base = fold(initialLiveState, events.slice(0, (at % events.length) + 1))
        expect(reduceEvent(base, target)).toEqual(base)
      }),
    )
  })

  it('converges when the whole ordered stream is replayed (WS reconnect)', () => {
    fc.assert(
      fc.property(fc.array(coreEvent, { maxLength: 40 }), (events) => {
        const once = fold(initialLiveState, events)
        const twice = fold(initialLiveState, [...events, ...events])
        expect(twice).toEqual(once)
      }),
    )
  })

  it('never exceeds bounded structure limits and never throws', () => {
    fc.assert(
      fc.property(fc.array(coreEvent, { maxLength: 200 }), (events) => {
        const state = fold(initialLiveState, events)
        expect(state.recentRequests.length).toBeLessThanOrEqual(RECENT_LIMIT)
        expect(state.alerts.length).toBeLessThanOrEqual(ALERT_LIMIT)
        expect(state.eventLog.length).toBeLessThanOrEqual(EVENT_LOG_LIMIT)
      }),
    )
  })

  it('marks agents stale only when a structural job finishes', () => {
    const done: CoreEvent = {
      kind: 'job.done',
      agent: 'a1',
      data: { job_id: 'j1', kind: 'create' },
      ts: 't1',
    }
    expect(reduceEvent(initialLiveState, done).agentsStale).toBe(true)
    const other: CoreEvent = { ...done, data: { job_id: 'j2', kind: 'other' } }
    expect(reduceEvent(initialLiveState, other).agentsStale).toBe(false)
  })
})

// -- alert-ux: toast policy under arbitrary replay/marker/live/snapshot mixes --

const AGENTS = ['a1', 'a2'] as const
const keyOf = (agent: string): string => `drift:${agent}:gateway-not-running`

let shellTs = 0
const shellAlertAction: fc.Arbitrary<ShellAction> = fc.oneof(
  fc
    .record({
      agent: fc.constantFrom(...AGENTS),
      kind: fc.constantFrom('drift.detected', 'drift.remediated') as fc.Arbitrary<
        'drift.detected' | 'drift.remediated'
      >,
    })
    .map(
      ({ agent, kind }): ShellAction => ({
        type: 'ws-event',
        event: {
          kind,
          agent,
          data:
            kind === 'drift.detected'
              ? { reason: 'gateway-not-running' }
              : { action: 'gateway-restarted' },
          ts: `t${shellTs++}`,
        },
      }),
    ),
  fc.constant<ShellAction>({
    type: 'ws-event',
    event: { kind: 'events.synced', agent: null, data: {}, ts: 'sync' },
  }),
  fc.uniqueArray(fc.constantFrom(...AGENTS)).map(
    (agents): ShellAction => ({
      type: 'alerts-snapshot',
      snapshot: {
        alerts: agents.map((agent) => ({
          key: keyOf(agent),
          kind: 'drift' as const,
          agent,
          reason: 'gateway-not-running',
          since: 's1',
        })),
        checked_at: 'c1',
      },
    }),
  ),
  fc.constantFrom('connected' as const, 'reconnecting' as const, 'down' as const).map(
    (status): ShellAction => ({ type: 'connection', status }),
  ),
)

describe('alert-ux shell toast policy', () => {
  it('holds its invariants under arbitrary interleavings', () => {
    fc.assert(
      fc.property(fc.array(shellAlertAction, { maxLength: 80 }), (actions) => {
        let state = initialShellState
        for (const action of actions) {
          const next = shellReducer(state, action)
          const toastAdded = next.toasts !== state.toasts
          if (action.type === 'ws-event') {
            // pre-sync (replay) events NEVER toast — FR-2
            if (!state.synced) expect(toastAdded).toBe(false)
            // an already-active condition never re-toasts — FR-4
            if (
              state.synced &&
              action.event.kind === 'drift.detected' &&
              keyOf(action.event.agent!) in state.activeAlerts
            ) {
              expect(toastAdded).toBe(false)
            }
            // the marker is never history — NFR-1
            expect(next.live.eventLog.every((e) => e.kind !== 'events.synced')).toBe(true)
          }
          if (action.type === 'alerts-snapshot') {
            // snapshot is authoritative: active set == snapshot keys exactly
            expect(Object.keys(next.activeAlerts).sort()).toEqual(
              action.snapshot.alerts.map((a) => a.key).sort(),
            )
          }
          expect(next.live.alerts.length).toBeLessThanOrEqual(ALERT_LIMIT)
          expect(next.toasts.length).toBeLessThanOrEqual(5)
          state = next
        }
      }),
    )
  })
})
