/** WS CoreEvent → AppState reducer (WPT-3/PU4-3 — pure, idempotent).
 *
 * Idempotence contract: replay + live overlap must not corrupt state, so every
 * branch overwrites keyed slots (no increments keyed on event receipt except
 * the bounded recent-request list, which dedups by (ts, agent)). Unknown kinds
 * land in the event log only (forward compatibility). Bounded invariants:
 * recentRequests ≤ RECENT_LIMIT, eventLog ≤ EVENT_LOG_LIMIT, alerts ≤ ALERT_LIMIT.
 */

import type { ActiveAlert, CoreEvent } from './types'

export const RECENT_LIMIT = 100
export const EVENT_LOG_LIMIT = 500
export const ALERT_LIMIT = 100

export interface AgentLive {
  process?: string
  health?: string
}

export interface JobLive {
  id: string
  kind: string
  agent: string | null
  state: 'running' | 'failed' | 'done'
  steps: { name: string; state: string }[]
  error: string | null
}

export interface RecentRequest {
  ts: string
  agent: string | null
  model: string
  status: number
  latencyMs: number
}

export interface Alert {
  ts: string
  kind: string
  agent: string | null
  detail: string
}

export interface LiveState {
  agents: Record<string, AgentLive>
  /** set when a create/remove job finished — the shell refetches the agent list */
  agentsStale: boolean
  jobs: Record<string, JobLive>
  recentRequests: RecentRequest[]
  alerts: Alert[]
  eventLog: CoreEvent[]
}

export const initialLiveState: LiveState = {
  agents: {},
  agentsStale: false,
  jobs: {},
  recentRequests: [],
  alerts: [],
  eventLog: [],
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function bounded<T>(list: T[], limit: number): T[] {
  return list.length > limit ? list.slice(list.length - limit) : list
}

/** Condition identity — MUST match the daemon's alerts-snapshot key rule:
 * "drift:{agent}:{reason}" / "orphan:{resource}:{name}". */
export function conditionKey(event: CoreEvent): string | null {
  if (event.kind === 'drift.detected' || event.kind === 'drift.remediated') {
    // remediation only exists for dead gateways (reconciler R5)
    const reason =
      event.kind === 'drift.remediated' ? 'gateway-not-running' : str(event.data['reason'])
    return event.agent && reason ? `drift:${event.agent}:${reason}` : null
  }
  if (event.kind === 'orphan.detected') {
    const resource = str(event.data['resource'])
    const name = str(event.data['name'])
    return resource && name ? `orphan:${resource}:${name}` : null
  }
  return null
}

export function activeAlertFromEvent(event: CoreEvent, key: string): ActiveAlert {
  if (event.kind === 'orphan.detected') {
    return {
      key,
      kind: 'orphan',
      since: event.ts,
      resource: str(event.data['resource']),
      name: str(event.data['name']),
    }
  }
  const keys = Array.isArray(event.data['keys'])
    ? (event.data['keys'] as unknown[]).filter((k): k is string => typeof k === 'string')
    : undefined
  return {
    key,
    kind: 'drift',
    since: event.ts,
    agent: event.agent ?? undefined,
    reason: str(event.data['reason']),
    ...(keys ? { keys } : {}),
  }
}

export function alertLabel(alert: ActiveAlert): string {
  if (alert.kind === 'orphan') {
    return `orphan ${alert.resource ?? ''} — ${alert.name ?? ''}`
  }
  return `drift — ${alert.agent ?? '?'} (${alert.reason ?? ''})`
}

function applyJob(state: LiveState, event: CoreEvent): LiveState {
  const jobId = str(event.data['job_id'])
  if (!jobId) return state
  const existing = state.jobs[jobId] ?? {
    id: jobId,
    kind: str(event.data['kind']),
    agent: event.agent,
    state: 'running' as const,
    steps: [],
    error: null,
  }
  const job: JobLive = { ...existing, steps: [...existing.steps] }
  if (event.kind === 'job.step') {
    const stepName = str(event.data['step'])
    const stepState = str(event.data['state'])
    const index = job.steps.findIndex((s) => s.name === stepName)
    if (index === -1) job.steps.push({ name: stepName, state: stepState })
    else job.steps[index] = { name: stepName, state: stepState } // idempotent overwrite
  } else if (event.kind === 'job.failed') {
    job.state = 'failed'
    job.error = str(event.data['error'], 'failed')
    const stepName = str(event.data['step'])
    const index = job.steps.findIndex((s) => s.name === stepName)
    if (index !== -1) job.steps[index] = { name: stepName, state: 'failed' }
  } else if (event.kind === 'job.done') {
    job.state = 'done'
  }
  const finished = event.kind === 'job.done' || event.kind === 'job.failed'
  const structural = job.kind === 'create' || job.kind === 'remove'
  return {
    ...state,
    jobs: { ...state.jobs, [jobId]: job },
    agentsStale: state.agentsStale || (finished && structural),
  }
}

export function reduceEvent(state: LiveState, event: CoreEvent): LiveState {
  switch (event.kind) {
    case 'job.step':
    case 'job.failed':
    case 'job.done':
      return applyJob(state, event)
    case 'process.state': {
      if (!event.agent) return state
      const current = state.agents[event.agent] ?? {}
      return {
        ...state,
        agents: {
          ...state.agents,
          [event.agent]: { ...current, process: str(event.data['state'], 'unknown') },
        },
      }
    }
    case 'health.changed': {
      if (!event.agent) return state
      const current = state.agents[event.agent] ?? {}
      return {
        ...state,
        agents: {
          ...state.agents,
          [event.agent]: { ...current, health: str(event.data['to'], 'unknown') },
        },
      }
    }
    case 'traffic.request': {
      const entry: RecentRequest = {
        ts: event.ts,
        agent: event.agent,
        model: str(event.data['model']),
        status: num(event.data['status']),
        latencyMs: num(event.data['latency_ms']),
      }
      // replay overlap dedup: identical (ts, agent, model) is the same request
      if (
        state.recentRequests.some(
          (r) => r.ts === entry.ts && r.agent === entry.agent && r.model === entry.model,
        )
      ) {
        return state
      }
      return {
        ...state,
        recentRequests: bounded([...state.recentRequests, entry], RECENT_LIMIT),
      }
    }
    case 'drift.detected':
    case 'drift.remediated':
    case 'orphan.detected': {
      const alert: Alert = {
        ts: event.ts,
        kind: event.kind,
        agent: event.agent,
        detail: JSON.stringify(event.data),
      }
      if (
        state.alerts.some(
          (a) => a.ts === alert.ts && a.kind === alert.kind && a.agent === alert.agent,
        )
      ) {
        return state
      }
      return { ...state, alerts: bounded([...state.alerts, alert], ALERT_LIMIT) }
    }
    case 'events.synced':
      // replay/live boundary marker — a shell-level signal, never history
      return state
    default: {
      // unknown kinds: event log only (forward compatibility)
      if (
        state.eventLog.some(
          (e) => e.ts === event.ts && e.kind === event.kind && e.agent === event.agent,
        )
      ) {
        return state
      }
      return { ...state, eventLog: bounded([...state.eventLog, event], EVENT_LOG_LIMIT) }
    }
  }
}

/** Shell acknowledges the refetch triggered by agentsStale. */
export function clearAgentsStale(state: LiveState): LiveState {
  return state.agentsStale ? { ...state, agentsStale: false } : state
}
