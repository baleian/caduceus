/** Session messages → transcript render model (PU4-4 — total function).
 *
 * W7 single source of truth: the transcript is always rebuilt from the
 * api_server session store; unknown roles degrade to 'other' (never dropped,
 * never thrown).
 *
 * Loss-free invariant (chat-transcript-rendering FR-2): every message renders
 * in exactly one place — a `role:"tool"` message whose `tool_call_id` matches
 * a not-yet-claimed assistant tool call merges into that call's card (no
 * standalone item); every other message maps to exactly one item. Orphan tool
 * results (no matching call, duplicate claim) fall back to standalone items.
 */

import type { SessionMessage, SessionToolCall } from './types'

/** A single tool invocation rendered under an assistant turn. `result` is
 * the raw content of the merged tool message (display parsing happens in the
 * view via lib/toolFormat). */
export interface TranscriptToolCall {
  id: string
  name: string
  args: string
  result: { text: string } | null
}

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; reasoning: string; toolCalls: TranscriptToolCall[] }
  | { kind: 'tool'; text: string; toolName: string }
  | { kind: 'other'; role: string; text: string }

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function reasoningText(message: SessionMessage): string {
  const value = message.reasoning ?? message.reasoning_content
  return typeof value === 'string' ? value : ''
}

function toolCalls(raw: SessionToolCall[] | null | undefined): TranscriptToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: TranscriptToolCall[] = []
  for (const call of raw) {
    const fn = call?.function
    const name = typeof fn?.name === 'string' ? fn.name : ''
    const args = typeof fn?.arguments === 'string' ? fn.arguments : ''
    const id =
      typeof call?.id === 'string' && call.id
        ? call.id
        : typeof call?.call_id === 'string'
          ? call.call_id
          : ''
    if (name || args) calls.push({ id, name: name || '?', args, result: null })
  }
  return calls
}

export function transcriptFromMessages(raw: readonly SessionMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // call id → call awaiting its result; claimed at most once (first wins)
  const unclaimed = new Map<string, TranscriptToolCall>()
  for (const message of raw) {
    const role = typeof message.role === 'string' ? message.role : ''
    const text = contentText(message.content)
    if (role === 'user') {
      items.push({ kind: 'user', text })
    } else if (role === 'assistant') {
      const calls = toolCalls(message.tool_calls)
      for (const call of calls) {
        if (call.id && !unclaimed.has(call.id)) unclaimed.set(call.id, call)
      }
      items.push({ kind: 'assistant', text, reasoning: reasoningText(message), toolCalls: calls })
    } else if (role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      const target = callId ? unclaimed.get(callId) : undefined
      if (target) {
        target.result = { text }
        unclaimed.delete(callId)
      } else {
        const toolName = typeof message.tool_name === 'string' ? message.tool_name : ''
        items.push({ kind: 'tool', text, toolName })
      }
    } else {
      items.push({ kind: 'other', role, text })
    }
  }
  return items
}

/** conversation_history for POST /v1/runs (U3 contract: runs API does not
 * hydrate history itself — only non-empty string user/assistant turns). */
export function historyFromMessages(
  raw: readonly SessionMessage[],
): { role: string; content: string }[] {
  const history: { role: string; content: string }[] = []
  for (const message of raw) {
    const { role, content } = message
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content) {
      history.push({ role, content })
    }
  }
  return history
}
