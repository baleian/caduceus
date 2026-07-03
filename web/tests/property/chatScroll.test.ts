/** chat-ux-improvements FR-1/FR-2 — lazy-render window invariants: the
 * window is end-anchored and clamped to the transcript, growing never
 * shrinks it (fixed total), and the pinned predicate is a clean threshold. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  INITIAL_WINDOW,
  PIN_THRESHOLD_PX,
  WINDOW_CHUNK,
  growWindow,
  isPinned,
  windowStart,
} from '../../src/lib/chatScroll'

const nat = fc.nat(10_000)

describe('chatScroll window invariants', () => {
  it('growWindow: never shrinks (fixed total), always clamped to total', () => {
    fc.assert(
      fc.property(nat, nat, fc.nat(500), (visible, total, chunk) => {
        const next = growWindow(visible, total, chunk)
        expect(next).toBeLessThanOrEqual(total)
        expect(next).toBeGreaterThanOrEqual(Math.min(visible, total))
        // repeated growth converges on total and stays there
        const effectiveChunk = chunk || WINDOW_CHUNK
        let current = Math.min(visible, total)
        let guard = 0
        while (current < total && guard++ <= 10_001) current = growWindow(current, total, effectiveChunk)
        expect(current).toBe(total)
        expect(growWindow(total, total, chunk)).toBe(total)
      }),
    )
  })

  it('growWindow: a positive chunk makes strict progress until total', () => {
    fc.assert(
      fc.property(nat, nat, fc.integer({ min: 1, max: 500 }), (visible, total, chunk) => {
        if (visible < total) {
          expect(growWindow(visible, total, chunk)).toBeGreaterThan(visible)
        }
      }),
    )
  })

  it('windowStart: mounted slice is exactly the newest min(visible, total) items', () => {
    fc.assert(
      fc.property(nat, nat, (total, visible) => {
        const start = windowStart(total, visible)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(start).toBeLessThanOrEqual(total)
        expect(total - start).toBe(Math.min(Math.max(visible, 0), total))
      }),
    )
  })

  it('grow then windowStart: growing mounts strictly older items, keys stay stable', () => {
    fc.assert(
      fc.property(nat, fc.nat(200), (total, visible) => {
        const before = windowStart(total, visible)
        const after = windowStart(total, growWindow(visible, total))
        expect(after).toBeLessThanOrEqual(before) // window only extends upward
      }),
    )
  })

  it('isPinned: threshold boundary is inclusive and monotone in distance', () => {
    expect(isPinned(0)).toBe(true)
    expect(isPinned(PIN_THRESHOLD_PX)).toBe(true)
    expect(isPinned(PIN_THRESHOLD_PX + 1)).toBe(false)
    expect(isPinned(-5)).toBe(true) // elastic overscroll never unpins
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 10_000 }), fc.nat(1000), (distance, threshold) => {
        expect(isPinned(distance, threshold)).toBe(distance <= threshold)
      }),
    )
  })

  it('defaults are sane: initial window and chunk are positive', () => {
    expect(INITIAL_WINDOW).toBeGreaterThan(0)
    expect(WINDOW_CHUNK).toBeGreaterThan(0)
  })
})
