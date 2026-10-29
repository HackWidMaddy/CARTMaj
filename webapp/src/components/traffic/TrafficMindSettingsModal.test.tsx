/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const toastSuccess = vi.fn()
const toastError = vi.fn()
const confirmMock = vi.fn<() => Promise<boolean>>()

// Lightweight stand-ins for the shared UI kit so the test exercises the modal's
// save/dirty logic, not the design system.
vi.mock('@/components/ui', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError }),
  useAlertModal: () => ({ confirm: confirmMock }),
  Toggle: ({ checked, onChange, 'aria-label': label }: { checked: boolean; onChange: (v: boolean) => void; 'aria-label': string }) => (
    <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WikiInfoButton: () => null,
}))
vi.mock('@/components/ui/Modal/Modal', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => (isOpen ? <div>{children}</div> : null),
}))
vi.mock('@/components/traffic/TrafficMindProjectMatrix', () => ({
  TrafficMindProjectMatrix: () => <div data-testid="matrix" />,
}))

import { TrafficMindSettingsModal } from './TrafficMindSettingsModal'

// A stateful fake of /api/users/[id]/settings: GET returns current server state,
// PUT merges the patch and echoes it back (like the real route).
function mockSettingsApi() {
  const serverState: Record<string, unknown> = {}
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
    if (!init || (init.method ?? 'GET') === 'GET') {
      return { ok: true, json: async () => ({ ...serverState }) } as Response
    }
    Object.assign(serverState, JSON.parse(init.body as string))
    return { ok: true, json: async () => ({ ...serverState }) } as Response
  }) as typeof fetch)
  const puts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')
  const lastPutBody = () => JSON.parse((puts().at(-1)![1] as RequestInit).body as string)
  return { fetchMock, puts, lastPutBody }
}

async function renderOpen() {
  const onClose = vi.fn()
  render(<TrafficMindSettingsModal isOpen onClose={onClose} userId="user-1" />)
  // Initial GET load settles → Apply button present.
  await screen.findByRole('button', { name: 'Apply' })
  return { onClose }
}

describe('TrafficMindSettingsModal — batched Apply', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    toastSuccess.mockReset()
    toastError.mockReset()
    confirmMock.mockReset()
  })
  afterEach(() => cleanup())

  test('starts clean: Apply disabled, no Revert, no PUT on load', async () => {
    const api = mockSettingsApi()
    await renderOpen()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull()
    expect(screen.getByText('All changes saved')).toBeInTheDocument()
    expect(api.puts()).toHaveLength(0)
  })

  test('editing a number field marks dirty but does NOT persist until Apply', async () => {
    const api = mockSettingsApi()
    await renderOpen()
    fireEvent.change(screen.getByDisplayValue('8888'), { target: { value: '9000' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    expect(screen.getByText('● Unsaved changes')).toBeInTheDocument()
    expect(api.puts()).toHaveLength(0) // nothing persisted yet
  })

  test('toggling a switch does NOT persist until Apply', async () => {
    const api = mockSettingsApi()
    await renderOpen()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Store bodies' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    expect(api.puts()).toHaveLength(0)
  })

  test('Apply sends ONE PUT with only the changed fields (one respawn for many edits)', async () => {
    const api = mockSettingsApi()
    await renderOpen()
    fireEvent.change(screen.getByDisplayValue('8888'), { target: { value: '9000' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Store bodies' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Passive detections' }))

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(api.puts()).toHaveLength(1))
    expect(api.lastPutBody()).toEqual({
      captureProxyPort: 9000,
      captureProxyStoreBodies: false,
      captureProxyPassiveDetect: false,
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  test('after a successful Apply the form is clean again', async () => {
    mockSettingsApi()
    await renderOpen()
    fireEvent.change(screen.getByDisplayValue('8888'), { target: { value: '9000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled())
    expect(screen.getByText('All changes saved')).toBeInTheDocument()
  })

  test('Revert drops pending edits without any PUT', async () => {
    const api = mockSettingsApi()
    await renderOpen()
    fireEvent.change(screen.getByDisplayValue('8888'), { target: { value: '9000' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled())
    expect(screen.getByDisplayValue('8888')).toBeInTheDocument()
    expect(api.puts()).toHaveLength(0)
  })

  test('master toggle is batched: off + Apply sends captureProxyEnabled:false once', async () => {
    const api = mockSettingsApi()
    await renderOpen()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable TrafficMind capture' }))
    // Sub-sections collapse; still no PUT until Apply.
    expect(api.puts()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(api.puts()).toHaveLength(1))
    expect(api.lastPutBody()).toEqual({ captureProxyEnabled: false })
  })

  test('closing with unsaved edits asks to confirm and respects a cancel', async () => {
    mockSettingsApi()
    const { onClose } = await renderOpen()
    fireEvent.change(screen.getByDisplayValue('8888'), { target: { value: '9000' } })

    confirmMock.mockResolvedValueOnce(false) // user cancels the discard
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()

    confirmMock.mockResolvedValueOnce(true) // user confirms discard
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  test('closing a clean form does not prompt', async () => {
    mockSettingsApi()
    const { onClose } = await renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(confirmMock).not.toHaveBeenCalled()
  })

  test('a failed Apply keeps the edits and warns', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
      if (!init || (init.method ?? 'GET') === 'GET') return { ok: true, json: async () => ({}) } as Response
      return { ok: false, json: async () => ({}) } as Response // PUT rejected
    }) as typeof fetch)
    await renderOpen()
    fireEvent.change(screen.getByDisplayValue('8888'), { target: { value: '9000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // Edit survives → still dirty, value unchanged.
    expect(screen.getByDisplayValue('9000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    fetchMock.mockRestore()
  })
})
