/** Live streaming-turn model (chat-streaming-order FR-1) — pure, total reducers.
 *
 * The history path (lib/transcript) renders each persisted message as its own
 * ordered item, so thinking → content → tool cards comes out in real order.
 * The live path used to bucket streaming events into a single concatenated
 * `assistantText` plus a flat `tools[]`, so a `content → tool → content → tool`
 * turn collapsed to "all tools on top, all content at the bottom" until the
 * end-of-turn re-hydration (W7) rebuilt it from the store.
 *
 * Here the turn is an ordered list of segments (text | tool) folded in
 * event-arrival order: consecutive text deltas coalesce into one text segment;
 * a delta arriving after a tool starts a new text segment; a tool completion
 * resolves the matching in-flight tool in place. Every reducer is pure (never
 * mutates its input) and total (any event on any turn is, at worst, a no-op),
 * so they are exercised directly by fast-check property tests.
 *
 * redact() stays in the view: reducers receive already-redacted strings so the
 * security boundary is not duplicated here.
 */

export interface LiveToolCall {
  tool: string
  preview: string
  /** null while running, then false = ok / true = failed */
  error: boolean | null
  duration: string
}

export type LiveSegment = { kind: 'text'; text: string } | { kind: 'tool'; tool: LiveToolCall }

export interface LiveTurn {
  userText: string
  segments: LiveSegment[]
  notes: string[]
}

export const EMPTY_TURN: LiveTurn = { userText: '', segments: [], notes: [] }

/** message.delta → append to the trailing text segment (coalesce) or, when the
 * last segment is a tool (or there is none), start a new text segment. An empty
 * delta contributes nothing, so no empty text segment is ever created. */
export function appendText(turn: LiveTurn, text: string): LiveTurn {
  if (!text) return turn
  const segments = turn.segments.slice()
  const last = segments[segments.length - 1]
  if (last && last.kind === 'text') {
    segments[segments.length - 1] = { kind: 'text', text: last.text + text }
  } else {
    segments.push({ kind: 'text', text })
  }
  return { ...turn, segments }
}

/** tool.started → append an in-flight tool segment (error = null). */
export function startTool(turn: LiveTurn, tool: string, preview: string): LiveTurn {
  return {
    ...turn,
    segments: [
      ...turn.segments,
      { kind: 'tool', tool: { tool, preview, error: null, duration: '' } },
    ],
  }
}

/** tool.completed → resolve the most recent in-flight tool of the same name;
 * if none is in flight, append an already-completed tool (matches the prior
 * fallback so a stray completion is never dropped). */
export function completeTool(
  turn: LiveTurn,
  tool: string,
  error: boolean,
  duration: string,
): LiveTurn {
  const segments = turn.segments.slice()
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!
    if (seg.kind === 'tool' && seg.tool.tool === tool && seg.tool.error === null) {
      segments[i] = { kind: 'tool', tool: { ...seg.tool, error, duration } }
      return { ...turn, segments }
    }
  }
  segments.push({ kind: 'tool', tool: { tool, preview: '', error, duration } })
  return { ...turn, segments }
}

/** Any assistant reply text present yet? Drives the reply fallback and the
 * streaming cursor. */
export function turnHasText(turn: LiveTurn): boolean {
  return turn.segments.some((s) => s.kind === 'text' && s.text.trim() !== '')
}

/** reasoning.available / run.completed reply fallback for providers that emit
 * no message.delta — append the whole reply as a trailing text segment, but
 * only when nothing has streamed yet (never echo an already-streamed reply). */
export function fallbackText(turn: LiveTurn, text: string): LiveTurn {
  if (!text.trim() || turnHasText(turn)) return turn
  return { ...turn, segments: [...turn.segments, { kind: 'text', text }] }
}

/** Trailing system note (stop / failure / connection loss) — kept out of the
 * event-ordered segment stream and grouped at the end of the turn. */
export function addNote(turn: LiveTurn, note: string): LiveTurn {
  return { ...turn, notes: [...turn.notes, note] }
}

export function turnIsEmpty(turn: LiveTurn): boolean {
  return !turn.userText && turn.segments.length === 0 && turn.notes.length === 0
}
