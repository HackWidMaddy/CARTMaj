/**
 * Unit tests for useUnsavedChangesGuard.
 *
 * Run: npx vitest run src/hooks/useUnsavedChangesGuard.test.tsx --no-file-parallelism
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const confirmMock = vi.fn<(message: string, title?: string) => Promise<boolean>>()

vi.mock('@/components/ui', () => ({
  useAlertModal: () => ({ confirm: confirmMock }),
}))

// A configurable nav-guard mock so tests can assert registration behaviour.
let navMock: {
  registerGuard: ReturnType<typeof vi.fn>
  unregisterGuard: ReturnType<typeof vi.fn>
  confirmAllGuards: ReturnType<typeof vi.fn>
  hasGuards: ReturnType<typeof vi.fn>
} | null = null

vi.mock('@/context/NavigationGuardContext', () => ({
  useNavigationGuard: () => navMock,
}))

import { useUnsavedChangesGuard } from './useUnsavedChangesGuard'

function freshNav() {
  return {
    registerGuard: vi.fn(),
    unregisterGuard: vi.fn(),
    confirmAllGuards: vi.fn(),
    hasGuards: vi.fn(),
  }
}

describe('useUnsavedChangesGuard', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    navMock = null
  })

  it('confirmDiscard resolves true without prompting when not dirty', async () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(false))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.confirmDiscard()
    })
    expect(ok).toBe(true)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('confirmDiscard resolves the modal result when dirty', async () => {
    confirmMock.mockResolvedValue(true)
    const { result } = renderHook(() => useUnsavedChangesGuard(true))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.confirmDiscard()
    })
    expect(ok).toBe(true)
    expect(confirmMock).toHaveBeenCalledTimes(1)

    confirmMock.mockResolvedValue(false)
    const { result: r2 } = renderHook(() => useUnsavedChangesGuard(true))
    let ok2: boolean | undefined
    await act(async () => {
      ok2 = await r2.current.confirmDiscard()
    })
    expect(ok2).toBe(false)
  })

  it('uses a custom message/title', async () => {
    confirmMock.mockResolvedValue(true)
    const { result } = renderHook(() =>
      useUnsavedChangesGuard(true, { message: 'M', title: 'T' }),
    )
    await act(async () => { await result.current.confirmDiscard() })
    expect(confirmMock).toHaveBeenCalledWith('M', 'T')
  })

  it('guardedNavigate runs fn only when the user confirms', async () => {
    confirmMock.mockResolvedValue(false)
    const fn = vi.fn()
    const { result } = renderHook(() => useUnsavedChangesGuard(true))
    await act(async () => {
      await result.current.guardedNavigate(fn)
    })
    expect(fn).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await act(async () => {
      await result.current.guardedNavigate(fn)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent confirms into a single modal', async () => {
    let resolveConfirm!: (v: boolean) => void
    confirmMock.mockReturnValue(new Promise<boolean>((res) => { resolveConfirm = res }))
    const { result } = renderHook(() => useUnsavedChangesGuard(true))
    await act(async () => {
      const p1 = result.current.confirmDiscard()
      const p2 = result.current.confirmDiscard()
      resolveConfirm(true)
      const [a, b] = await Promise.all([p1, p2])
      expect(a).toBe(true)
      expect(b).toBe(true)
    })
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it('adds a beforeunload listener only while dirty', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')

    const { rerender, unmount } = renderHook(({ d }) => useUnsavedChangesGuard(d), {
      initialProps: { d: false },
    })
    expect(add).not.toHaveBeenCalledWith('beforeunload', expect.any(Function))

    rerender({ d: true })
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    rerender({ d: false })
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    unmount()
    add.mockRestore()
    remove.mockRestore()
  })

  it('registers with the nav guard while dirty and unregisters when clean', () => {
    navMock = freshNav()
    const { rerender, unmount } = renderHook(({ d }) => useUnsavedChangesGuard(d), {
      initialProps: { d: false },
    })
    expect(navMock.registerGuard).not.toHaveBeenCalled()

    rerender({ d: true })
    expect(navMock.registerGuard).toHaveBeenCalledTimes(1)
    const registeredId = navMock.registerGuard.mock.calls[0][0]

    rerender({ d: false })
    expect(navMock.unregisterGuard).toHaveBeenCalledWith(registeredId)

    unmount()
  })

  it('trackGlobal:false skips beforeunload and nav registration but still confirms locally', async () => {
    navMock = freshNav()
    const add = vi.spyOn(window, 'addEventListener')
    confirmMock.mockResolvedValue(true)

    const { result } = renderHook(() =>
      useUnsavedChangesGuard(true, { trackGlobal: false }),
    )
    // No global side effects...
    expect(navMock.registerGuard).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalledWith('beforeunload', expect.any(Function))
    // ...but the local confirm still works.
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.confirmDiscard() })
    expect(ok).toBe(true)
    expect(confirmMock).toHaveBeenCalledTimes(1)

    add.mockRestore()
  })
})
