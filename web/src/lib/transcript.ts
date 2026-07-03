/** Session messages → transcript render model (PU4-4 — total function).
 *
 * W7 single source of truth: the transcript is always rebuilt from the
 * api_server session store; every message maps to exactly one item, unknown
 * roles degrade to 'other' (never dropped, never thrown).
 */

import type { SessionMessage, SessionToolCall } from './types'

/** A single tool invocation rendered under an assistant turn. */
export interface TranscriptToolCall {
  name: string
  args: string
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
    if (name || args) calls.push({ name: name || '?', args })
  }
  return calls
}

export function transcriptFromMessages(raw: readonly SessionMessage[]): TranscriptItem[] {
  return raw.map((message) => {
    const role = typeof message.role === 'string' ? message.role : ''
    const text = contentText(message.content)
    if (role === 'user') return { kind: 'user', text }
    if (role === 'assistant') {
      return {
        kind: 'assistant',
        text,
        reasoning: reasoningText(message),
        toolCalls: toolCalls(message.tool_calls),
      }
    }
    if (role === 'tool') {
      const toolName = typeof message.tool_name === 'string' ? message.tool_name : ''
      return { kind: 'tool', text, toolName }
    }
    return { kind: 'other', role, text }
  })
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

export const FAILURE_DETAIL_LIMIT = 200

/** One-line failure detail from a persisted tool message's content
 * (U3 tool_failure_summary: terminal-style results are JSON
 * {output, exit_code, error}; other tools store plain text). */
export function toolFailureSummary(content: unknown, limit = FAILURE_DETAIL_LIMIT): string {
  let text = contentText(content)
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        for (const key of ['error', 'output', 'message', 'detail']) {
          const value = record[key]
          if (typeof value === 'string' && value.trim()) {
            text = value
            break
          }
        }
      }
    } catch {
      // plain text stays as-is
    }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}
