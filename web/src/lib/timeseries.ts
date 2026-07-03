/** Pure time-bucketing for the live traffic chart (redesign S6).
 *
 * Turns the bounded WS `RecentRequest` feed into fixed-width buckets ending at
 * `now`, counting requests / errors and averaging latency per bucket. Pure and
 * deterministic (`now` is a parameter) so it is property-testable (PBT). */

import type { RecentRequest } from './reducer'

export interface TrafficBucket {
  /** bucket start, epoch ms */
  start: number
  requests: number
  errors: number
  /** mean latency of the bucket's requests, ms (0 when empty) */
  avgLatencyMs: number
}

/** Bucket `requests` into `bucketCount` windows of `bucketMs` ending at `now`.
 * Requests outside the covered range (or with unparsable timestamps) are
 * dropped. Invariants (tested): result length === bucketCount; sums of
 * requests/errors === kept entries; every entry maps into exactly one bucket. */
export function bucketRequests(
  requests: readonly RecentRequest[],
  now: number,
  bucketMs: number,
  bucketCount: number,
): TrafficBucket[] {
  const safeBucketMs = Math.max(1, Math.floor(bucketMs))
  const safeCount = Math.max(1, Math.floor(bucketCount))
  const end = now
  const startOfRange = end - safeBucketMs * safeCount

  const buckets: TrafficBucket[] = []
  const latencySums: number[] = []
  for (let i = 0; i < safeCount; i++) {
    buckets.push({
      start: startOfRange + i * safeBucketMs,
      requests: 0,
      errors: 0,
      avgLatencyMs: 0,
    })
    latencySums.push(0)
  }

  for (const request of requests) {
    const t = Date.parse(request.ts)
    if (Number.isNaN(t) || t < startOfRange || t >= end) continue
    const index = Math.min(safeCount - 1, Math.floor((t - startOfRange) / safeBucketMs))
    const bucket = buckets[index]!
    bucket.requests += 1
    if (request.status >= 400) bucket.errors += 1
    latencySums[index]! += Number.isFinite(request.latencyMs) ? request.latencyMs : 0
  }

  for (let i = 0; i < safeCount; i++) {
    const bucket = buckets[i]!
    bucket.avgLatencyMs = bucket.requests > 0 ? latencySums[i]! / bucket.requests : 0
  }
  return buckets
}
