/** Pure observability view helpers (observability-redesign S7, vitest'd).
 *
 * The daemon ships scope-level buckets/KPIs; session narrow-down re-derives
 * both **client-side** from the per-session rows using the same placement
 * rule as the backend (last_active, else started_at) — no extra fetches.
 * Deterministic: `nowS` is always a parameter. */

import type { UsageBucket, UsageKpis, UsageRange, UsageSessionRow } from './types'

/** Mirror of backend RANGES: bucket seconds, bucket count. */
export const USAGE_RANGES: Record<UsageRange, { bucketS: number; count: number }> = {
  '24h': { bucketS: 3600, count: 24 },
  '7d': { bucketS: 21_600, count: 28 },
  '30d': { bucketS: 86_400, count: 30 },
}

function placement(row: UsageSessionRow): number | null {
  return row.last_active ?? row.started_at
}

/** Re-bucket session rows into the fixed zero-filled grid (backend parity). */
export function bucketRows(
  rows: readonly UsageSessionRow[],
  nowS: number,
  range: UsageRange,
): UsageBucket[] {
  const { bucketS, count } = USAGE_RANGES[range]
  const end = Math.floor(nowS / bucketS) * bucketS + bucketS
  const start0 = end - count * bucketS
  const grid: UsageBucket[] = Array.from({ length: count }, (_, i) => ({
    start_s: start0 + i * bucketS,
    requests: 0,
    sessions: 0,
    messages: 0,
    tool_calls: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
  }))
  for (const row of rows) {
    const at = placement(row)
    if (at == null || at < start0 || at >= end) continue
    const cell = grid[Math.floor((at - start0) / bucketS)]!
    cell.requests += row.requests
    cell.sessions += 1
    cell.messages += row.messages
    cell.tool_calls += row.tool_calls
    cell.cost_usd += row.cost_usd
    cell.input_tokens += row.input_tokens
    cell.output_tokens += row.output_tokens
    cell.cache_read_tokens += row.cache_read_tokens
    cell.reasoning_tokens += row.reasoning_tokens
  }
  return grid
}

/** KPI subset derivable from narrow-down rows (backend parity for the fields
 * a session filter can answer; cache_write/actual cost aren't in the rows). */
export function kpisFromRows(rows: readonly UsageSessionRow[], nowS: number): UsageKpis {
  const sum = (pick: (r: UsageSessionRow) => number): number =>
    rows.reduce((n, r) => n + pick(r), 0)
  const input = sum((r) => r.input_tokens)
  const cacheRead = sum((r) => r.cache_read_tokens)
  const durations = rows.filter((r) => r.started_at != null && r.last_active != null)
  const active = rows.filter(
    (r) => r.ended_at == null && r.last_active != null && nowS - r.last_active <= 300,
  )
  return {
    requests: sum((r) => r.requests),
    sessions: rows.length,
    active_sessions: active.length,
    messages: sum((r) => r.messages),
    tool_calls: sum((r) => r.tool_calls),
    input_tokens: input,
    output_tokens: sum((r) => r.output_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
    reasoning_tokens: sum((r) => r.reasoning_tokens),
    cost_usd: sum((r) => r.cost_usd),
    actual_cost_usd: 0,
    avg_duration_s: durations.length ? sum((r) => r.duration_s) / durations.length : 0,
    cache_hit_ratio: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0,
  }
}

export interface DonutSlice {
  name: string
  value: number
}

/** Fold rows beyond the top `keep` into a single "other" slice (fixed-order
 * palette is 4 slots — a 5th category is never a generated hue). Pure. */
export function foldSlices(slices: DonutSlice[], keep = 4): DonutSlice[] {
  const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value)
  if (sorted.length <= keep) return sorted
  const head = sorted.slice(0, keep - 1)
  const rest = sorted.slice(keep - 1).reduce((n, s) => n + s.value, 0)
  return [...head, { name: 'other', value: rest }]
}

/** Recent-half vs prior-half trend of one series key: ratio in [-1, ∞) or
 * null when the prior half is empty (delta is meaningless — hide the badge). */
export function halfDelta(series: readonly UsageBucket[], key: keyof UsageBucket): number | null {
  if (series.length < 2) return null
  const half = Math.floor(series.length / 2)
  const prior = series.slice(0, half).reduce((n, b) => n + Number(b[key] ?? 0), 0)
  const recent = series.slice(series.length - half).reduce((n, b) => n + Number(b[key] ?? 0), 0)
  if (prior <= 0) return null
  return (recent - prior) / prior
}
