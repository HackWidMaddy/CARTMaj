/**
 * Unit tests for the /graph hard render cap (utils/nodeCap.ts).
 *
 * Pins the threshold value and the boundary behavior of isOverNodeCap so any
 * change to the 100k cap is an explicit, reviewed change.
 *
 * Run: npx vitest run src/app/graph/utils/nodeCap.test.ts
 */

import { describe, test, expect } from 'vitest'
import { MAX_RENDER_NODES, isOverNodeCap } from './nodeCap'

describe('nodeCap', () => {
  test('MAX_RENDER_NODES is pinned to 100,000', () => {
    expect(MAX_RENDER_NODES).toBe(100000)
  })

  test('below the cap renders (not over)', () => {
    expect(isOverNodeCap(0)).toBe(false)
    expect(isOverNodeCap(1)).toBe(false)
    expect(isOverNodeCap(3617)).toBe(false) // real largest test project
    expect(isOverNodeCap(99999)).toBe(false)
  })

  test('exactly at the cap still renders (strict greater-than)', () => {
    expect(isOverNodeCap(MAX_RENDER_NODES)).toBe(false)
    expect(isOverNodeCap(100000)).toBe(false)
  })

  test('above the cap is blocked', () => {
    expect(isOverNodeCap(100001)).toBe(true)
    expect(isOverNodeCap(150000)).toBe(true)
    expect(isOverNodeCap(1000000)).toBe(true)
  })
})
