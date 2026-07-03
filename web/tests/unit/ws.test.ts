/** WPT-4 — WS lifecycle: connect→onConnected, reconnect with backoff,
 * frame parsing tolerance, stop() cancels everything. Fake sockets/timers. */
import { describe, expect, it, vi } from 'vitest'

import {
  backoffDelay,
  BACKOFF_MAX_MS,
  parseEventFrame,
  startEventStream,
  type SocketLike,
} from '../../src/api/ws'

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  close(): void {
    this.closed = true
  }
}

describe('event stream', () => {
  it('parses valid frames and drops garbage', () => {
    expect(
      parseEventFrame(JSON.stringify({ kind: 'job.done', agent: 'a', data: {}, ts: 't' })),
    ).toEqual({ kind: 'job.done', agent: 'a', data: {}, ts: 't' })
    expect(parseEventFrame('not json')).toBeNull()
    expect(parseEventFrame(JSON.stringify({ nope: 1 }))).toBeNull()
    expect(parseEventFrame(12)).toBeNull()
  })

  it('backoff grows exponentially and caps at 30s', () => {
    expect(backoffDelay(0)).toBe(1000)
    expect(backoffDelay(1)).toBe(2000)
    expect(backoffDelay(10)).toBe(BACKOFF_MAX_MS)
  })

  it('runs the connect → refetch → events → reconnect sequence', () => {
    const sockets: FakeSocket[] = []
    const events: string[] = []
    const statuses: string[] = []
    const onConnected = vi.fn()
    const timers: (() => void)[] = []

    const handle = startEventStream({
      url: () => 'ws://test/api/events?token=x',
      onEvent: (event) => events.push(event.kind),
      onStatus: (status) => statuses.push(status),
      onConnected,
      socketFactory: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      setTimeoutFn: (fn) => {
        timers.push(fn)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => undefined,
    })

    expect(sockets).toHaveLength(1)
    sockets[0]!.onopen?.()
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(statuses).toContain('connected')

    sockets[0]!.onmessage?.({
      data: JSON.stringify({ kind: 'health.changed', agent: 'a', data: {}, ts: 't' }),
    })
    sockets[0]!.onmessage?.({ data: 'garbage' })
    expect(events).toEqual(['health.changed'])

    // drop → reconnect scheduled → new socket → reconnected
    sockets[0]!.onclose?.()
    expect(statuses).toContain('reconnecting')
    expect(timers).toHaveLength(1)
    timers[0]!()
    expect(sockets).toHaveLength(2)
    sockets[1]!.onopen?.()
    expect(onConnected).toHaveBeenCalledTimes(2)

    handle.stop()
    expect(sockets[1]!.closed).toBe(true)
    // stopped stream never reconnects
    sockets[1]!.onclose?.()
    expect(sockets).toHaveLength(2)
  })
})
