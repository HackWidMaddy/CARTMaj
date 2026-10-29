/**
 * The skill upload dialog opened from Agent Skills inside the chat SettingsModal. The dialog is
 * a portal whose React parent is the settings panel, so a click inside it stops at the panel and
 * never closes the overlay, and Escape closes only the dialog.
 *
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import { AlertProvider, ToastProvider } from '@/components/ui'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: 'alice' }) }))
vi.mock('@/hooks/useDetectedHostIp', () => ({ useDetectedHostIp: () => null }))

import { SettingsModal } from './SettingsModal'
import type { ProjectFormData } from './hooks/useSettingsModal'

function draw() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attack-skills/name-check') && init?.method === 'POST') {
      const names = JSON.parse(init.body as string).names as string[]
      return new Response(JSON.stringify({ results: names.map((n) => ({ normalized: n, available: true, suggestion: null })) }), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }))
  const setSettingsModal = vi.fn()
  const data = { attackSkillConfig: { builtIn: {}, user: {} } } as unknown as ProjectFormData
  render(
    <ToastProvider>
      <AlertProvider>
        <SettingsModal settingsModal="attack" setSettingsModal={setSettingsModal} projectFormData={data} updateProjectField={vi.fn()} projectId="p1" />
      </AlertProvider>
    </ToastProvider>,
  )
  return { setSettingsModal }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openUpload() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Upload Batch' })).toBeEnabled())
  const file = new File(['# Drawer skill\n\nBody.'], 'drawer.md', { type: 'text/markdown' })
  await act(async () => { fireEvent.change(screen.getByTestId('skill-upload-batch-input'), { target: { files: [file] } }) })
  return screen.findByRole('dialog')
}

describe('the upload dialog over the chat settings overlay', () => {
  test('clicks inside the dialog do not close the settings overlay', async () => {
    const { setSettingsModal } = draw()
    const dialog = await openUpload()
    fireEvent.click(dialog)
    fireEvent.click(within(dialog).getByLabelText('Name for drawer.md'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(setSettingsModal).not.toHaveBeenCalled()
    expect(screen.getByText('Agent Skills')).toBeInTheDocument()
  })

  test('Escape closes only the dialog; the Agent Skills window stays open', async () => {
    const { setSettingsModal } = draw()
    const dialog = await openUpload()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(setSettingsModal).not.toHaveBeenCalled()
    expect(screen.getByText('Agent Skills')).toBeInTheDocument()
    expect(screen.getByText(/Your own agent skills/)).toBeInTheDocument()
  })

  test('the drawer is a saved project, so the dialog offers "Turn them on"', async () => {
    draw()
    const dialog = await openUpload()
    expect(within(dialog).getByLabelText(/Turn them on in this project/)).toBeChecked()
  })
})
