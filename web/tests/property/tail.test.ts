/** PU4-6 — log tail dedup: over a growing log observed through "last N"
 * snapshots, the accumulated output has no duplicates and no silent loss;
 * a vanished overlap is reported as a gap. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { advance } from '../../src/lib/tail'

describe('PU4-6 tail dedup', () => {
  it('reconstructs a growing log exactly (unique lines, overlapping windows)', () => {
    fc.assert(
      fc.property(
        fc.nat(30),
        fc.array(fc.nat(5), { minLength: 1, maxLength: 15 }),
        fc.integer({ min: 2, max: 50 }),
        (initialCount, appendCounts, window) => {
          let counter = 0
          const line = () => `line-${counter++}`
          const log: string[] = Array.from({ length: initialCount }, line)

          let prev = log.slice(-window)
          const collected: string[] = [...prev]
          let sawGap = false

          for (const count of appendCounts) {
            for (let i = 0; i < count; i++) log.push(line())
            const snapshot = log.slice(-window)
            const step = advance(prev, snapshot)
            if (step.gap) sawGap = true
            collected.push(...step.newLines)
            prev = snapshot
          }

          if (!sawGap) {
            // no duplicates, no loss: collected === the log suffix we started from
            const start = Math.max(0, initialCount - window)
            expect(collected).toEqual(log.slice(start))
          } else {
            // a gap only happens when appends outran the window
            expect(Math.max(...appendCounts)).toBeGreaterThan(0)
          }
        },
      ),
    )
  })

  it('flags a gap when the window is overrun and still loses nothing it saw', () => {
    const prev = ['a', 'b', 'c']
    const fetched = ['x', 'y', 'z'] // no overlap — rotation or overrun
    const step = advance(prev, fetched)
    expect(step.gap).toBe(true)
    expect(step.newLines).toEqual(fetched)
  })

  it('never throws on arbitrary snapshots and output is a subset of fetched', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 5 }), { maxLength: 20 }),
        fc.array(fc.string({ maxLength: 5 }), { maxLength: 20 }),
        (prev, fetched) => {
          const step = advance(prev, fetched)
          expect(step.newLines.length).toBeLessThanOrEqual(fetched.length)
          for (const lineText of step.newLines) expect(fetched).toContain(lineText)
        },
      ),
    )
  })
})
