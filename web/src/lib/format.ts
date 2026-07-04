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
