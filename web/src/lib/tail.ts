/** Overlap-dedup follow for snapshot log endpoints (PU4-6 — U3 tail.py).
 *
 * The daemon exposes logs as "last N lines" snapshots; `advance` computes the
 * newly appended suffix between two snapshots by matching the largest overlap
 * between the previous snapshot's tail and the new snapshot's head. A vanished
 * overlap (rotation/window overrun) is reported as a gap, never silently
 * skipped.
 */

export interface TailStep {
  newLines: string[]
  gap: boolean
}

export function advance(prev: readonly string[], fetched: readonly string[]): TailStep {
  if (prev.length === 0) return { newLines: [...fetched], gap: false }
  if (fetched.length === 0) return { newLines: [], gap: false }
  const maxK = Math.min(prev.length, fetched.length)
  for (let k = maxK; k > 0; k--) {
    let match = true
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== fetched[i]) {
        match = false
        break
      }
    }
    if (match) return { newLines: fetched.slice(k), gap: false }
  }
  return { newLines: [...fetched], gap: true }
}
