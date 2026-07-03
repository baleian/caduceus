/** Shell reducer + auth/prefs pure parts. */
import { describe, expect, it } from 'vitest'

import { initialShellState, shellReducer } from '../../src/state/AppStore'
import { tokenFromHash } from '../../src/state/auth'
import { isDark } from '../../src/state/prefs'

describe('shellReducer', () => {
  it('routes ws events through the live reducer and toasts drift alerts', () => {
    const state = shellReducer(initialShellState, {
      type: 'ws-event',
      event: { kind: 'drift.detected', agent: 'a1', data: {}, ts: 't1' },
    })
    expect(state.live.alerts).toHaveLength(1)
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0]!.tone).toBe('warn')
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
