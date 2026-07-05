/** Number/label formatting for observability surfaces (pure — vitest'd).
 * One formatter per unit family so cards, tooltips and tables agree. */

/** 1234 → "1.2k", 3400000 → "3.4M"; integers below 1000 stay verbatim. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}k`
  return Number.isInteger(value) ? String(value) : trim(value)
}

function trim(scaled: number): string {
  const fixed = scaled.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/** USD with adaptive precision: sub-cent costs keep 4 decimals. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0'
  const abs = Math.abs(value)
  if (abs < 0.01) return `$${value.toFixed(4)}`
  if (abs < 100) return `$${value.toFixed(2)}`
  return `$${formatCount(value)}`
}

/** Milliseconds → "45ms" / "1.2s". */
export function formatMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0ms'
  if (value >= 1000) return `${trim(value / 1000)}s`
  return `${Math.round(value)}ms`
}

/** Ratio 0..1 → "37%". */
export function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  return `${Math.round(ratio * 100)}%`
}

/** Seconds → "42s" / "3m 20s" / "1h 12m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Bucket start (epoch s) → axis label; daily buckets get MM/DD, finer get HH:MM. */
export function bucketLabel(startS: number, bucketS: number): string {
  const d = new Date(startS * 1000)
  if (bucketS >= 86_400) {
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  }
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (bucketS >= 21_600) {
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hhmm}`
  }
  return hhmm
}

/** Epoch seconds → compact local datetime for tables ("07/04 13:22"). */
export function shortDateTime(epochS: number | null): string {
  if (epochS == null || !Number.isFinite(epochS)) return '—'
  const d = new Date(epochS * 1000)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  return `${md} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Values below ~1e11 are epoch SECONDS; at/above are already milliseconds. */
function normalizeMs(n: number): number {
  return Math.abs(n) < 1e11 ? n * 1000 : n
}

/** Parse ISO string | epoch-seconds string (maybe fractional) | epoch-ms |
 *  number → epoch **milliseconds**, or null. */
export function toEpochMs(input: string | number | null | undefined): number | null {
  if (input == null) return null
  if (typeof input === 'number') return Number.isFinite(input) ? normalizeMs(input) : null
  const s = input.trim()
  if (s === '') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? normalizeMs(n) : null
  }
  const parsed = Date.parse(s)
  return Number.isNaN(parsed) ? null : parsed
}

/** Humanized relative time from any timestamp shape. '' when absent/unparseable.
 *  Fixes the ChatView bug where fractional epoch strings printed raw. */
export function timeAgo(input: string | number | null | undefined, now = Date.now()): string {
  const ms = toEpochMs(input)
  if (ms == null) return ''
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 2_592_000) return `${Math.floor(s / 86_400)}d ago`
  return shortDateTime(ms / 1000)
}

/** UI cost readout: 0 / null / NaN collapse to an em-dash so free/local
 *  upstreams don't spam "$0.0000". Non-zero delegates to formatUsd.
 *  (Observability deliberately keeps formatUsd → "$0".) */
export function formatCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '—'
  return formatUsd(value)
}

/** Opaque server ids: "api_1783148667_43246421", "1783148691.5026166", … */
const MACHINE_ID = /^(?:[a-z]+[-_])?\d{6,}(?:[-_.]\w+)*$/i
export function isMachineId(s: string): boolean {
  return MACHINE_ID.test(s.trim())
}

/** Friendly session label: human title → first user message → date → fallback. */
export function deriveSessionTitle(input: {
  title?: string | null
  firstUserText?: string | null
  startedAt?: string | number | null
}): string {
  const title = input.title?.trim()
  if (title && !isMachineId(title)) return title
  const first = input.firstUserText?.trim()
  if (first) return truncate(firstLine(first), 48)
  const ms = toEpochMs(input.startedAt)
  if (ms != null) return `Chat · ${shortDateTime(ms / 1000)}`
  return 'New chat'
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return (nl === -1 ? s : s.slice(0, nl)).trim()
}
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}
