/** Redesign S6 — traffic bucketing: conservation (every in-range request lands
 * in exactly one bucket), fixed shape, and error/latency consistency. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { RecentRequest } from '../../src/lib/reducer'
import { bucketRequests } from '../../src/lib/timeseries'

const NOW = Date.parse('2026-07-03T12:00:00Z')

const requestArb = (rangeMs: number): fc.Arbitrary<RecentRequest> =>
  fc.record({
    // spread around the range: some inside, some before, some at/after `now`
    ts: fc
      .integer({ min: NOW - rangeMs * 2, max: NOW + 1000 })
      .map((t) => new Date(t).toISOString()),
    agent: fc.option(fc.string(), { nil: null }),
    model: fc.string(),
    status: fc.integer({ min: 100, max: 599 }),
    latencyMs: fc.integer({ min: 0, max: 60_000 }),
  })

describe('bucketRequests', () => {
  it('has fixed shape and conserves in-range requests and errors', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 120_000 }),
        fc.integer({ min: 1, max: 60 }),
        fc
          .integer({ min: 1_000, max: 240_000 })
          .chain((range) =>
            fc.array(requestArb(range), { maxLength: 100 }).map((list) => ({ range, list })),
          ),
        (bucketMs, bucketCount, { list }) => {
          const buckets = bucketRequests(list, NOW, bucketMs, bucketCount)

          expect(buckets).toHaveLength(bucketCount)
          // contiguous, ordered starts
          for (let i = 1; i < buckets.length; i++) {
            expect(buckets[i]!.start - buckets[i - 1]!.start).toBe(bucketMs)
          }

          const startOfRange = NOW - bucketMs * bucketCount
          const inRange = list.filter((r) => {
            const t = Date.parse(r.ts)
            return !Number.isNaN(t) && t >= startOfRange && t < NOW
          })
          const totalRequests = buckets.reduce((n, b) => n + b.requests, 0)
          const totalErrors = buckets.reduce((n, b) => n + b.errors, 0)
          expect(totalRequests).toBe(inRange.length)
          expect(totalErrors).toBe(inRange.filter((r) => r.status >= 400).length)

          for (const bucket of buckets) {
            expect(bucket.errors).toBeLessThanOrEqual(bucket.requests)
            if (bucket.requests === 0) expect(bucket.avgLatencyMs).toBe(0)
            else expect(bucket.avgLatencyMs).toBeGreaterThanOrEqual(0)
          }
        },
      ),
    )
  })

  it('every in-range request lands in the bucket covering its timestamp', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 60_000 }),
        fc.integer({ min: 2, max: 30 }),
        fc.integer({ min: 0, max: 1 }).chain(() => requestArb(120_000)),
        (bucketMs, bucketCount, request) => {
          const buckets = bucketRequests([request], NOW, bucketMs, bucketCount)
          const t = Date.parse(request.ts)
          const startOfRange = NOW - bucketMs * bucketCount
          const kept = !Number.isNaN(t) && t >= startOfRange && t < NOW
          const hit = buckets.filter((b) => b.requests > 0)
          if (!kept) {
            expect(hit).toHaveLength(0)
          } else {
            expect(hit).toHaveLength(1)
            const bucket = hit[0]!
            expect(t).toBeGreaterThanOrEqual(bucket.start)
            // the last bucket absorbs the boundary rounding
            const end = bucket.start + bucketMs
            const isLast = bucket === buckets[buckets.length - 1]
            if (!isLast) expect(t).toBeLessThan(end)
            expect(bucket.avgLatencyMs).toBe(request.latencyMs)
          }
        },
      ),
    )
  })
})
