/** observability-redesign S9 — client-side narrow-down helpers: bucketing
 * conservation (backend parity), KPI derivation, half-delta, donut folding. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  bucketRows,
  foldSlices,
  halfDelta,
  kpisFromRows,
  USAGE_RANGES,
} from '../../src/lib/obs'
import type { UsageBucket, UsageRange, UsageSessionRow } from '../../src/lib/types'

const NOW_S = Date.parse('2026-07-04T12:00:00Z') / 1000

const rowArb: fc.Arbitrary<UsageSessionRow> = fc.record({
  id: fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: null }),
  title: fc.constant(null),
  model: fc.option(fc.constantFrom('m1', 'm2'), { nil: null }),
  source: fc.option(fc.constantFrom('api_server', 'cli'), { nil: null }),
  started_at: fc.option(
    fc.double({ min: NOW_S - 40 * 86_400, max: NOW_S + 3_600, noNaN: true }),
    { nil: null },
  ),
  last_active: fc.option(
    fc.double({ min: NOW_S - 40 * 86_400, max: NOW_S + 3_600, noNaN: true }),
    { nil: null },
  ),
  ended_at: fc.option(fc.constant(NOW_S - 50), { nil: null }),
  duration_s: fc.double({ min: 0, max: 86_400, noNaN: true }),
  requests: fc.nat({ max: 500 }),
  messages: fc.nat({ max: 500 }),
  tool_calls: fc.nat({ max: 500 }),
  input_tokens: fc.nat({ max: 100_000 }),
  output_tokens: fc.nat({ max: 100_000 }),
  cache_read_tokens: fc.nat({ max: 100_000 }),
  reasoning_tokens: fc.nat({ max: 100_000 }),
  cost_usd: fc.double({ min: 0, max: 10, noNaN: true }),
})

const rangeArb = fc.constantFrom<UsageRange>('24h', '7d', '30d')

function inWindow(rows: UsageSessionRow[], range: UsageRange): UsageSessionRow[] {
  const { bucketS, count } = USAGE_RANGES[range]
  const end = Math.floor(NOW_S / bucketS) * bucketS + bucketS
  const start0 = end - count * bucketS
  return rows.filter((r) => {
    const at = r.last_active ?? r.started_at
    return at != null && at >= start0 && at < end
  })
}

describe('bucketRows', () => {
  it('fixed grid shape, increasing starts, conserves in-window sums', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), rangeArb, (rows, range) => {
        const grid = bucketRows(rows, NOW_S, range)
        expect(grid).toHaveLength(USAGE_RANGES[range].count)
        const starts = grid.map((b) => b.start_s)
        expect([...starts].sort((a, b) => a - b)).toEqual(starts)
        const kept = inWindow(rows, range)
        const sum = (key: keyof UsageBucket): number =>
          grid.reduce((n, b) => n + Number(b[key]), 0)
        expect(sum('sessions')).toBe(kept.length)
        expect(sum('requests')).toBeCloseTo(kept.reduce((n, r) => n + r.requests, 0), 6)
        expect(sum('cost_usd')).toBeCloseTo(kept.reduce((n, r) => n + r.cost_usd, 0), 6)
        expect(sum('input_tokens')).toBeCloseTo(kept.reduce((n, r) => n + r.input_tokens, 0), 6)
      }),
    )
  })
})

describe('kpisFromRows', () => {
  it('sums match rows and ratios stay in range', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), (rows) => {
        const kpis = kpisFromRows(rows, NOW_S)
        expect(kpis.sessions).toBe(rows.length)
        expect(kpis.requests).toBeCloseTo(rows.reduce((n, r) => n + r.requests, 0), 6)
        expect(kpis.cache_hit_ratio).toBeGreaterThanOrEqual(0)
        expect(kpis.cache_hit_ratio).toBeLessThanOrEqual(1)
        expect(kpis.active_sessions).toBeLessThanOrEqual(kpis.sessions)
      }),
    )
  })

  it('active requires not-ended and recent touch', () => {
    const base: UsageSessionRow = {
      id: 's',
      title: null,
      model: null,
      source: null,
      started_at: NOW_S - 100,
      last_active: NOW_S - 10,
      ended_at: null,
      duration_s: 90,
      requests: 1,
      messages: 1,
      tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 0,
    }
    expect(kpisFromRows([base], NOW_S).active_sessions).toBe(1)
    expect(kpisFromRows([{ ...base, ended_at: NOW_S - 5 }], NOW_S).active_sessions).toBe(0)
    expect(kpisFromRows([{ ...base, last_active: NOW_S - 3600 }], NOW_S).active_sessions).toBe(0)
  })
})

describe('halfDelta', () => {
  const bucket = (requests: number): UsageBucket => ({
    start_s: 0,
    requests,
    sessions: 0,
    messages: 0,
    tool_calls: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
  })

  it('null when prior half is empty; ratio otherwise', () => {
    expect(halfDelta([], 'requests')).toBeNull()
    expect(halfDelta([bucket(5)], 'requests')).toBeNull()
    expect(halfDelta([bucket(0), bucket(5)], 'requests')).toBeNull()
    expect(halfDelta([bucket(10), bucket(15)], 'requests')).toBeCloseTo(0.5)
    expect(halfDelta([bucket(10), bucket(5)], 'requests')).toBeCloseTo(-0.5)
  })
})

describe('foldSlices', () => {
  it('keeps at most `keep` slices, preserves the total, other goes last', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ name: fc.string({ minLength: 1, maxLength: 5 }), value: fc.nat({ max: 1000 }) }),
          { maxLength: 12 },
        ),
        (slices) => {
          const folded = foldSlices(slices)
          expect(folded.length).toBeLessThanOrEqual(4)
          const before = slices.filter((s) => s.value > 0).reduce((n, s) => n + s.value, 0)
          const after = folded.reduce((n, s) => n + s.value, 0)
          expect(after).toBe(before)
          folded.slice(0, -1).forEach((s) => expect(s.name).not.toBe('other'))
        },
      ),
    )
  })

  it('folds the tail beyond the top three into "other"', () => {
    const folded = foldSlices([
      { name: 'a', value: 10 },
      { name: 'b', value: 9 },
      { name: 'c', value: 8 },
      { name: 'd', value: 2 },
      { name: 'e', value: 1 },
    ])
    expect(folded.map((s) => s.name)).toEqual(['a', 'b', 'c', 'other'])
    expect(folded[3]!.value).toBe(3)
  })
})
