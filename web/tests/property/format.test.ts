/** observability-redesign S9 — formatting units: one formatter per unit
 * family; edges (0, NaN, sub-cent, >1M) and suffix boundaries. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  bucketLabel,
  formatCount,
  formatDuration,
  formatMs,
  formatPct,
  formatUsd,
  shortDateTime,
} from '../../src/lib/format'

describe('formatCount', () => {
  it('keeps small integers verbatim and abbreviates thousands/millions', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1200)).toBe('1.2k')
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(3_400_000)).toBe('3.4M')
    expect(formatCount(2_000_000_000)).toBe('2B')
  })

  it('never throws and never returns empty for any finite/non-finite input', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (value) => {
        const out = formatCount(value)
        expect(typeof out).toBe('string')
        expect(out.length).toBeGreaterThan(0)
      }),
    )
  })
})

describe('formatUsd', () => {
  it('adapts precision to magnitude', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(formatUsd(1234)).toBe('$1.2k')
  })
})

describe('formatMs', () => {
  it('rounds ms and promotes to seconds at 1000', () => {
    expect(formatMs(0)).toBe('0ms')
    expect(formatMs(45.4)).toBe('45ms')
    expect(formatMs(999.4)).toBe('999ms')
    expect(formatMs(1200)).toBe('1.2s')
  })
})

describe('formatPct / formatDuration', () => {
  it('formats ratios and durations', () => {
    expect(formatPct(0)).toBe('0%')
    expect(formatPct(0.372)).toBe('37%')
    expect(formatPct(1)).toBe('100%')
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(200)).toBe('3m 20s')
    expect(formatDuration(4320)).toBe('1h 12m')
  })

  it('pct stays within sane bounds for ratios in [0,1]', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (ratio) => {
        const parsed = Number.parseInt(formatPct(ratio), 10)
        expect(parsed).toBeGreaterThanOrEqual(0)
        expect(parsed).toBeLessThanOrEqual(100)
      }),
    )
  })
})

describe('bucketLabel / shortDateTime', () => {
  it('daily buckets get a date, finer buckets get a time', () => {
    const noonS = Date.parse('2026-07-04T12:00:00') / 1000
    expect(bucketLabel(noonS, 86_400)).toMatch(/^\d{2}\/\d{2}$/)
    expect(bucketLabel(noonS, 21_600)).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/)
    expect(bucketLabel(noonS, 3600)).toMatch(/^\d{2}:\d{2}$/)
    expect(bucketLabel(noonS, 10)).toMatch(/^\d{2}:\d{2}$/)
  })

  it('shortDateTime handles null', () => {
    expect(shortDateTime(null)).toBe('—')
    expect(shortDateTime(Date.parse('2026-07-04T13:22:00') / 1000)).toMatch(
      /^\d{2}\/\d{2} \d{2}:\d{2}$/,
    )
  })
})
