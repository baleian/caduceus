/** PU4-4 — transcript mapping is total and loss-free: any role/content shape,
 * no exception, every message renders in exactly one place — merged into its
 * matching tool call (claim-once) or as its own item. History filters exactly
 * the specified subset. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { historyFromMessages, transcriptFromMessages } from '../../src/lib/transcript'
import type { SessionMessage } from '../../src/lib/types'

const anyContent = fc.oneof(
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
  fc.double(),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 5 }), fc.string({ maxLength: 10 }), { maxKeys: 4 }),
)

// small id pool so tool_call_id ↔ tool_calls[].id matches and collisions occur
const callId = fc.oneof(
  fc.constantFrom('a', 'b', 'c', ''),
  fc.constant(null),
  fc.constant(undefined),
)

const toolCall = fc.record(
  {
    id: callId,
    call_id: callId,
    function: fc.oneof(
      fc.record(
        {
          name: fc.oneof(fc.constantFrom('terminal', 't', ''), fc.constant(undefined)),
          arguments: fc.oneof(fc.string({ maxLength: 20 }), fc.constant(undefined)),
        },
        { requiredKeys: [] },
      ),
      fc.constant(null),
      fc.constant(undefined),
    ),
  },
  { requiredKeys: [] },
)

const message: fc.Arbitrary<SessionMessage> = fc.record(
  {
    role: fc.oneof(
      fc.constantFrom('user', 'assistant', 'tool', 'system', 'weird-role'),
      fc.string({ maxLength: 8 }),
    ),
    content: anyContent,
    reasoning: fc.oneof(fc.string({ maxLength: 10 }), fc.constant(null), fc.constant(undefined)),
    tool_calls: fc.oneof(
      fc.array(toolCall, { maxLength: 3 }),
      fc.constant(null),
      fc.constant(undefined),
    ),
    tool_call_id: callId,
    tool_name: fc.oneof(fc.string({ maxLength: 8 }), fc.constant(null), fc.constant(undefined)),
  },
  { requiredKeys: [] },
)

/** Independent oracle of the claim process (mirrors the documented FR-2
 * rules): assistant registers renderable calls' first-seen non-empty ids;
 * a tool message merges iff its id is registered and unclaimed. */
function expectedMerges(messages: SessionMessage[]): number {
  const unclaimed = new Set<string>()
  let merged = 0
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const call of m.tool_calls ?? []) {
        const name = typeof call?.function?.name === 'string' ? call.function.name : ''
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
        const id =
          typeof call?.id === 'string' && call.id
            ? call.id
            : typeof call?.call_id === 'string'
              ? call.call_id
              : ''
        if ((name || args) && id) unclaimed.add(id)
      }
    } else if (m.role === 'tool') {
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
      if (id && unclaimed.has(id)) {
        unclaimed.delete(id)
        merged++
      }
    }
  }
  return merged
}

describe('PU4-4 transcript mapping', () => {
  it('is loss-free: item count + merged results == message count, never throwing', () => {
    fc.assert(
      fc.property(fc.array(message, { maxLength: 30 }), (messages) => {
        const items = transcriptFromMessages(messages)
        const merged = items
          .filter((i) => i.kind === 'assistant')
          .flatMap((i) => i.toolCalls)
          .filter((c) => c.result !== null).length
        expect(items.length + merged).toBe(messages.length)
        expect(merged).toBe(expectedMerges(messages))
        for (const item of items) {
          expect(['user', 'assistant', 'tool', 'other']).toContain(item.kind)
          expect(typeof item.text).toBe('string')
        }
      }),
    )
  })

  it('claims each call id at most once', () => {
    fc.assert(
      fc.property(fc.array(message, { maxLength: 30 }), (messages) => {
        const items = transcriptFromMessages(messages)
        for (const item of items) {
          if (item.kind !== 'assistant') continue
          const claimed = item.toolCalls.filter((c) => c.result !== null).map((c) => c.id)
          expect(new Set(claimed).size).toBe(claimed.length)
          for (const id of claimed) expect(id).not.toBe('')
        }
      }),
    )
  })

  it('merges a result into its matching call and drops the standalone item', () => {
    const messages: SessionMessage[] = [
      {
        role: 'assistant',
        content: 'checking the port',
        reasoning: 'plan: use nc',
        tool_calls: [
          { id: 'call-1', call_id: 'call-1', function: { name: 'terminal', arguments: '{"command":"nc -z"}' } },
        ],
      },
      { role: 'tool', content: '{"output": "closed", "exit_code": 1, "error": null}', tool_call_id: 'call-1', tool_name: 'terminal' },
      { role: 'assistant', content: 'port is closed' },
    ]
    const items = transcriptFromMessages(messages)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      kind: 'assistant',
      reasoning: 'plan: use nc',
      toolCalls: [
        {
          id: 'call-1',
          name: 'terminal',
          result: { text: '{"output": "closed", "exit_code": 1, "error": null}' },
        },
      ],
    })
    expect(items[1]).toMatchObject({ kind: 'assistant', text: 'port is closed' })
  })

  it('keeps orphan and duplicate-claim tool results as standalone items', () => {
    const messages: SessionMessage[] = [
      { role: 'tool', content: 'no call yet', tool_call_id: 'call-1', tool_name: 'terminal' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', function: { name: 'terminal', arguments: '{}' } }],
      },
      { role: 'tool', content: 'first claim', tool_call_id: 'call-1' },
      { role: 'tool', content: 'second claim', tool_call_id: 'call-1' },
      { role: 'tool', content: 'no id at all' },
    ]
    const items = transcriptFromMessages(messages)
    // orphan (before call), assistant, duplicate claim, id-less — 4 items
    expect(items.map((i) => i.kind)).toEqual(['tool', 'assistant', 'tool', 'tool'])
    const assistant = items[1]!
    expect(assistant.kind === 'assistant' && assistant.toolCalls[0]?.result?.text).toBe(
      'first claim',
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
})
