/**
 * Object-level ownership for version ids (Section 8.2, anti-IDOR).
 *
 * Every version route funnels through this, so it carries two properties worth
 * pinning: a version from another project is 404 (never 403, never the row), and
 * the check costs ONE query — it runs on every version request, and it must never
 * pull the snapshot payload (megabytes) just to answer "does this have bytes?".
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextResponse } from 'next/server'

const queryRaw = vi.hoisted(() => vi.fn())
const findUnique = vi.hoisted(() => vi.fn())
vi.mock('@/lib/prisma', () => ({
  default: { $queryRaw: queryRaw, scanVersion: { findUnique } },
}))

import { requireVersionInProject, resolveVersionSelector, isCurrentSelector } from './scanVersionAccess'

const row = (over: Record<string, unknown> = {}) => ({
  id: 'v1', project_id: 'p1', seq: 1, label: 'Scan 1', is_current: false,
  pinned: false, node_count: 10, link_count: 5, created_at: new Date(),
  snapshot_bytes: 4096, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  queryRaw.mockResolvedValue([row()])
})

describe('requireVersionInProject', () => {
  test('returns the version when it belongs to the project', async () => {
    const res = await requireVersionInProject('p1', 'v1')
    expect(res).not.toBeInstanceOf(NextResponse)
    expect(res).toMatchObject({ id: 'v1', projectId: 'p1', seq: 1, isCurrent: false, hasSnapshot: true })
  })

  test('costs exactly one query and never loads the snapshot payload', async () => {
    await requireVersionInProject('p1', 'v1')
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(findUnique).not.toHaveBeenCalled()
    // The query asks Postgres for the SIZE, not the bytes.
    const sql = String(queryRaw.mock.calls[0][0])
    expect(sql).toContain('octet_length(snapshot)')
    expect(sql).not.toMatch(/SELECT[^;]*\bsnapshot\b\s*(,|FROM)/i)
  })

  test('EXPLOIT: a version from another project is 404, not the row', async () => {
    queryRaw.mockResolvedValue([row({ project_id: 'someoneElsesProject' })])
    const res = await requireVersionInProject('p1', 'v1')
    expect(res).toBeInstanceOf(NextResponse)
    expect((res as NextResponse).status).toBe(404)
  })

  test('an unknown id is 404', async () => {
    queryRaw.mockResolvedValue([])
    expect(((await requireVersionInProject('p1', 'nope')) as NextResponse).status).toBe(404)
  })

  test.each([
    ['an empty id', ''],
    ['a non-string id', 123 as unknown as string],
    ['a null id', null as unknown as string],
  ])('%s is 404 without touching the database', async (_d, id) => {
    const res = await requireVersionInProject('p1', id)
    expect((res as NextResponse).status).toBe(404)
    expect(queryRaw).not.toHaveBeenCalled()
  })

  test('a version with zero-length bytes is not activatable', async () => {
    queryRaw.mockResolvedValue([row({ snapshot_bytes: 0 })])
    expect(await requireVersionInProject('p1', 'v1')).toMatchObject({ hasSnapshot: false })
    queryRaw.mockResolvedValue([row({ snapshot_bytes: null })])
    expect(await requireVersionInProject('p1', 'v1')).toMatchObject({ hasSnapshot: false })
  })

  test('the id is bound as a parameter, not interpolated (injection)', async () => {
    await requireVersionInProject('p1', "v1'; DROP TABLE scan_versions; --")
    // Prisma tagged templates pass the strings array + the values separately.
    const [strings, ...values] = queryRaw.mock.calls[0]
    expect(Array.isArray(strings)).toBe(true)
    expect(values).toContain("v1'; DROP TABLE scan_versions; --")
    expect(String(strings)).not.toContain('DROP TABLE')
  })
})

describe('resolveVersionSelector', () => {
  test.each([[null], ['current']])('%s resolves to the live graph', async selector => {
    const res = await resolveVersionSelector('p1', selector)
    expect(isCurrentSelector(res as never)).toBe(true)
    expect(queryRaw).not.toHaveBeenCalled()
  })

  test('an id resolves through the ownership check', async () => {
    const res = await resolveVersionSelector('p1', 'v1')
    expect(isCurrentSelector(res as never)).toBe(false)
    expect(res).toMatchObject({ id: 'v1' })
  })

  test("EXPLOIT: another project's id in a selector is 404", async () => {
    queryRaw.mockResolvedValue([row({ project_id: 'other' })])
    const res = await resolveVersionSelector('p1', 'vOther')
    expect(res).toBeInstanceOf(NextResponse)
  })
})
