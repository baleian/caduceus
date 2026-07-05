/** chat-streaming-order S4 — the live-turn reducers fold streaming events into
 * an event-ordered segment list. Properties: order preservation + delta
 * coalescing (the core fix), tool-completion matching, reply-fallback gating,
 * totality/immutability. Mirrors how ChatView.consumeStream wires each event. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  addNote,
  appendReasoning,
  appendText,
  completeTool,
  EMPTY_TURN,
  fallbackText,
  startTool,
  turnHasText,
  turnIsEmpty,
  type LiveTurn,
} from '../../src/lib/liveTurn'

type Ev =
  | { t: 'delta'; text: string }
  | { t: 'reason'; text: string }
  | { t: 'start'; tool: string; preview: string }
  | { t: 'complete'; tool: string; error: boolean; duration: string }
  | { t: 'fallback'; text: string }
  | { t: 'note'; note: string }

/** Same wiring as ChatView.consumeStream (redact already applied upstream). */
function apply(turn: LiveTurn, ev: Ev): LiveTurn {
  switch (ev.t) {
    case 'delta':
      return appendText(turn, ev.text)
    case 'reason':
      return appendReasoning(turn, ev.text)
    case 'start':
      return startTool(turn, ev.tool, ev.preview)
    case 'complete':
      return completeTool(turn, ev.tool, ev.error, ev.duration)
    case 'fallback':
      return fallbackText(turn, ev.text)
    case 'note':
      return addNote(turn, ev.note)
  }
}

const fold = (evs: Ev[]): LiveTurn => evs.reduce(apply, EMPTY_TURN)

const toolName = fc.constantFrom('terminal', 'browser', 'write_file', 'A', 'B')

const anyEvent: fc.Arbitrary<Ev> = fc.oneof(
  fc.record({ t: fc.constant('delta' as const), text: fc.string() }),
  fc.record({ t: fc.constant('reason' as const), text: fc.string() }),
  fc.record({ t: fc.constant('start' as const), tool: toolName, preview: fc.string() }),
  fc.record({
    t: fc.constant('complete' as const),
    tool: toolName,
    error: fc.boolean(),
    duration: fc.string(),
  }),
  fc.record({ t: fc.constant('fallback' as const), text: fc.string() }),
  fc.record({ t: fc.constant('note' as const), note: fc.string() }),
)

// order/coalescing properties use only non-empty deltas + starts so every event
// is observable (empty deltas are no-ops, tested separately)
const orderEvent: fc.Arbitrary<Ev> = fc.oneof(
  fc.record({ t: fc.constant('delta' as const), text: fc.string({ minLength: 1 }) }),
  fc.record({ t: fc.constant('start' as const), tool: toolName, preview: fc.string() }),
)

describe('live-turn reducers — order & coalescing (the fix)', () => {
  it('renders content and tools in event-arrival order', () => {
    fc.assert(
      fc.property(fc.array(orderEvent), (evs) => {
        const turn = fold(evs)
        // expected segment kinds mirror appendText (coalesce) + startTool
        const expected: ('text' | 'tool')[] = []
        for (const ev of evs) {
          if (ev.t === 'start') expected.push('tool')
          else if (expected[expected.length - 1] !== 'text') expected.push('text')
        }
        expect(turn.segments.map((s) => s.kind)).toEqual(expected)
        // tool segments equal the start events, in order
        const startNames = evs.flatMap((e) => (e.t === 'start' ? [e.tool] : []))
        const toolNames = turn.segments.flatMap((s) => (s.kind === 'tool' ? [s.tool.tool] : []))
        expect(toolNames).toEqual(startNames)
      }),
    )
  })

  it('merges consecutive deltas into one text segment (concatenated)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1 }), (parts) => {
        const turn = fold(parts.map((text) => ({ t: 'delta', text })))
        expect(turn.segments).toEqual([{ kind: 'text', text: parts.join('') }])
      }),
    )
  })

  it('starts a new text segment for a delta after a tool', () => {
    const turn = fold([
      { t: 'delta', text: 'before ' },
      { t: 'start', tool: 'terminal', preview: 'ls' },
      { t: 'delta', text: 'after1 ' },
      { t: 'delta', text: 'after2' },
    ])
    expect(turn.segments.map((s) => s.kind)).toEqual(['text', 'tool', 'text'])
    expect(turn.segments[2]).toEqual({ kind: 'text', text: 'after1 after2' })
  })

  it('ignores empty deltas (no empty text segments)', () => {
    fc.assert(
      fc.property(fc.array(orderEvent), (evs) => {
        const noisy: Ev[] = []
        for (const ev of evs) {
          noisy.push({ t: 'delta', text: '' }, ev, { t: 'delta', text: '' })
        }
        expect(fold(noisy)).toEqual(fold(evs))
      }),
    )
  })
})

describe('live-turn reducers — reasoning (Q4=B live thinking)', () => {
  it('merges consecutive reasoning deltas into one reasoning segment', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1 }), (parts) => {
        const turn = fold(parts.map((text) => ({ t: 'reason', text })))
        expect(turn.segments).toEqual([{ kind: 'reasoning', text: parts.join('') }])
      }),
    )
  })

  it('interleaves reasoning / text / tool in event-arrival order', () => {
    const turn = fold([
      { t: 'reason', text: 'think1 ' },
      { t: 'reason', text: 'think2' },
      { t: 'delta', text: 'answer ' },
      { t: 'start', tool: 'terminal', preview: 'ls' },
      { t: 'reason', text: 'more thinking' },
    ])
    expect(turn.segments.map((s) => s.kind)).toEqual(['reasoning', 'text', 'tool', 'reasoning'])
    expect(turn.segments[0]).toEqual({ kind: 'reasoning', text: 'think1 think2' })
  })

  it('ignores empty reasoning deltas (no empty reasoning segments)', () => {
    fc.assert(
      fc.property(fc.array(anyEvent), (evs) => {
        const noisy: Ev[] = []
        for (const ev of evs) {
          noisy.push({ t: 'reason', text: '' }, ev, { t: 'reason', text: '' })
        }
        expect(fold(noisy)).toEqual(fold(evs))
      }),
    )
  })

  it('reasoning is not reply text — fallback still fires after only reasoning', () => {
    // reasoning must NOT satisfy turnHasText, or the final-content reply
    // fallback would be suppressed on reasoning-only turns
    const reasoned = fold([{ t: 'reason', text: 'thinking hard' }])
    expect(turnHasText(reasoned)).toBe(false)
    const withReply = fallbackText(reasoned, 'final reply')
    expect(withReply.segments.map((s) => s.kind)).toEqual(['reasoning', 'text'])
    expect(withReply.segments[1]).toEqual({ kind: 'text', text: 'final reply' })
  })
})

describe('live-turn reducers — tool completion', () => {
  it('resolves the most recent in-flight call of the same name, in place', () => {
    const turn = fold([
      { t: 'start', tool: 'A', preview: 'p1' },
      { t: 'start', tool: 'A', preview: 'p2' },
      { t: 'complete', tool: 'A', error: false, duration: '3' },
    ])
    expect(turn.segments).toHaveLength(2)
    expect(turn.segments[0]).toMatchObject({ kind: 'tool', tool: { preview: 'p1', error: null } })
    expect(turn.segments[1]).toMatchObject({
      kind: 'tool',
      tool: { preview: 'p2', error: false, duration: '3' },
    })
  })

  it('does not re-resolve a finished call — a stray completion appends instead', () => {
    const turn = fold([
      { t: 'start', tool: 'A', preview: 'p' },
      { t: 'complete', tool: 'A', error: false, duration: '1' },
      { t: 'complete', tool: 'A', error: true, duration: '2' },
    ])
    expect(turn.segments).toHaveLength(2)
    expect(turn.segments[0]).toMatchObject({ tool: { error: false, duration: '1' } })
    expect(turn.segments[1]).toMatchObject({ tool: { preview: '', error: true, duration: '2' } })
  })

  it('appends a completed tool when nothing is in flight (never dropped)', () => {
    const turn = fold([{ t: 'complete', tool: 'ghost', error: true, duration: '1' }])
    expect(turn.segments).toEqual([
      { kind: 'tool', tool: { tool: 'ghost', preview: '', error: true, duration: '1' } },
    ])
  })
})

describe('live-turn reducers — reply fallback', () => {
  it('appends the reply only when no reply text has streamed yet', () => {
    // after a real delta, fallback is a no-op (never echoes a streamed reply)
    const streamed = fold([{ t: 'delta', text: 'hi' }])
    expect(fallbackText(streamed, 'full reply')).toEqual(streamed)
    // whitespace-only reply is always a no-op
    expect(fallbackText(EMPTY_TURN, '   ')).toEqual(EMPTY_TURN)
    // with only a tool so far, the reply lands AFTER the tool (final-reply order)
    const withReply = fallbackText(fold([{ t: 'start', tool: 'A', preview: 'p' }]), 'reply')
    expect(withReply.segments.map((s) => s.kind)).toEqual(['tool', 'text'])
    expect(withReply.segments[1]).toEqual({ kind: 'text', text: 'reply' })
  })

  it('is a no-op whenever reply text already exists', () => {
    fc.assert(
      fc.property(fc.array(anyEvent), fc.string(), (evs, reply) => {
        const turn = fold(evs)
        if (turnHasText(turn)) expect(fallbackText(turn, reply)).toEqual(turn)
      }),
    )
  })
})

describe('live-turn reducers — totality, purity & emptiness', () => {
  it('is total and never mutates its input', () => {
    fc.assert(
      fc.property(fc.array(anyEvent), (evs) => {
        let turn: LiveTurn = EMPTY_TURN
        for (const ev of evs) {
          const before = JSON.stringify(turn)
          const next = apply(turn, ev)
          expect(JSON.stringify(turn)).toBe(before) // input untouched
          expect(Array.isArray(next.segments)).toBe(true)
          turn = next
        }
      }),
    )
    // the shared sentinel is never mutated across any run
    expect(EMPTY_TURN).toEqual({ userText: '', segments: [], notes: [] })
  })

  it('addNote appends notes in order without adding segments', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (notes) => {
        const base = fold([{ t: 'start', tool: 'A', preview: 'p' }])
        const turn = notes.reduce((t, n) => addNote(t, n), base)
        expect(turn.notes).toEqual(notes)
        expect(turn.segments).toHaveLength(1)
      }),
    )
  })

  it('turnIsEmpty reflects userText / segments / notes', () => {
    expect(turnIsEmpty(EMPTY_TURN)).toBe(true)
    expect(turnIsEmpty(addNote(EMPTY_TURN, 'stopping'))).toBe(false)
    expect(turnIsEmpty(appendText(EMPTY_TURN, 'x'))).toBe(false)
    expect(turnIsEmpty(startTool(EMPTY_TURN, 'A', 'p'))).toBe(false)
    expect(turnIsEmpty({ ...EMPTY_TURN, userText: 'hi' })).toBe(false)
  })
})
