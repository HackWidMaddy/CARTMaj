/**
 * Unit tests for the capture-proxy body-rules sanitizer (the webapp's allowlist
 * gate before family->policy rules reach the proxy env).
 *
 * Run: npx vitest run src/lib/captureBodyRules.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  sanitizeBodyRules, BODY_FAMILIES, BODY_POLICIES, BODY_RULES_RECOMMENDED,
} from './captureBodyRules'

describe('sanitizeBodyRules', () => {
  it('keeps valid family -> policy pairs', () => {
    expect(sanitizeBodyRules({ image: 'disk', json: 'auto', binary: 'meta' }))
      .toEqual({ image: 'disk', json: 'auto', binary: 'meta' })
  })

  it('drops unknown families', () => {
    expect(sanitizeBodyRules({ image: 'disk', bogusFamily: 'disk' }))
      .toEqual({ image: 'disk' })
  })

  it('drops invalid policies', () => {
    expect(sanitizeBodyRules({ image: 'banana', font: 'meta' }))
      .toEqual({ font: 'meta' })
  })

  it('drops non-string policy values', () => {
    expect(sanitizeBodyRules({ image: 42, font: 'meta', video: null, audio: true }))
      .toEqual({ font: 'meta' })
  })

  it('returns {} for non-object / array / null / undefined input', () => {
    expect(sanitizeBodyRules(null)).toEqual({})
    expect(sanitizeBodyRules(undefined)).toEqual({})
    expect(sanitizeBodyRules('image:disk')).toEqual({})
    expect(sanitizeBodyRules(['image', 'disk'])).toEqual({})
    expect(sanitizeBodyRules(123)).toEqual({})
  })

  it('accepts a full valid map unchanged', () => {
    expect(sanitizeBodyRules(BODY_RULES_RECOMMENDED)).toEqual(BODY_RULES_RECOMMENDED)
  })

  it('never throws on hostile input', () => {
    const hostile: unknown = { image: { nested: 'disk' }, __proto__: 'meta', constructor: 'disk' }
    expect(() => sanitizeBodyRules(hostile)).not.toThrow()
    // nested object value is dropped (not a string policy)
    expect(sanitizeBodyRules(hostile)).toEqual({})
  })
})

describe('allowlist / defaults consistency', () => {
  it('every Recommended family is a known family with a valid policy', () => {
    for (const [fam, pol] of Object.entries(BODY_RULES_RECOMMENDED)) {
      expect(BODY_FAMILIES).toContain(fam)
      expect(BODY_POLICIES).toContain(pol)
    }
  })

  it('Recommended covers every family', () => {
    for (const fam of BODY_FAMILIES) {
      expect(BODY_RULES_RECOMMENDED[fam]).toBeDefined()
    }
  })
})
