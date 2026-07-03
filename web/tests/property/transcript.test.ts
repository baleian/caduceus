/** PU4-4 — transcript mapping is a total function: any role/content shape,
 * no exception, item count preserved; history filters exactly the specified
 * subset; failure summary is single-line and bounded. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  FAILURE_DETAIL_LIMIT,
  historyFromMessages,
  toolFailureSummary,
  transcriptFromMessages,
} from '../../src/lib/transcript'
import type { SessionMessage } from '../../src/lib/types'

const anyContent = fc.oneof(
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
  fc.double(),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 5 }), fc.string({ maxLength: 10 }), { maxKeys: 4 }),
)

const message: fc.Arbitrary<SessionMessage> = fc.record(
  {
    role: fc.oneof(
      fc.constantFrom('user', 'assistant', 'tool', 'system', 'weird-role'),
      fc.string({ maxLength: 8 }),
    ),
    content: anyContent,
  },
  { requiredKeys: [] },
)

describe('PU4-4 transcript mapping', () => {
  it('maps every message to exactly one item, never throwing', () => {
    fc.assert(
      fc.property(fc.array(message, { maxLength: 30 }), (messages) => {
        const items = transcriptFromMessages(messages)
        expect(items).toHaveLength(messages.length)
        for (const item of items) {
          expect(['user', 'assistant', 'tool', 'other']).toContain(item.kind)
          expect(typeof item.text).toBe('string')
        }
      }),
    )
  })

  it('history keeps exactly the non-empty string user/assistant turns, in order', () => {
    fc.assert(
      fc.property(fc.array(message, { maxLength: 30 }), (messages) => {
        const expected = messages.filter(
          (m) =>
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content !== '',
        )
        const history = historyFromMessages(messages)
        expect(history).toHaveLength(expected.length)
        history.forEach((h, i) => {
          expect(h.role).toBe(expected[i]!.role)
          expect(h.content).toBe(expected[i]!.content)
        })
      }),
    )
  })

  it('failure summary never throws, is single-line and bounded', () => {
    fc.assert(
      fc.property(anyContent, (content) => {
        const summary = toolFailureSummary(content)
        expect(summary.length).toBeLessThanOrEqual(FAILURE_DETAIL_LIMIT)
        expect(summary).not.toMatch(/\n/)
      }),
    )
  })

  it('extracts the first non-empty of error/output/message/detail from JSON content', () => {
    expect(toolFailureSummary(JSON.stringify({ error: '', output: 'exit 1' }))).toBe('exit 1')
    expect(toolFailureSummary(JSON.stringify({ error: 'denied' }))).toBe('denied')
    expect(toolFailureSummary('plain text')).toBe('plain text')
  })
})
