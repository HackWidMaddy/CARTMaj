/**
 * Unit tests for useDirtyState.
 *
 * Run: npx vitest run src/hooks/useDirtyState.test.tsx --no-file-parallelism
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDirtyState } from './useDirtyState'

describe('useDirtyState', () => {
  it('is not dirty initially (baseline adopts the first current)', () => {
    const { result } = renderHook(() => useDirtyState({ a: 1 }))
    expect(result.current.isDirty).toBe(false)
  })

  it('becomes dirty when current diverges from baseline', () => {
    const { result, rerender } = renderHook(({ v }) => useDirtyState(v), {
      initialProps: { v: { a: 1 } },
    })
    expect(result.current.isDirty).toBe(false)
    rerender({ v: { a: 2 } })
    expect(result.current.isDirty).toBe(true)
  })

  it('clears dirtiness when current reverts to the baseline (value-based)', () => {
    const { result, rerender } = renderHook(({ v }) => useDirtyState(v), {
      initialProps: { v: { a: 1, list: ['x'] } },
    })
    rerender({ v: { a: 2, list: ['x'] } })
    expect(result.current.isDirty).toBe(true)
    // New object, same values -> deepEqual clears dirtiness.
    rerender({ v: { a: 1, list: ['x'] } })
    expect(result.current.isDirty).toBe(false)
  })

  it('setBaseline adopts the current value and clears dirtiness', () => {
    const { result, rerender } = renderHook(({ v }) => useDirtyState(v), {
      initialProps: { v: { a: 1 } },
    })
    rerender({ v: { a: 2 } })
    expect(result.current.isDirty).toBe(true)
    act(() => result.current.setBaseline({ a: 2 }))
    expect(result.current.isDirty).toBe(false)
  })

  it('setBaseline accepts a functional updater (single-field adopt)', () => {
    // Mirrors ProjectForm.autoSaveField adopting one persisted field.
    const { result, rerender } = renderHook(({ v }) => useDirtyState(v), {
      initialProps: { v: { a: 1, b: 1 } },
    })
    rerender({ v: { a: 2, b: 1 } })
    expect(result.current.isDirty).toBe(true)
    act(() => result.current.setBaseline((prev) => ({ ...prev, a: 2 })))
    expect(result.current.isDirty).toBe(false)
    // A different field still shows dirty.
    rerender({ v: { a: 2, b: 9 } })
    expect(result.current.isDirty).toBe(true)
  })

  it('a new-but-deep-equal current reference does not read dirty', () => {
    const { result, rerender } = renderHook(({ v }) => useDirtyState(v), {
      initialProps: { v: { list: ['a', 'b'] } },
    })
    rerender({ v: { list: ['a', 'b'] } }) // new object + new array, same values
    expect(result.current.isDirty).toBe(false)
  })

  it('respects a custom isEqual comparator', () => {
    // Case-insensitive comparator: 'ABC' and 'abc' are equal -> not dirty.
    const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    const { result, rerender } = renderHook(({ v }) => useDirtyState(v, { isEqual: ci }), {
      initialProps: { v: 'abc' },
    })
    rerender({ v: 'ABC' })
    expect(result.current.isDirty).toBe(false)
    rerender({ v: 'xyz' })
    expect(result.current.isDirty).toBe(true)
  })
})
