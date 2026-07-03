/** Mask hex secrets and truncate (WPT-6/PU4-7 — same rule as U1 `redact`). */

const SECRET_RE = /[A-Fa-f0-9]{32,}/g

export function redact(text: string, limit = 500): string {
  return text.replace(SECRET_RE, '***').slice(0, limit)
}
