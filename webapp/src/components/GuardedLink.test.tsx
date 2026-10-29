/**
 * Integration tests for GuardedLink: a next/link drop-in that consults the
 * navigation guard registry before navigating.
 *
 * Run: npx vitest run src/components/GuardedLink.test.tsx --no-file-parallelism
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { useEffect } from 'react'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, onClick, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} onClick={onClick} {...rest}>{children}</a>,
}))

import { GuardedLink } from './GuardedLink'
import { NavigationGuardProvider, useNavigationGuard } from '@/context/NavigationGuardContext'

/** Registers a guard resolving to `confirmResult` while `dirty`. */
function DirtyForm({ dirty, confirmResult }: { dirty: boolean; confirmResult: boolean }) {
  const nav = useNavigationGuard()
  useEffect(() => {
    if (!nav || !dirty) return
    nav.registerGuard('form', async () => confirmResult)
    return () => nav.unregisterGuard('form')
  }, [nav, dirty, confirmResult])
  return null
}

function setup(opts: { dirty: boolean; confirmResult?: boolean; href?: string }) {
  return render(
    <NavigationGuardProvider>
      <DirtyForm dirty={opts.dirty} confirmResult={opts.confirmResult ?? true} />
      <GuardedLink href={opts.href ?? '/dest'}>Go</GuardedLink>
    </NavigationGuardProvider>,
  )
}

describe('GuardedLink', () => {
  beforeEach(() => { pushMock.mockReset(); cleanup() })

  it('navigates normally (no interception) when nothing is dirty', () => {
    setup({ dirty: false })
    const link = screen.getByText('Go')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(ev) })
    // No guard -> we do not preventDefault and do not router.push (browser/Link handles it)
    expect(ev.defaultPrevented).toBe(false)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('blocks navigation and routes via router.push after confirm when dirty', async () => {
    setup({ dirty: true, confirmResult: true })
    const link = screen.getByText('Go')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true) // default Link nav prevented
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dest'))
  })

  it('blocks navigation and does NOT push when the user cancels', async () => {
    setup({ dirty: true, confirmResult: false })
    const link = screen.getByText('Go')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
    // Give the microtask queue a tick; push must never be called.
    await Promise.resolve()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('does not intercept modified (new-tab) clicks even when dirty', () => {
    setup({ dirty: true, confirmResult: true })
    const link = screen.getByText('Go')
    fireEvent.click(link, { metaKey: true })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('does not intercept external hrefs even when dirty', () => {
    setup({ dirty: true, confirmResult: true, href: 'https://example.com' })
    const link = screen.getByText('Go')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(pushMock).not.toHaveBeenCalled()
  })
})
