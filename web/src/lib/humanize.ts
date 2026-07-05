/** Humanize daemon event kinds and JSON detail blobs into readable UI text —
 * pure. The System page used to show raw "drift.detected" +
 * {"reason":"gateway-not-running"}; these turn those into human clauses. */

const KIND_LABELS: Record<string, string> = {
  'drift.detected': 'Drift detected',
  'drift.remediated': 'Drift remediated',
  'orphan.detected': 'Orphan detected',
  'orphan.resolved': 'Orphan resolved',
}

/** "drift.detected" → "Drift detected"; unknown kinds title-case dotted parts. */
export function humanizeKind(kind: string): string {
  const known = KIND_LABELS[kind]
  if (known) return known
  return kind
    .split(/[._]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** JSON detail → readable clause: {"reason":"gateway-not-running"} →
 * "reason: gateway not running". Non-JSON passes through trimmed. */
export function humanizeDetail(detail: string | null | undefined): string {
  if (!detail) return ''
  const obj = parse(detail)
  if (!obj) return detail.trim()
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${soften(String(v))}`)
    .join(' · ')
}

function parse(s: string): Record<string, unknown> | null {
  const t = s.trim()
  if (!t.startsWith('{')) return null
  try {
    const v: unknown = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** "gateway-not-running" → "gateway not running". */
function soften(s: string): string {
  return s.replace(/[-_]/g, ' ')
}
