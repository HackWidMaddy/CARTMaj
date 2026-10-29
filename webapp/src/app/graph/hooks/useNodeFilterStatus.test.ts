/**
 * The page-level node-filter status: the tab badge, and noticing an apply end.
 *
 * The Mute Rules view polls its own run, but it unmounts when the operator
 * switches tab. The page's hook is what keeps watching, so the graph is
 * refetched when an apply finishes wherever the operator is.
 *
 * Run: npx vitest run src/app/graph/hooks/useNodeFilterStatus.test.ts
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNodeFilterStatus } from './useNodeFilterStatus'

const status = (runningApply: boolean) => ({ armed: true, mode: 'denylist', activeRules: 1, activeKinds: 1, runningApply })
const reply = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useNodeFilterStatus', () => {
  test('apply_end_unseen_off_tab: an apply that ends while the view is closed still refetches the graph', async () => {
    const answers = [status(true), status(true), status(false)]
    vi.stubGlobal('fetch', vi.fn(() => reply(answers.shift() ?? status(false))))
    const onApplyFinished = vi.fn()

    const { result } = renderHook(() => useNodeFilterStatus('p1', onApplyFinished))
    await flush()
    expect(result.current.status?.runningApply).toBe(true)
    expect(onApplyFinished).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await flush()
    expect(onApplyFinished).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await flush()
    expect(result.current.status?.runningApply).toBe(false)
    expect(onApplyFinished).toHaveBeenCalledTimes(1)

    // Idle: no more polling.
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })

  test('a late answer for the previous project does not become the new project\'s badge', async () => {
    let releaseA: () => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/pA/')
      ? new Promise(resolve => { releaseA = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(status(true)) }) })
      : reply({ ...status(false), activeRules: 7 })))

    const { result, rerender } = renderHook(({ pid }) => useNodeFilterStatus(pid), { initialProps: { pid: 'pA' } })
    rerender({ pid: 'pB' })
    await flush()
    expect(result.current.status?.activeRules).toBe(7)
    await act(async () => { releaseA() })
    await flush()
    expect(result.current.status?.activeRules).toBe(7)
    expect(result.current.status?.runningApply).toBe(false)
  })
})
