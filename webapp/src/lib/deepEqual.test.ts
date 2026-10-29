import { describe, it, expect } from 'vitest'
import { deepEqual } from './deepEqual'

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('a', 'a')).toBe(true)
    expect(deepEqual(true, true)).toBe(true)
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual('a', 'b')).toBe(false)
    expect(deepEqual(0, false as unknown)).toBe(false)
  })

  it('treats two NaNs as equal', () => {
    expect(deepEqual(NaN, NaN)).toBe(true)
    expect(deepEqual(NaN, 1)).toBe(false)
  })

  it('distinguishes null, undefined and empty string', () => {
    expect(deepEqual(null, undefined)).toBe(false)
    expect(deepEqual(null, '')).toBe(false)
    expect(deepEqual(undefined, '')).toBe(false)
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(undefined, undefined)).toBe(true)
  })

  it('is key-order independent for objects', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false)
  })

  it('detects differing key sets', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false)
  })

  it('compares arrays by order and length', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual([], [])).toBe(true)
  })

  it('does not treat an array as equal to an object', () => {
    expect(deepEqual([], {})).toBe(false)
  })

  it('compares nested arrays and Record<string,string> maps', () => {
    const a = { rules: { json: 'store', html: 'skip' }, ips: ['1.1.1.1', '2.2.2.2'] }
    const b = { ips: ['1.1.1.1', '2.2.2.2'], rules: { html: 'skip', json: 'store' } }
    expect(deepEqual(a, b)).toBe(true)
    const c = { rules: { json: 'skip', html: 'skip' }, ips: ['1.1.1.1', '2.2.2.2'] }
    expect(deepEqual(a, c)).toBe(false)
  })

  it('handles a large flat form-like object', () => {
    const base = { name: 'x', port: 8888, enabled: true, list: ['a'], desc: null }
    expect(deepEqual(base, { ...base })).toBe(true)
    expect(deepEqual(base, { ...base, port: 9000 })).toBe(false)
    expect(deepEqual(base, { ...base, desc: '' })).toBe(false)
  })
})
