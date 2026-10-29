/**
 * GET /api/internal/capture-config — the DB->proxy config endpoint (single source
 * of truth). Verifies: internal-key gating, DB->JSON mapping, the fail-safe
 * block-everything default when no row exists, and 503 (never a relaxed policy) on
 * a DB error.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockUserFindMany = vi.fn()
const mockSettingsFindFirst = vi.fn()
const mockIsInternal = vi.fn()

vi.mock('@/lib/prisma', () => ({
  default: {
    user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
    userSettings: { findFirst: (...a: unknown[]) => mockSettingsFindFirst(...a) },
  },
}))
vi.mock('@/lib/session', () => ({
  isInternalRequest: (...a: unknown[]) => mockIsInternal(...a),
}))

import { GET } from './route'

const EGRESS_FIELDS = [
  'captureEgressBlockEmptyHost', 'captureEgressBlockHardGuardrail', 'captureEgressFailClosed',
  'captureEgressBlockUnresolvable', 'captureEgressBlockPrivate', 'captureEgressBlockLoopback',
  'captureEgressBlockLinkLocal', 'captureEgressBlockCgnat', 'captureEgressBlockReserved',
  'captureEgressBlockMulticast', 'captureEgressBlockUnspecified',
]

// A fully-populated admin settings row with block_private OFF (the operator's choice).
const ROW = {
  ...Object.fromEntries(EGRESS_FIELDS.map((f) => [f, true])),
  captureEgressBlockPrivate: false,
  captureProxyStoreBodies: true,
  captureProxyStoreReqBodies: false,
  captureProxyStoreRespBodies: true,
  captureProxyMaxBodyKb: 128,
  captureProxyMaxStoreMb: 0,
  captureProxyBodyRules: { image: 'disk' },
  captureProxyEnabled: true,
}

const req = () => new NextRequest('http://webapp/api/internal/capture-config')

beforeEach(() => {
  mockUserFindMany.mockReset().mockResolvedValue([{ id: 'admin-1' }])
  mockSettingsFindFirst.mockReset().mockResolvedValue({ ...ROW })
  mockIsInternal.mockReset().mockReturnValue(true)
})

describe('GET /api/internal/capture-config', () => {
  test('rejects non-internal callers with 401 and never reads the DB', async () => {
    mockIsInternal.mockReturnValue(false)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(mockUserFindMany).not.toHaveBeenCalled()
    expect(mockSettingsFindFirst).not.toHaveBeenCalled()
  })

  test('maps the DB row to the proxy config shape (block_private honored)', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.source).toBe('db')
    expect(j.egress.block_private).toBe(false)
    // every other egress toggle stays true
    expect(j.egress.block_loopback).toBe(true)
    expect(j.egress.block_reserved).toBe(true)
    // body policy maps through
    expect(j.body.store_req_bodies).toBe(false)
    expect(j.body.max_body_kb).toBe(128)
    expect(j.body.max_store_mb).toBe(0)
    expect(j.body.body_rules).toEqual({ image: 'disk' })
    expect(j.enabled).toBe(true)
  })

  test('fail-safe: no settings row => block EVERYTHING (source=default-block)', async () => {
    mockUserFindMany.mockResolvedValue([])          // no admins
    mockSettingsFindFirst.mockResolvedValue(null)
    const res = await GET(req())
    const j = await res.json()
    expect(j.source).toBe('default-block')
    for (const k of Object.keys(j.egress)) expect(j.egress[k]).toBe(true)
    expect(j.enabled).toBe(true)  // default true so the enabled-gate isn't the blocker
  })

  test('null egress column falls back to block (never undefined/false)', async () => {
    mockSettingsFindFirst.mockResolvedValue({ ...ROW, captureEgressBlockLoopback: null })
    const j = await (await GET(req())).json()
    expect(j.egress.block_loopback).toBe(true)
  })

  test('DB error returns 503, never a relaxed policy', async () => {
    mockSettingsFindFirst.mockRejectedValue(new Error('db down'))
    const res = await GET(req())
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j.egress).toBeUndefined()
  })

  test('resolves the admin row (findFirst ordered by updatedAt desc)', async () => {
    // Multi-admin: the query must be scoped to admin ids and ordered so the most
    // recently updated admin row wins ("last admin save propagates globally").
    mockUserFindMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }])
    await GET(req())
    const arg = mockSettingsFindFirst.mock.calls[0][0]
    expect(arg.where.userId.in).toEqual(['a1', 'a2'])
    expect(arg.orderBy).toEqual({ updatedAt: 'desc' })
  })

  test('null / missing captureProxyBodyRules becomes {}', async () => {
    mockSettingsFindFirst.mockResolvedValue({ ...ROW, captureProxyBodyRules: null })
    const j = await (await GET(req())).json()
    expect(j.body.body_rules).toEqual({})
  })

  test('null body-storage numerics fall back to sane defaults', async () => {
    mockSettingsFindFirst.mockResolvedValue({
      ...ROW, captureProxyMaxBodyKb: null, captureProxyMaxStoreMb: null,
    })
    const j = await (await GET(req())).json()
    expect(j.body.max_body_kb).toBe(64)
    expect(j.body.max_store_mb).toBe(5)
  })
})
