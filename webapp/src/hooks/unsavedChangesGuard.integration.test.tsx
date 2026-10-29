/**
 * End-to-end smoke test of the unsaved-changes system wired together with the
 * REAL AlertProvider + NavigationGuardProvider + useDirtyState +
 * useUnsavedChangesGuard (nothing mocked but next/navigation). Exercises the
 * full path: edit -> dirty -> a sidebar-style navigator consults the registry
 * -> the real confirm modal appears -> Cancel stays / Confirm proceeds -> save
 * clears dirtiness and unregisters the guard.
 *
 * Run: npx vitest run src/hooks/unsavedChangesGuard.integration.test.tsx --no-file-parallelism
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { useState } from 'react'

// The provider module imports useRouter at load; stub it (unused by the provider itself).
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { AlertProvider } from '@/components/ui'
import { NavigationGuardProvider, useNavigationGuard } from '@/context/NavigationGuardContext'
import { useDirtyState } from './useDirtyState'
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard'

function Form() {
  const [value, setValue] = useState('start')
  const { isDirty, setBaseline } = useDirtyState(value)
  useUnsavedChangesGuard(isDirty)
  return (
    <div>
      <input aria-label="field" value={value} onChange={(e) => setValue(e.target.value)} />
      <span data-testid="dirty">{isDirty ? 'dirty' : 'clean'}</span>
      <button onClick={() => setBaseline(value)}>save</button>
    </div>
  )
}

function Sidebar({ onResult }: { onResult: (ok: boolean) => void }) {
  const nav = useNavigationGuard()
  return <button onClick={async () => onResult(await nav!.confirmAllGuards())}>navigate</button>
}

function renderApp() {
  const results: boolean[] = []
  render(
    <AlertProvider>
      <NavigationGuardProvider>
        <Form />
        <Sidebar onResult={(ok) => results.push(ok)} />
      </NavigationGuardProvider>
    </AlertProvider>,
  )
  return results
}

describe('unsaved-changes system (integration)', () => {
  beforeEach(() => cleanup())

  it('does not prompt when the form is clean', async () => {
    const results = renderApp()
    expect(screen.getByTestId('dirty').textContent).toBe('clean')
    await act(async () => { fireEvent.click(screen.getByText('navigate')) })
    // No confirm modal, navigation allowed immediately.
    expect(screen.queryByText('Confirm')).toBeNull()
    await waitFor(() => expect(results).toEqual([true]))
  })

  it('prompts when dirty and blocks navigation on Cancel', async () => {
    const results = renderApp()
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'edited' } })
    expect(screen.getByTestId('dirty').textContent).toBe('dirty')

    await act(async () => { fireEvent.click(screen.getByText('navigate')) })
    const cancel = await screen.findByText('Cancel')
    await act(async () => { fireEvent.click(cancel) })
    await waitFor(() => expect(results).toEqual([false]))
    // Exactly one prompt was shown (no duplicate guard).
    expect(screen.queryByText('Discard changes?')).toBeNull()
  })

  it('prompts when dirty and allows navigation on Confirm', async () => {
    const results = renderApp()
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'edited' } })

    await act(async () => { fireEvent.click(screen.getByText('navigate')) })
    const confirm = await screen.findByText('Confirm')
    await act(async () => { fireEvent.click(confirm) })
    await waitFor(() => expect(results).toEqual([true]))
    // Exactly one prompt (a second modal here would prove a duplicate guard).
    expect(screen.queryByText('Discard changes?')).toBeNull()
  })

  it('reverting the edit clears dirtiness (no prompt) without saving', async () => {
    const results = renderApp()
    const input = screen.getByLabelText('field')
    fireEvent.change(input, { target: { value: 'edited' } })
    expect(screen.getByTestId('dirty').textContent).toBe('dirty')
    fireEvent.change(input, { target: { value: 'start' } })
    expect(screen.getByTestId('dirty').textContent).toBe('clean')

    await act(async () => { fireEvent.click(screen.getByText('navigate')) })
    expect(screen.queryByText('Confirm')).toBeNull()
    await waitFor(() => expect(results).toEqual([true]))
  })

  it('saving clears dirtiness so later navigation does not prompt', async () => {
    const results = renderApp()
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'edited' } })
    fireEvent.click(screen.getByText('save'))
    expect(screen.getByTestId('dirty').textContent).toBe('clean')

    await act(async () => { fireEvent.click(screen.getByText('navigate')) })
    expect(screen.queryByText('Confirm')).toBeNull()
    await waitFor(() => expect(results).toEqual([true]))
  })
})
