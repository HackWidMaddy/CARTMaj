/**
 * D3 — internalKeyHeaders(): the webapp attaches X-Internal-Key when it proxies
 * to the agent's guarded (billed) endpoints. Verifies the header is populated
 * from INTERNAL_API_KEY, that a base header set is preserved/merged, and that an
 * absent secret degrades to '' (the agent guard fails open pre-secret, so an
 * empty value must not throw or drop the base headers).
 *
 * Run: npx vitest run src/lib/agentAuth.test.ts
 * @vitest-environment node
 */
import { describe, test, expect, afterEach } from 'vitest'
import { internalKeyHeaders } from './agentAuth'

const ORIGINAL = process.env.INTERNAL_API_KEY

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INTERNAL_API_KEY
  else process.env.INTERNAL_API_KEY = ORIGINAL
})

describe('internalKeyHeaders', () => {
  test('injects x-internal-key from INTERNAL_API_KEY', () => {
    process.env.INTERNAL_API_KEY = 'sekret-123'
    expect(internalKeyHeaders()['x-internal-key']).toBe('sekret-123')
  })

  test('preserves and merges base headers', () => {
    process.env.INTERNAL_API_KEY = 'sekret-123'
    const h = internalKeyHeaders({ 'Content-Type': 'application/json' })
    expect(h['Content-Type']).toBe('application/json')
    expect(h['x-internal-key']).toBe('sekret-123')
  })

  test('empty string when secret is unset (fail-open pre-secret, no throw)', () => {
    delete process.env.INTERNAL_API_KEY
    const h = internalKeyHeaders({ 'X-Keep': 'me' })
    expect(h['x-internal-key']).toBe('')
    expect(h['X-Keep']).toBe('me')
  })

  test('does not mutate the caller-provided base object', () => {
    process.env.INTERNAL_API_KEY = 'sekret-123'
    const base = { a: '1' }
    internalKeyHeaders(base)
    expect(base).not.toHaveProperty('x-internal-key')
  })
})
