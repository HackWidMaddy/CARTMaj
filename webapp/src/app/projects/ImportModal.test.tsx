/**
 * The import dialog shows what the import changed or dropped.
 *
 * The route drops batch hosts the current rules refuse (and trims skill toggles,
 * and notes Jev fallbacks) and says so in `warnings`. The dialog used to show
 * only the counts, so a dropped host was never seen by the person importing.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('@/components/ui', async (orig) => ({ ...(await orig<typeof import('@/components/ui')>()), useToast: () => toast }))

import { ImportModal } from './ImportModal'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const STATS = { conversations: 0, messages: 0, remediations: 0, reports: 0, neo4jNodes: 0, neo4jRelationships: 0, artifacts: 0 }

async function importWith(response: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => response }))
  const { container } = render(<ImportModal isOpen userId="u1" onClose={vi.fn()} onSuccess={vi.fn()} />)
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['zip'], 'export.zip', { type: 'application/zip' })] } })
  fireEvent.click(screen.getByRole('button', { name: /Import/ }))
  await waitFor(() => screen.getByText('Import Successful'))
}

describe('import warnings', () => {
  test('each warning in the response is listed after a successful import', async () => {
    await importWith({
      success: true, projectId: 'p1', projectName: 'Imported', stats: STATS,
      warnings: ['Dropped hostnames the current rules refuse: not a host', 'Skill toggles trimmed'],
    })
    const items = screen.getAllByRole('listitem').map(li => li.textContent)
    expect(items).toEqual(['Dropped hostnames the current rules refuse: not a host', 'Skill toggles trimmed'])
  })
})
