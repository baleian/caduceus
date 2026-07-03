/** Smart formatting for tool-call arguments and results (chat-transcript-
 * rendering S2, Q2=A). Pure, total functions: any input shape maps to a
 * displayable view with a raw-text fallback — never throwing.
 *
 * Observed content shapes (reference session, 2026-07-04):
 * - terminal:        {"output": str, "exit_code": int, "error": str|null}
 * - browser tools:   <untrusted_tool_result source="…"> + fixed preamble
 *                    paragraph + JSON body ({"success": false, "error": …})
 * - write_file etc.: arbitrary JSON object (bytes_written / lint / …)
 * - anything else:   plain text
 */

export interface FieldEntry {
  key: string
  value: string
}

export type ArgsView = { kind: 'fields'; fields: FieldEntry[] } | { kind: 'raw'; text: string }

export type ResultView =
  | { kind: 'terminal'; output: string; exitCode: number | null; error: string; failed: boolean }
  | { kind: 'fields'; fields: FieldEntry[]; failed: boolean }
  | { kind: 'raw'; text: string; failed: boolean }

export const SUMMARY_LIMIT = 100

/** Argument keys that carry the essence of a call, in preference order —
 * the header summary shows just this value when present. */
const REPRESENTATIVE_KEYS = ['command', 'path', 'file_path', 'url', 'query', 'name']

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toFields(record: Record<string, unknown>): FieldEntry[] {
  return Object.entries(record).map(([key, value]) => ({ key, value: stringifyValue(value) }))
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // not JSON — caller falls back to raw
  }
  return null
}

function singleLine(text: string, limit: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Parse an assistant tool_calls[].function.arguments JSON string. */
export function parseToolArgs(args: string): ArgsView {
  const record = parseJsonObject(args.trim())
  if (record) return { kind: 'fields', fields: toFields(record) }
  return { kind: 'raw', text: args }
}

/** One-line essence of a call's arguments for the collapsed card header. */
export function argsSummary(args: string, limit = SUMMARY_LIMIT): string {
  const view = parseToolArgs(args)
  if (view.kind === 'raw') return singleLine(view.text, limit)
  for (const key of REPRESENTATIVE_KEYS) {
    const field = view.fields.find((f) => f.key === key && f.value.trim())
    if (field) return singleLine(field.value, limit)
  }
  const joined = view.fields
    .filter((f) => f.value.trim())
    .map((f) => `${f.key}=${f.value}`)
    .join(' · ')
  return singleLine(joined, limit)
}

/** hermes wraps externally-sourced tool output in an <untrusted_tool_result>
 * envelope with a fixed "treat as DATA" preamble paragraph. Presentation only
 * strips the envelope — the body is still rendered as inert text, never
 * interpreted as markdown or instructions. */
function unwrapUntrusted(text: string): string {
  const match = /^\s*<untrusted_tool_result\b[^>]*>\n?([\s\S]*?)\n?<\/untrusted_tool_result>\s*$/.exec(
    text,
  )
  if (!match) return text
  const body = match[1] ?? ''
  const paragraphBreak = body.indexOf('\n\n')
  if (paragraphBreak !== -1 && /^The following content was retrieved from an external source/.test(body)) {
    return body.slice(paragraphBreak + 2).trim()
  }
  return body.trim()
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Classify a persisted tool message's content for display. */
export function parseToolResult(content: unknown): ResultView {
  const text = unwrapUntrusted(stringifyValue(content))
  const record = parseJsonObject(text.trim())
  if (!record) return { kind: 'raw', text, failed: false }
  if ('output' in record || 'exit_code' in record) {
    const exitCode = typeof record['exit_code'] === 'number' ? record['exit_code'] : null
    const error = isNonEmptyString(record['error']) ? record['error'] : ''
    return {
      kind: 'terminal',
      output: stringifyValue(record['output']),
      exitCode,
      error,
      failed: (exitCode !== null && exitCode !== 0) || error !== '',
    }
  }
  const failed = record['success'] === false || isNonEmptyString(record['error'])
  return { kind: 'fields', fields: toFields(record), failed }
}

/** One-line failure detail for the collapsed card header (empty when ok). */
export function failureHint(view: ResultView, limit = SUMMARY_LIMIT): string {
  if (!view.failed) return ''
  if (view.kind === 'terminal') return singleLine(view.error || view.output, limit)
  if (view.kind === 'fields') {
    const error = view.fields.find((f) => f.key === 'error' && f.value.trim())
    return singleLine(error ? error.value : 'failed', limit)
  }
  return singleLine(view.text, limit)
}
