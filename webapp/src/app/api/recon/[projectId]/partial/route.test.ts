/**
 * Partial recon start: the history row records the scope the orchestrator
 * GRANTED (its returned `roots`), never the scope the client asked for.
 *
 * Fixture roots are alpha.test / beta.test / gamma.test only.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  findUnique: vi.fn(),
  orchestratorFetch: vi.fn(),
  recordScanStart: vi.fn(),
  legacy: vi.fn(),
}))

vi.mock('@/lib/access', () => ({ guardProject: (...a: unknown[]) => h.guard(...a) }))
vi.mock('@/lib/session', () => ({ getEffectiveUser: async () => ({ userId: 'u1' }) }))
vi.mock('@/lib/scanTimeline', () => ({ recordScanStart: (...a: unknown[]) => h.recordScanStart(...a) }))
vi.mock('@/lib/prisma', () => ({ default: { project: { findUnique: (...a: unknown[]) => h.findUnique(...a) } } }))
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: (...a: unknown[]) => h.orchestratorFetch(...a) }))
vi.mock('@/lib/activationLock', () => ({ assertGraphNotActivating: async () => null }))
vi.mock('@/lib/nodeFilterRun', () => ({ describeNodeFilterWriter: async () => null }))
vi.mock('@/lib/legacyGraph', async orig => ({
  ...(await orig<typeof import('@/lib/legacyGraph')>()),
  legacyGraphDomains: (...a: unknown[]) => h.legacy(...a),
}))

import { POST } from './route'

function post(body: unknown) {
  return POST(
    new NextRequest('http://x/api/recon/p1/partial', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ projectId: 'p1' }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  h.guard.mockResolvedValue(null)
  h.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1', targetDomain: '' })
  h.legacy.mockResolvedValue([])
  h.orchestratorFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ run_id: 'r1', status: 'running', roots: ['alpha.test', 'beta.test'] }),
  })
})

describe('partial recon start', () => {
  test('forwards the requested roots to the orchestrator', async () => {
    await post({ tool_id: 'Tlsx', graph_inputs: { domains: ['alpha.test', 'beta.test', 'evil.test'] } })
    const sent = JSON.parse(h.orchestratorFetch.mock.calls[0][1].body)
    expect(sent.graph_inputs).toEqual({ domains: ['alpha.test', 'beta.test', 'evil.test'] })
    expect(sent.user_id).toBe('u1')
  })

  test('records the roots the orchestrator granted, not the request', async () => {
    const res = await post({ tool_id: 'Tlsx', graph_inputs: { domains: ['alpha.test', 'beta.test', 'evil.test'] } })
    expect(res.status).toBe(200)
    expect(h.recordScanStart).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'partial_recon', runId: 'r1', targets: ['alpha.test', 'beta.test'],
    }))
  })

  test('an orchestrator without roots in its answer records none', async () => {
    h.orchestratorFetch.mockResolvedValue({ ok: true, json: async () => ({ run_id: 'r2' }) })
    await post({ tool_id: 'Tlsx', graph_inputs: { domain: 'alpha.test' } })
    expect(h.recordScanStart.mock.calls[0][0].targets).toEqual([])
  })

  test('a refused start records nothing and passes the refusal on', async () => {
    h.orchestratorFetch.mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ detail: 'None of the requested domains is a target of this project.' }),
    })
    const res = await post({ tool_id: 'Tlsx', graph_inputs: { domains: ['evil.test'] } })
    expect(res.status).toBe(400)
    expect(h.recordScanStart).not.toHaveBeenCalled()
  })
})

describe('an old-model graph (§4.11.6)', () => {
  test('refuses the start with 409 and the message, before any container', async () => {
    h.findUnique.mockResolvedValue({
      id: 'p1', userId: 'u1', targetDomain: '', domainBatchMode: true,
      domainBatchHosts: ['www.acme.co.uk', '*.beta.test'],
    })
    h.legacy.mockResolvedValue(['co.uk'])
    const res = await post({ tool_id: 'Tlsx', graph_inputs: { domains: ['acme.co.uk'] } })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain("This project's graph was built before the current scope model; run a full recon first")
    expect(body.code).toBe('legacy_graph')
    expect(h.orchestratorFetch).not.toHaveBeenCalled()
    expect(h.recordScanStart).not.toHaveBeenCalled()
    // the scope it judged is the PSL-regrouped one
    expect(h.legacy.mock.calls[0][2].map((g: { scanRoot: string }) => g.scanRoot))
      .toEqual(['acme.co.uk', 'beta.test'])
  })

  test('a check Neo4j could not answer lets the start through to the container backstop', async () => {
    h.legacy.mockResolvedValue(null)
    const res = await post({ tool_id: 'Tlsx', graph_inputs: { domains: ['alpha.test'] } })
    expect(res.status).toBe(200)
  })
})
