/** Chat run state machine (PU4-2 — U3 chat.py transition table, ported as data).
 *
 * Invariants: at most one stop per turn (stopping+interrupt is a no-op),
 * submitting is possible only from idle, unknown (state,event) pairs are
 * no-ops. The UI adapter differs from the CLI (Stop button instead of Ctrl+C;
 * idle+interrupt is a no-op here, not an exit).
 */

export type ChatState = 'idle' | 'streaming' | 'stopping' | 'awaiting_approval'
export type ChatEvent =
  'interrupt' | 'eof' | 'user_message' | 'approval_request' | 'approval_answered' | 'stream_end'
export type ChatAction =
  'none' | 'exit' | 'start_turn' | 'send_stop' | 'prompt_approval' | 'auto_deny'

const TRANSITIONS: Partial<Record<`${ChatState}:${ChatEvent}`, [ChatState, ChatAction]>> = {
  // idle+interrupt / idle+eof: UI has no exit action — stays idle, no-op
  'idle:user_message': ['streaming', 'start_turn'],
  'streaming:interrupt': ['stopping', 'send_stop'],
  'streaming:approval_request': ['awaiting_approval', 'prompt_approval'],
  'streaming:stream_end': ['idle', 'none'],
  'streaming:eof': ['streaming', 'none'],
  'stopping:interrupt': ['stopping', 'none'], // never a second stop
  'stopping:approval_request': ['stopping', 'auto_deny'],
  'stopping:stream_end': ['idle', 'none'],
  'stopping:eof': ['stopping', 'none'],
  'awaiting_approval:interrupt': ['streaming', 'auto_deny'],
  'awaiting_approval:approval_answered': ['streaming', 'none'],
  'awaiting_approval:stream_end': ['idle', 'none'],
  'awaiting_approval:eof': ['awaiting_approval', 'none'],
}

/** Pure, total over the vocabulary; unknown pairs are no-ops. */
export function transition(state: ChatState, event: ChatEvent): [ChatState, ChatAction] {
  return TRANSITIONS[`${state}:${event}`] ?? [state, 'none']
}

export const APPROVAL_CHOICES = ['once', 'session', 'always', 'deny'] as const
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number]
