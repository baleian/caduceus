/** Shell reducer + auth/prefs pure parts. */
import { describe, expect, it } from 'vitest'

import { initialShellState, shellReducer, type ShellState } from '../../src/state/AppStore'
import { tokenFromHash } from '../../src/state/auth'
import { isDark } from '../../src/state/prefs'
import type { CoreEvent } from '../../src/lib/types'

const drift = (agent: string, ts: string): CoreEvent => ({
  kind: 'drift.detected',
  agent,
  data: { reason: 'gateway-not-running' },
  ts,
})
const orphan = (name: string, ts: string): CoreEvent => ({
  kind: 'orphan.detected',
  agent: null,
  data: { resource: 'profile', name },
  ts,
})
const SYNCED: CoreEvent = { kind: 'events.synced', agent: null, data: {}, ts: 'sync' }

function apply(state: ShellState, ...events: CoreEvent[]): ShellState {
  return events.reduce((s, event) => shellReducer(s, { type: 'ws-event', event }), state)
}

describe('shellReducer alert policy (alert-ux)', () => {
  it('replayed drift/orphan events land in history but never toast', () => {
    const state = apply(initialShellState, drift('a1', 't1'), orphan('cad-x', 't2'))
    expect(state.live.alerts).toHaveLength(2) // System board history (FR-5)
    expect(state.toasts).toHaveLength(0) // FR-2
    expect(state.activeAlerts).toEqual({})
    expect(state.synced).toBe(false)
  })

  it('events.synced flips synced without touching history or event log', () => {
    const state = apply(initialShellState, SYNCED)
    expect(state.synced).toBe(true)
    expect(state.live.alerts).toHaveLength(0)
    expect(state.live.eventLog).toHaveLength(0) // NFR-1: not "unrecognized"
  })

  it('post-sync detection toasts once per condition, then stays silent', () => {
    let state = apply(initialShellState, SYNCED, drift('a1', 't1'))
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0]!.tone).toBe('warn')
    expect(Object.keys(state.activeAlerts)).toEqual(['drift:a1:gateway-not-running'])

    // reconciler re-detects the same condition every cycle → no re-toast
    state = apply(state, drift('a1', 't2'), drift('a1', 't3'))
    expect(state.toasts).toHaveLength(1)
    expect(state.live.alerts).toHaveLength(3) // history still accumulates
  })

  it('drift.remediated clears the condition and toasts info', () => {
    let state = apply(initialShellState, SYNCED, drift('a1', 't1'))
    state = apply(state, {
      kind: 'drift.remediated',
      agent: 'a1',
      data: { action: 'gateway-restarted' },
      ts: 't2',
    })
    expect(state.activeAlerts).toEqual({})
    expect(state.toasts).toHaveLength(2)
    expect(state.toasts.at(-1)!.tone).toBe('info')
  })

  it('alerts-snapshot replaces the active set and toasts only unseen keys', () => {
    // first load: empty map → every active condition toasts once (FR-3)
    let state = shellReducer(initialShellState, {
      type: 'alerts-snapshot',
      snapshot: {
        alerts: [
          { key: 'drift:a1:managed-config-drift', kind: 'drift', agent: 'a1',
            reason: 'managed-config-drift', since: 's1' },
          { key: 'orphan:profile:cad-x', kind: 'orphan', resource: 'profile',
            name: 'cad-x', since: 's2' },
        ],
        checked_at: 'c1',
      },
    })
    expect(state.toasts).toHaveLength(2)

    // re-poll: one resolved, one persisting, nothing new → no toast, map shrinks
    state = shellReducer(state, {
      type: 'alerts-snapshot',
      snapshot: {
        alerts: [
          { key: 'orphan:profile:cad-x', kind: 'orphan', resource: 'profile',
            name: 'cad-x', since: 's2' },
        ],
        checked_at: 'c2',
      },
    })
    expect(state.toasts).toHaveLength(2)
    expect(Object.keys(state.activeAlerts)).toEqual(['orphan:profile:cad-x'])
  })

  it('snapshot-known conditions do not re-toast when live events repeat them', () => {
    let state = shellReducer(initialShellState, {
      type: 'alerts-snapshot',
      snapshot: {
        alerts: [
          { key: 'drift:a1:gateway-not-running', kind: 'drift', agent: 'a1',
            reason: 'gateway-not-running', since: 's1' },
        ],
        checked_at: 'c1',
      },
    })
    expect(state.toasts).toHaveLength(1)
    state = apply(state, SYNCED, drift('a1', 't9'))
    expect(state.toasts).toHaveLength(1)
  })

  it('reconnect invalidates synced so the next replay stays silent', () => {
    let state = shellReducer(initialShellState, { type: 'connection', status: 'connected' })
    state = apply(state, SYNCED)
    expect(state.synced).toBe(true)
    state = shellReducer(state, { type: 'connection', status: 'reconnecting' }) // drop
    expect(state.synced).toBe(false)
    state = apply(state, drift('a1', 't1')) // replayed on the new socket
    expect(state.toasts).toHaveLength(0)
  })

  it('caps toast count', () => {
    let state = initialShellState
    for (let i = 0; i < 10; i++) {
      state = shellReducer(state, { type: 'toast', toast: { id: i, tone: 'info', text: `${i}` } })
    }
    expect(state.toasts.length).toBeLessThanOrEqual(5)
    expect(state.toasts.at(-1)!.text).toBe('9')
  })

  it('connection updates are no-ops when unchanged', () => {
    const once = shellReducer(initialShellState, { type: 'connection', status: 'connected' })
    expect(shellReducer(once, { type: 'connection', status: 'connected' })).toBe(once)
  })
})

describe('auth fragment', () => {
  it('parses only the exact #token= form', () => {
    expect(tokenFromHash('#token=abc123')).toBe('abc123')
    expect(tokenFromHash('#token=a%2Fb')).toBe('a/b')
    expect(tokenFromHash('#other=1')).toBeNull()
    expect(tokenFromHash('')).toBeNull()
    expect(tokenFromHash('#token=')).toBeNull()
  })
})

describe('theme', () => {
  it('resolves system preference only for the system setting', () => {
    expect(isDark('system', true)).toBe(true)
    expect(isDark('system', false)).toBe(false)
    expect(isDark('dark', false)).toBe(true)
    expect(isDark('light', true)).toBe(false)
  })
})
