/** api_server relay helpers (S2/W7): the native-endpoint composition verified
 * in U3 — sessions listing/creation, message hydration (single source of
 * truth), the /v1/runs turn flow, live SSE consumption, stop and approval. */

import { createSseParser } from '../lib/sse'
import type { SessionInfo, SessionMessage } from '../lib/types'
import type { ApiClient } from './client'

export async function listSessions(client: ApiClient, agent: string): Promise<SessionInfo[]> {
  const listing = await client.agentApi<{ data?: unknown[] }>(agent, 'GET', 'api/sessions')
  const sessions = (listing.data ?? []).filter(
    (s): s is SessionInfo =>
      !!s && typeof s === 'object' && typeof (s as SessionInfo).id === 'string',
  )
  sessions.sort((a, b) =>
    String(a.last_active ?? a.started_at ?? '').localeCompare(
      String(b.last_active ?? b.started_at ?? ''),
    ),
  )
  return sessions.reverse() // most recent first
}

export async function createSession(client: ApiClient, agent: string): Promise<string> {
  const created = await client.agentApi<{ session: { id: string } }>(
    agent,
    'POST',
    'api/sessions',
    {},
  )
  return String(created.session.id)
}

export function renameSession(
  client: ApiClient,
  agent: string,
  sessionId: string,
  title: string,
): Promise<unknown> {
  return client.agentApi(agent, 'PATCH', `api/sessions/${encodeURIComponent(sessionId)}`, {
    title,
  })
}

export function deleteSession(
  client: ApiClient,
  agent: string,
  sessionId: string,
): Promise<unknown> {
  return client.agentApi(agent, 'DELETE', `api/sessions/${encodeURIComponent(sessionId)}`)
}

/** W7 — the hydration call: history is always re-read from the agent. */
export async function fetchMessages(
  client: ApiClient,
  agent: string,
  sessionId: string,
): Promise<SessionMessage[]> {
  const listing = await client.agentApi<{ data?: unknown[] }>(
    agent,
    'GET',
    `api/sessions/${encodeURIComponent(sessionId)}/messages`,
  )
  return (listing.data ?? []).filter(
    (m): m is SessionMessage => !!m && typeof m === 'object' && !Array.isArray(m),
  )
}

export async function startRun(
  client: ApiClient,
  agent: string,
  body: {
    input: string
    session_id: string
    conversation_history: { role: string; content: string }[]
  },
): Promise<string> {
  const started = await client.agentApi<{ run_id: string }>(agent, 'POST', 'v1/runs', body)
  return String(started.run_id)
}

export function stopRun(client: ApiClient, agent: string, runId: string): Promise<unknown> {
  return client.agentApi(agent, 'POST', `v1/runs/${encodeURIComponent(runId)}/stop`)
}

export function sendApproval(
  client: ApiClient,
  agent: string,
  runId: string,
  choice: string,
): Promise<unknown> {
  return client.agentApi(agent, 'POST', `v1/runs/${encodeURIComponent(runId)}/approval`, {
    choice,
  })
}

export interface RunStreamEvent {
  /** payload.event — message.delta / reasoning.available / tool.* / … */
  kind: string
  payload: Record<string, unknown>
}

/** Consume GET /v1/runs/{id}/events (data-only SSE; the event name lives
 * inside the JSON payload). Garbled frames are dropped (PU4-1 posture). */
export async function streamRunEvents(
  client: ApiClient,
  agent: string,
  runId: string,
  onEvent: (event: RunStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.agentApiStream(
    agent,
    `v1/runs/${encodeURIComponent(runId)}/events`,
    signal,
  )
  const reader = response.body?.getReader()
  if (!reader) return
  const parser = createSseParser()
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch {
      return // stream cut — caller recovers to idle (U4-REL-2)
    }
    if (chunk.done) return
    for (const sse of parser.push(chunk.value)) {
      let payload: unknown
      try {
        payload = JSON.parse(sse.data)
      } catch {
        continue
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
      const record = payload as Record<string, unknown>
      const kind = typeof record['event'] === 'string' ? record['event'] : ''
      onEvent({ kind, payload: record })
    }
  }
}
