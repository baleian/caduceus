/** observability-redesign S9 — formatting units: one formatter per unit
 * family; edges (0, NaN, sub-cent, >1M) and suffix boundaries. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  bucketLabel,
  deriveSessionTitle,
  formatCost,
  formatCount,
  formatDuration,
  formatMs,
  formatPct,
  formatUsd,
  isMachineId,
  shortDateTime,
  timeAgo,
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

describe('timeAgo (fractional-epoch bug fix)', () => {
  it('parses a fractional epoch-seconds string instead of echoing it raw', () => {
    const now = 1_783_148_691_503 + 120_000
    const out = timeAgo('1783148691.5026166', now)
    expect(out).toBe('2m ago')
    expect(out).not.toContain('1783148691')
  })

  it('handles ISO, ms-epoch and absent inputs', () => {
    const now = Date.parse('2026-07-04T12:00:00Z')
    expect(timeAgo(new Date(now - 5_000).toISOString(), now)).toBe('just now')
    expect(timeAgo(now - 3_600_000, now)).toBe('1h ago') // already-ms epoch (≥1e11)
    expect(timeAgo(null)).toBe('')
    expect(timeAgo('')).toBe('')
  })
})

describe('formatCost', () => {
  it('hides zero/absent as an em-dash and formats non-zero', () => {
    expect(formatCost(0)).toBe('—')
    expect(formatCost(null)).toBe('—')
    expect(formatCost(undefined)).toBe('—')
    expect(formatCost(Number.NaN)).toBe('—')
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatCost(1.5)).toBe('$1.50')
  })
})

describe('session titles', () => {
  it('detects opaque machine ids', () => {
    expect(isMachineId('api_1783148667_43246421')).toBe(true)
    expect(isMachineId('1783148691.5026166')).toBe(true)
    expect(isMachineId('renamed-e2e')).toBe(false)
    expect(isMachineId('My notes')).toBe(false)
  })

  it('derives a friendly title: human → first message → date → fallback', () => {
    expect(deriveSessionTitle({ title: 'renamed-e2e' })).toBe('renamed-e2e')
    expect(
      deriveSessionTitle({ title: 'api_1783148667_43246421', firstUserText: 'Hello there\nmore' }),
    ).toBe('Hello there')
    expect(
      deriveSessionTitle({
        title: 'api_1783148667_43246421',
        startedAt: Date.parse('2026-07-04T13:22:00') / 1000,
      }),
    ).toMatch(/^Chat · \d{2}\/\d{2} \d{2}:\d{2}$/)
    expect(deriveSessionTitle({})).toBe('New chat')
  })
})
