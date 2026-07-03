/** PU4-5 — toolsets editor round-trip is lossless for canonical entries;
 * validators are total and mirror the server constants. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  AGENT_NAME_RE,
  parseToolsetsText,
  renderToolsetsText,
  validateAgentForm,
  validateAgentName,
  validateUpstream,
} from '../../src/lib/forms'

const canonicalEntry = fc.stringMatching(/^[a-zA-Z0-9_.:-]{1,20}$/)

describe('PU4-5 forms', () => {
  it('toolsets round-trip: parse(render(xs)) === xs for canonical entries', () => {
    fc.assert(
      fc.property(fc.array(canonicalEntry, { maxLength: 20 }), (toolsets) => {
        expect(parseToolsetsText(renderToolsetsText(toolsets))).toEqual(toolsets)
      }),
    )
  })

  it('parse is total and always yields canonical entries', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        for (const entry of parseToolsetsText(text)) {
          expect(entry).not.toBe('')
          expect(entry).toBe(entry.trim())
          expect(entry).not.toMatch(/\n/)
        }
      }),
    )
  })

  it('render∘parse is idempotent (canonicalization fixpoint)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const once = renderToolsetsText(parseToolsetsText(text))
        expect(renderToolsetsText(parseToolsetsText(once))).toBe(once)
      }),
    )
  })

  it('agent-name validation mirrors the server regex exactly', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 70 }), (name) => {
        const valid = AGENT_NAME_RE.test(name) && name !== 'default'
        expect(validateAgentName(name) === null).toBe(valid)
      }),
    )
  })

  it('form validation is total over arbitrary field values', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ maxLength: 70 }),
          docker_image: fc.string({ maxLength: 600 }),
          network_mode: fc.string({ maxLength: 20 }),
          allow_private_urls: fc.boolean(),
          cpu: fc.string({ maxLength: 10 }),
          memory_mb: fc.string({ maxLength: 10 }),
          persona: fc.string({ maxLength: 300 }),
        }),
        (values) => {
          const errors = validateAgentForm(values)
          expect(typeof errors).toBe('object')
        },
      ),
    )
  })

  it('upstream validation accepts http(s) URLs and env var names only', () => {
    expect(validateUpstream('http://127.0.0.1:8000/v1', '')).toEqual({})
    expect(validateUpstream('https://x.test/v1', 'MY_KEY_2')).toEqual({})
    expect(validateUpstream('ftp://x', 'ok').base_url).toBeDefined()
    expect(validateUpstream('http://x', 'lower').api_key_env).toBeDefined()
  })
})
