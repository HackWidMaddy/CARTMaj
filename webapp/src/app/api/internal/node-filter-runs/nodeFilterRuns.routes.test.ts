/**
 * The agent's side of an apply run: read the run, heartbeat it, finish it.
 *
 * Master key only. The scanner key is refused: scan containers hold it, and a
 * run's rules and exemptions, and the power to end a run, are not theirs.
 * Uses the real key check (lib/session) with stubbed keys.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  runFindUnique: vi.fn(),
  runUpdate: vi.fn(),
  runUpdateMany: vi.fn(),
  exemptionFindMany: vi.fn(),
  activating: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    nodeFilterRun: {
      findUnique: (...a: unknown[]) => h.runFindUnique(...a),
      update: (...a: unknown[]) => h.runUpdate(...a),
      updateMany: (...a: unknown[]) => h.runUpdateMany(...a),
    },
    nodeFilterExemption: { findMany: (...a: unknown[]) => h.exemptionFindMany(...a) },
  },
}))
vi.mock('@/lib/activationLock', () => ({ isActivationInProgress: (...a: unknown[]) => h.activating(...a) }))
vi.mock('@/lib/audit', () => ({ writeAudit: (e: unknown) => h.audit(e) }))

import { getCached, setCached } from '@/app/api/graph/cache'
import { GET } from './[runId]/route'
import { POST as heartbeat } from './[runId]/heartbeat/route'
import { POST as finish } from './[runId]/finish/route'

const params = { params: Promise.resolve({ runId: 'run1' }) }
const RULES = { version: 1, kinds: {} }

function req(key: string | null, body?: unknown) {
  return new NextRequest('http://x/api/internal/node-filter-runs/run1', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(key ? { 'x-internal-key': key } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('INTERNAL_API_KEY', 'master-key-0123456789')
  vi.stubEnv('SCANNER_API_KEY', 'scanner-key-0123456789')
  h.runFindUnique.mockResolvedValue({
    id: 'run1', projectId: 'p1', status: 'running', mode: 'denylist', rules: RULES, revision: 4,
    target: 'current', actorUserId: 'owner', realActorUserId: 'admin', project: { userId: 'owner' },
  })
  h.exemptionFindMany.mockResolvedValue([{ label: 'Vulnerability', nodeKey: 'v1' }])
  h.activating.mockResolvedValue(false)
  h.runUpdate.mockResolvedValue({})
  h.runUpdateMany.mockResolvedValue({ count: 1 })
})

const MASTER = 'master-key-0123456789'
const SCANNER = 'scanner-key-0123456789'

describe('only the master key', () => {
  test.each([
    ['GET', () => GET(req(SCANNER), params)],
    ['heartbeat', () => heartbeat(req(SCANNER, {}), params)],
    ['finish', () => finish(req(SCANNER, { status: 'completed' }), params)],
    ['GET, no key', () => GET(req(null), params)],
  ] as const)('%s with the scanner key or none is a 404', async (_name, call) => {
    expect((await call()).status).toBe(404)
    expect(h.runUpdate).not.toHaveBeenCalled()
    expect(h.runUpdateMany).not.toHaveBeenCalled()
  })
})

describe('GET the run', () => {
  test('returns the snapshot, the tenant, and the exemptions as they are NOW', async () => {
    const body = await (await GET(req(MASTER), params)).json()
    expect(body).toEqual({
      id: 'run1', projectId: 'p1', userId: 'owner', status: 'running', mode: 'denylist',
      rules: RULES, revision: 4, target: 'current', exemptions: [['Vulnerability', 'v1']],
    })
  })

  test('an unknown run is a 404', async () => {
    h.runFindUnique.mockResolvedValue(null)
    expect((await GET(req(MASTER), params)).status).toBe(404)
  })
})

describe('heartbeat', () => {
  test('records the time and the progress', async () => {
    const res = await heartbeat(req(MASTER, { progress: { scanned: 3200 } }), params)
    expect(await res.json()).toEqual({ status: 'running', abort: false })
    const data = h.runUpdate.mock.calls[0][0].data
    expect(data.heartbeatAt).toBeInstanceOf(Date)
    expect(data.stats).toEqual({ progress: { scanned: 3200 } })
  })

  test('tells a run that was stopped or swept to stop', async () => {
    h.runFindUnique.mockResolvedValue({ id: 'run1', projectId: 'p1', status: 'failed' })
    expect(await (await heartbeat(req(MASTER, {}), params)).json()).toMatchObject({ abort: true })
    expect(h.runUpdate).not.toHaveBeenCalled()
  })

  test('tells it to stop when a version activation started', async () => {
    h.activating.mockResolvedValue(true)
    const body = await (await heartbeat(req(MASTER, {}), params)).json()
    expect(body).toMatchObject({ abort: true, reason: 'a version activation started' })
  })

  test('a deleted project is a stop too', async () => {
    h.runFindUnique.mockResolvedValue(null)
    const res = await heartbeat(req(MASTER, {}), params)
    expect(res.status).toBe(404)
    expect((await res.json()).abort).toBe(true)
  })
})

describe('the agent\'s own bodies (contracts/run_callbacks.json)', () => {
  // agentic/tests/test_node_filter_runs.py pins these as what the agent sends.
  // Replaying them here is what proves the two sides still agree.
  const contract = JSON.parse(readFileSync(
    join(__dirname, '../../../../lib/nodeFilters/contracts/run_callbacks.json'), 'utf8'))

  test('its heartbeat records the progress and its finish records the verdict and the counts', async () => {
    const beat = await (await heartbeat(req(MASTER, contract.heartbeat), params)).json()
    expect(beat).toEqual({ status: 'running', abort: false })
    expect(h.runUpdate.mock.calls[0][0].data.stats).toEqual({ progress: contract.heartbeat.progress })

    const done = await (await finish(req(MASTER, contract.finish), params)).json()
    expect(done).toEqual({ ok: true, status: contract.finish.status })
    expect(h.runUpdateMany.mock.calls[0][0].data).toMatchObject({
      status: contract.finish.status, error: contract.finish.error, stats: contract.finish.stats,
    })
    expect(h.audit.mock.calls[0][0].after.totals).toEqual(contract.finish.stats.totals)
  })
})

describe('finish', () => {
  test('is conditional on the run still running, and audited with the real actor', async () => {
    const stats = { totals: { muted: 12 } }
    const res = await finish(req(MASTER, { status: 'completed', stats }), params)
    expect(await res.json()).toEqual({ ok: true, status: 'completed' })
    expect(h.runUpdateMany.mock.calls[0][0].where).toEqual({ id: 'run1', status: 'running' })
    expect(h.runUpdateMany.mock.calls[0][0].data).toMatchObject({ status: 'completed', stats })
    expect(h.audit.mock.calls[0][0]).toMatchObject({
      actorId: 'admin', action: 'node_filters.apply_finished', targetId: 'p1',
      after: { status: 'completed', totals: { muted: 12 }, effectiveUser: 'owner' },
    })
  })

  test('a run already swept keeps its verdict', async () => {
    h.runUpdateMany.mockResolvedValue({ count: 0 })
    expect((await (await finish(req(MASTER, { status: 'completed' }), params)).json()).ok).toBe(false)
  })

  test('finish_audits_unrecorded_verdict: a finish that changed nothing is audited as not recorded', async () => {
    // The run was swept to failed (agent_lost) before the agent reported. The
    // audit row used to say "completed" while the run row says failed.
    h.runUpdateMany.mockResolvedValue({ count: 0 })
    await finish(req(MASTER, { status: 'completed', stats: { totals: { muted: 3 } } }), params)
    expect(h.audit.mock.calls[0][0].after).toMatchObject({ status: 'completed', recorded: false })
  })

  test('graph_cache_after_apply: a finished apply drops the project\'s cached graph', async () => {
    // The Graph Map is served from a 10 s cache; without this the page refetched
    // after an apply and kept showing the findings the apply had just muted.
    setCached('p1', { nodes: [{ id: 'n1' }], links: [] })
    await finish(req(MASTER, { status: 'completed', stats: { totals: { muted: 1 } } }), params)
    expect(getCached('p1')).toBeNull()
  })

  test('an unknown status is recorded as failed', async () => {
    await finish(req(MASTER, { status: 'great' }), params)
    expect(h.runUpdateMany.mock.calls[0][0].data.status).toBe('failed')
  })
})
