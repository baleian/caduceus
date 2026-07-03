/** PU4-7 — redact gate: hex secrets never survive, output is bounded. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { redact } from '../../src/lib/redact'

const hexSecret = fc
  .array(fc.constantFrom(...'0123456789abcdefABCDEF'.split('')), {
    minLength: 32,
    maxLength: 64,
  })
  .map((chars) => chars.join(''))

describe('PU4-7 redact', () => {
  it('masks any embedded hex secret', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }),
        hexSecret,
        fc.string({ maxLength: 50 }),
        (a, secret, b) => {
          expect(redact(a + secret + b, 100_000)).not.toContain(secret)
        },
      ),
    )
  })

  it('bounds output length and never throws', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2000 }),
        fc.integer({ min: 0, max: 600 }),
        (text, limit) => {
          expect(redact(text, limit).length).toBeLessThanOrEqual(limit)
        },
      ),
    )
  })

  it('is a no-op for short non-hex text', () => {
    expect(redact('hello ⚙ world')).toBe('hello ⚙ world')
  })
})
