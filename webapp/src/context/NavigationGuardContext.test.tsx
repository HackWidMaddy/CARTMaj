/**
 * Unit tests for NavigationGuardContext (registry + useGuardedRouter).
 *
 * Run: npx vitest run src/context/NavigationGuardContext.test.tsx --no-file-parallelism
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import {
  NavigationGuardProvider,
  useNavigationGuard,
  useGuardedRouter,
} from './NavigationGuardContext'

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(NavigationGuardProvider, null, children)

describe('NavigationGuardContext', () => {
  beforeEach(() => pushMock.mockReset())

  it('useNavigationGuard returns null outside a provider', () => {
    const { result } = renderHook(() => useNavigationGuard())
    expect(result.current).toBeNull()
  })

  it('hasGuards reflects registration/unregistration', () => {
    const { result } = renderHook(() => useNavigationGuard(), { wrapper })
    const ctx = result.current!
    expect(ctx.hasGuards()).toBe(false)
    act(() => ctx.registerGuard('a', async () => true))
    expect(ctx.hasGuards()).toBe(true)
    act(() => ctx.unregisterGuard('a'))
    expect(ctx.hasGuards()).toBe(false)
  })

  it('confirmAllGuards returns true when no guards registered', async () => {
    const { result } = renderHook(() => useNavigationGuard(), { wrapper })
    let ok: boolean | undefined
    await act(async () => { ok = await result.current!.confirmAllGuards() })
    expect(ok).toBe(true)
  })

  it('confirmAllGuards runs every guard and returns true if all allow', async () => {
    const { result } = renderHook(() => useNavigationGuard(), { wrapper })
    const ctx = result.current!
    const g1 = vi.fn().mockResolvedValue(true)
    const g2 = vi.fn().mockResolvedValue(true)
    act(() => { ctx.registerGuard('1', g1); ctx.registerGuard('2', g2) })
    let ok: boolean | undefined
    await act(async () => { ok = await ctx.confirmAllGuards() })
    expect(ok).toBe(true)
    expect(g1).toHaveBeenCalledTimes(1)
    expect(g2).toHaveBeenCalledTimes(1)
  })

  it('confirmAllGuards stops at the first guard that cancels', async () => {
    const { result } = renderHook(() => useNavigationGuard(), { wrapper })
    const ctx = result.current!
    const g1 = vi.fn().mockResolvedValue(false)
    const g2 = vi.fn().mockResolvedValue(true)
    act(() => { ctx.registerGuard('1', g1); ctx.registerGuard('2', g2) })
    let ok: boolean | undefined
    await act(async () => { ok = await ctx.confirmAllGuards() })
    expect(ok).toBe(false)
    expect(g1).toHaveBeenCalledTimes(1)
    expect(g2).not.toHaveBeenCalled() // short-circuits
  })

  describe('useGuardedRouter', () => {
    it('pushes directly when no guards are registered', async () => {
      const { result } = renderHook(() => useGuardedRouter(), { wrapper })
      await act(async () => { await result.current.push('/x') })
      expect(pushMock).toHaveBeenCalledWith('/x')
    })

    it('pushes when the guard confirms', async () => {
      const { result } = renderHook(
        () => ({ nav: useNavigationGuard(), r: useGuardedRouter() }),
        { wrapper },
      )
      act(() => result.current.nav!.registerGuard('g', vi.fn().mockResolvedValue(true)))
      await act(async () => { await result.current.r.push('/y') })
      expect(pushMock).toHaveBeenCalledWith('/y')
    })

    it('does NOT push when the guard cancels', async () => {
      const { result } = renderHook(
        () => ({ nav: useNavigationGuard(), r: useGuardedRouter() }),
        { wrapper },
      )
      act(() => result.current.nav!.registerGuard('g', vi.fn().mockResolvedValue(false)))
      await act(async () => { await result.current.r.push('/z') })
      expect(pushMock).not.toHaveBeenCalled()
    })

    it('pushUnguarded bypasses guards entirely', async () => {
      const { result } = renderHook(
        () => ({ nav: useNavigationGuard(), r: useGuardedRouter() }),
        { wrapper },
      )
      act(() => result.current.nav!.registerGuard('g', vi.fn().mockResolvedValue(false)))
      act(() => result.current.r.pushUnguarded('/w'))
      expect(pushMock).toHaveBeenCalledWith('/w')
    })
  })
})
