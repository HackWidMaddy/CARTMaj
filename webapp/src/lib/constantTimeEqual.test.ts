/**
 * S2/E2 — constant-time comparison helper.
 * Run: npx vitest run src/lib/constantTimeEqual.test.ts
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { constantTimeEqual } from './constantTimeEqual'

describe('constantTimeEqual', () => {
  test('equal strings → true', () => {
    expect(constantTimeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(constantTimeEqual('secret-key-123', 'secret-key-123')).toBe(true)
  })

  test('different same-length strings → false', () => {
    expect(constantTimeEqual('secret-key-123', 'secret-key-124')).toBe(false)
    expect(constantTimeEqual('a'.repeat(64), 'b' + 'a'.repeat(63))).toBe(false)
  })

  test('different-length strings → false (length guard)', () => {
    expect(constantTimeEqual('short', 'longer-value')).toBe(false)
    expect(constantTimeEqual('', 'x')).toBe(false)
  })

  test('empty vs empty → true', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })

  test('non-string inputs → false', () => {
    // @ts-expect-error deliberately wrong type
    expect(constantTimeEqual(undefined, 'x')).toBe(false)
    // @ts-expect-error deliberately wrong type
    expect(constantTimeEqual('x', null)).toBe(false)
  })
})
