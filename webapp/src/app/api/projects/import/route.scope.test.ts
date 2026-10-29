/**
 * Import refuses a scope the create routes refuse, BEFORE anything is written.
 *
 * normalizeImportedScope() is unit-tested on its own; this pins that the route
 * acts on its refusal: a bundle targeting a government domain creates no project.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import JSZip from 'jszip'

const mockProjectCreate = vi.fn()

vi.mock('@/lib/access', () => ({ requireEffectiveUser: async () => ({ userId: 'new-owner' }) }))
vi.mock('@/lib/prisma', () => ({
  default: { project: { create: (...a: unknown[]) => mockProjectCreate(...a) } },
}))
vi.mock('@/app/api/graph/neo4j', () => ({ getGraphSession: vi.fn() }))
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: vi.fn() }))

import { POST } from './route'

async function bundle(project: Record<string, unknown>) {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify({ version: '1', projectName: 'Imported' }))
  zip.file('project.json', JSON.stringify({ id: 'old-project', userId: 'old-owner', name: 'Imported', ...project }))
  const buf = await zip.generateAsync({ type: 'uint8array' })
  const fd = new FormData()
  fd.set('file', new File([buf as BlobPart], 'export.zip', { type: 'application/zip' }))
  return new NextRequest('http://localhost:3000/api/projects/import', { method: 'POST', body: fd })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCreate.mockResolvedValue({ id: 'new-project', name: 'Imported' })
})

describe('import scope refusal', () => {
  test('a bundle targeting a government domain is refused and creates no project', async () => {
    const res = await POST(await bundle({ targetDomain: 'agency.gov.uk', subdomainList: [] }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('agency.gov.uk')
    expect(mockProjectCreate).not.toHaveBeenCalled()
  })
})
