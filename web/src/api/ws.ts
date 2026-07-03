/** WS /api/events lifecycle (WPT-4): exponential backoff reconnect
 * (1s→2s→…≤30s); on every (re)connect the shell refetches REST snapshots and
 * the replayed events converge through the idempotent reducer. The socket
 * factory and timers are injectable (WPT-10). */

import type { CoreEvent } from '../lib/types'

export type ConnectionStatus = 'connected' | 'reconnecting' | 'down'

export interface SocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  close(): void
}

export interface EventStreamOptions {
  url: () => string
  onEvent: (event: CoreEvent) => void
  onStatus: (status: ConnectionStatus) => void
  /** fired after each successful (re)connect — REST snapshot refetch */
  onConnected: () => void
  socketFactory?: (url: string) => SocketLike
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void
}

export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 30_000

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS)
}

export function parseEventFrame(data: unknown): CoreEvent | null {
  if (typeof data !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (typeof record['kind'] !== 'string') return null
  return {
    kind: record['kind'],
    agent: typeof record['agent'] === 'string' ? record['agent'] : null,
    data:
      record['data'] && typeof record['data'] === 'object'
        ? (record['data'] as Record<string, unknown>)
        : {},
    ts: typeof record['ts'] === 'string' ? record['ts'] : '',
  }
}

export interface EventStreamHandle {
  stop(): void
}

export function startEventStream(options: EventStreamOptions): EventStreamHandle {
  const socketFactory =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
  const schedule = options.setTimeoutFn ?? setTimeout
  const cancel = options.clearTimeoutFn ?? clearTimeout

  let stopped = false
  let attempt = 0
  let socket: SocketLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function connect(): void {
    if (stopped) return
    socket = socketFactory(options.url())
    socket.onopen = () => {
      attempt = 0
      options.onStatus('connected')
      options.onConnected()
    }
    socket.onmessage = (event) => {
      const parsed = parseEventFrame(event.data)
      if (parsed) options.onEvent(parsed)
    }
    const retry = () => {
      if (stopped) return
      options.onStatus(attempt >= 3 ? 'down' : 'reconnecting')
      timer = schedule(connect, backoffDelay(attempt))
      attempt += 1
    }
    socket.onclose = retry
    socket.onerror = () => {
      // onclose follows onerror in browsers; guard for fakes that only error
    }
  }

  connect()

  return {
    stop() {
      stopped = true
      if (timer) cancel(timer)
      if (socket) {
        socket.onclose = null
        socket.close()
      }
    },
  }
}
