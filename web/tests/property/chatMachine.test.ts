/** PU4-2 — chat state machine invariants over arbitrary event sequences:
 * ≤1 stop per turn, start_turn only from idle, unknown pairs are no-ops,
 * stream_end always recovers to idle. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { transition, type ChatEvent, type ChatState } from '../../src/lib/chatMachine'

const STATES: ChatState[] = ['idle', 'streaming', 'stopping', 'awaiting_approval']
const EVENTS: ChatEvent[] = [
  'interrupt',
  'eof',
  'user_message',
  'approval_request',
  'approval_answered',
  'stream_end',
]

const chatEvent = fc.constantFrom(...EVENTS)

describe('PU4-2 chat state machine', () => {
  it('is total and closed over the vocabulary', () => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        const [next, action] = transition(state, event)
        expect(STATES).toContain(next)
        expect(typeof action).toBe('string')
      }
    }
  })

  it('sends at most one stop per turn and only starts turns from idle', () => {
    fc.assert(
      fc.property(fc.array(chatEvent, { maxLength: 60 }), (events) => {
        let state: ChatState = 'idle'
        let stopsThisTurn = 0
        for (const event of events) {
          const before = state
          const [next, action] = transition(state, event)
          if (action === 'start_turn') {
            expect(before).toBe('idle')
            expect(event).toBe('user_message')
            stopsThisTurn = 0
          }
          if (action === 'send_stop') {
            stopsThisTurn += 1
            expect(stopsThisTurn).toBeLessThanOrEqual(1)
          }
          state = next
          if (state === 'idle') stopsThisTurn = 0
        }
      }),
    )
  })

  it('stream_end recovers to idle from any active state', () => {
    for (const state of ['streaming', 'stopping', 'awaiting_approval'] as const) {
      expect(transition(state, 'stream_end')[0]).toBe('idle')
    }
  })

  it('idle interrupt is a UI no-op (no exit action)', () => {
    expect(transition('idle', 'interrupt')).toEqual(['idle', 'none'])
  })
})
