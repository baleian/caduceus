/** Incremental SSE parser (PU4-1 — mirror of U3 sse.py).
 *
 * Push raw chunks in any framing; get complete events out. Tolerant by
 * design: comments and unknown fields ignored, garbage never throws, multiple
 * `data:` lines join with `\n`. A trailing block without its terminator
 * (stream cut mid-event) is never emitted — partial events must not render
 * as if complete.
 */

export interface SseEvent {
  event: string
  data: string
}

const DEFAULT_EVENT = 'message'

function parseBlock(block: string): SseEvent | null {
  let event = DEFAULT_EVENT
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue // comment / keepalive
    const sep = line.indexOf(':')
    const field = sep === -1 ? line : line.slice(0, sep)
    let value = sep === -1 ? '' : line.slice(sep + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event' && value) event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0 && event === DEFAULT_EVENT) return null
  return { event, data: dataLines.join('\n') }
}

export interface SseParser {
  push(chunk: Uint8Array | string): SseEvent[]
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder('utf-8') // streaming decode, lone bytes buffered
  let buffer = ''
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const events: SseEvent[] = []
      let idx = buffer.indexOf('\n\n')
      while (idx !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const parsed = parseBlock(block)
        if (parsed !== null) events.push(parsed)
        idx = buffer.indexOf('\n\n')
      }
      return events
    },
  }
}
