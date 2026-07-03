/** PU4-1 — SSE parser: serialize→arbitrary chunking→parse round-trip;
 * garbage never throws and never fabricates events. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createSseParser, type SseEvent } from '../../src/lib/sse'

const eventName = fc.stringMatching(/^[a-z][a-z0-9._-]{0,20}$/)
const dataText = fc.string({ maxLength: 80 }).map((s) => s.replace(/\r/g, ''))

const sseEvent: fc.Arbitrary<SseEvent> = fc.record({ event: eventName, data: dataText })

function serialize(events: readonly SseEvent[]): string {
  return events
    .map((e) => {
      const head = e.event === 'message' ? '' : `event: ${e.event}\n`
      const body = e.data
        .split('\n')
        .map((line) => `data: ${line}`)
        .join('\n')
      return head + body + '\n\n'
    })
    .join('')
}

function chunkize(text: string, cuts: readonly number[]): string[] {
  const bytes = new TextEncoder().encode(text)
  const sorted = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b)
  const chunks: string[] = []
  let prev = 0
  for (const cut of [...sorted, bytes.length]) {
    if (cut > prev) chunks.push(new TextDecoder().decode(bytes.slice(prev, cut)))
    prev = cut
  }
  return chunks
}

describe('PU4-1 sse parser', () => {
  it('round-trips any event sequence under any chunking', () => {
    fc.assert(
      fc.property(
        fc.array(sseEvent, { maxLength: 10 }),
        fc.array(fc.nat(10_000), { maxLength: 20 }),
        (events, cuts) => {
          const wire = serialize(events)
          const parser = createSseParser()
          const out: SseEvent[] = []
          // byte-level chunking exercises multi-byte boundaries
          const bytes = new TextEncoder().encode(wire)
          const sorted = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b)
          let prev = 0
          for (const cut of [...sorted, bytes.length]) {
            if (cut > prev) out.push(...parser.push(bytes.slice(prev, cut)))
            prev = cut
          }
          expect(out).toEqual(events)
        },
      ),
    )
  })

  it('string chunking round-trips too', () => {
    fc.assert(
      fc.property(
        fc.array(sseEvent, { maxLength: 6 }),
        fc.array(fc.nat(500), { maxLength: 8 }),
        (events, cuts) => {
          const parser = createSseParser()
          const out: SseEvent[] = []
          for (const chunk of chunkize(serialize(events), cuts)) out.push(...parser.push(chunk))
          expect(out).toEqual(events)
        },
      ),
    )
  })

  it('never throws on garbage and yields only well-formed events', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 200 }), { maxLength: 10 }), (chunks) => {
        const parser = createSseParser()
        for (const chunk of chunks) {
          for (const event of parser.push(chunk)) {
            expect(typeof event.event).toBe('string')
            expect(typeof event.data).toBe('string')
          }
        }
      }),
    )
  })

  it('a cut trailing block is never emitted as complete', () => {
    const parser = createSseParser()
    expect(parser.push('data: hel')).toEqual([])
    expect(parser.push('lo')).toEqual([]) // still no terminator
  })
})
