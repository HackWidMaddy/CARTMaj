/**
 * GET /api/projects: a list row carries the scope fields, so a card and the
 * selector name a batch by its scope groups (its targetDomain is empty).
 *
 * @vitest-environment node
 */
import { describe, test, expect, vi } from 'vitest'

const findMany = vi.fn()

vi.mock('@/lib/prisma', () => ({ default: { project: { findMany: (...a: unknown[]) => findMany(...a) } } }))
vi.mock('@/app/api/graph/neo4j', () => ({ getGraphSession: () => ({ run: vi.fn(), close: vi.fn() }) }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: vi.fn().mockResolvedValue({ userId: 'user-1' }),
  ownerScope: (eff: { userId: string }) => ({ userId: eff.userId }),
}))

import { GET } from './route'
import { projectTargetLabel } from '@/lib/projectSummary'

describe('GET /api/projects', () => {
  test('selects the scope fields the target label is derived from', async () => {
    const row = {
      id: 'p1', userId: 'user-1', name: 'Batch', description: null, targetDomain: '',
      subdomainList: [], ipMode: false, targetIps: [], domainBatchMode: true,
      domainBatchHosts: ['www.acme.co.uk', '*.example.com'],
    }
    findMany.mockResolvedValue([row])
    const body = await (await GET()).json()
    const select = findMany.mock.calls[0][0].select
    for (const key of ['targetDomain', 'subdomainList', 'ipMode', 'targetIps', 'domainBatchMode', 'domainBatchHosts']) {
      expect(select[key]).toBe(true)
    }
    expect(select.domainBatchGroups).toBeUndefined()
    expect(projectTargetLabel(body[0])).toBe('2 scope groups across 2 domains (1 enumerated)')
  })
})
