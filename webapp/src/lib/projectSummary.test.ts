import { describe, test, expect } from 'vitest'
import { projectTargetLabel, summaryScopeGroups, toProjectSummary } from './projectSummary'

const READ = { id: 'p1', name: 'P', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }

describe('projectTargetLabel', () => {
  test('a batch names its scope groups, never its empty targetDomain', () => {
    expect(projectTargetLabel({
      targetDomain: '', domainBatchMode: true,
      domainBatchHosts: ['*.example.org', 'www.acme.co.uk', 'shop.acme.co.uk'],
    })).toBe('2 scope groups across 2 domains (1 enumerated)')
  })

  test('a batch row without its host list still says it is a batch', () => {
    expect(projectTargetLabel({ targetDomain: '', domainBatchMode: true })).toBe('Domain batch')
  })

  test('a single domain shows the target as typed; IP mode counts its targets', () => {
    expect(projectTargetLabel({ targetDomain: 'api.example.com', subdomainList: [] })).toBe('api.example.com')
    expect(projectTargetLabel({ ipMode: true, targetIps: ['192.0.2.1', '198.51.100.0/24'] })).toBe('2 IP targets')
  })
})

describe('toProjectSummary', () => {
  test('the batch roots come from the host list, not the stale legacy record', () => {
    const s = toProjectSummary({
      ...READ, targetDomain: '', domainBatchMode: true,
      domainBatchHosts: ['www.acme.co.uk', '*.example.com'],
      ...({ domainBatchGroups: [{ rootDomain: 'co.uk', prefixes: ['*'] }] } as object),
    })
    expect(s.scopeGroups?.map(g => [g.scanRoot, g.mode])).toEqual([['acme.co.uk', 'exact'], ['example.com', 'enumerate']])
    expect(s.targetLabel).toBe('2 scope groups across 2 domains (1 enumerated)')
  })

  test("the server's scopeGroups are used as they are", () => {
    const scopeGroups = [{
      scanRoot: 'example.com', orgDomain: 'example.com', mode: 'enumerate', includeRoot: false,
      exactHosts: [], entries: ['*.example.com'], notes: [],
    }]
    expect(summaryScopeGroups({ domainBatchMode: true, domainBatchHosts: ['www.other.test'], scopeGroups }))
      .toEqual(scopeGroups)
  })

  test('the engagement-limit columns and the phase map survive the copy', () => {
    const s = toProjectSummary({
      ...READ, targetDomain: 'example.com', subdomainList: [], roeGlobalMaxRps: 5,
      roeExcludedHosts: ['a.example.com'], roeTimeWindowEnabled: true,
      agentToolPhaseMap: '{"query_graph":["informational"]}', createdAt: new Date('2026-10-01T00:00:00Z'),
    })
    expect([s.roeGlobalMaxRps, s.roeExcludedHosts, s.roeTimeWindowEnabled]).toEqual([5, ['a.example.com'], true])
    expect(s.agentToolPhaseMap).toEqual({ query_graph: ['informational'] })
    expect(s.createdAt).toBe('2026-10-01T00:00:00.000Z')
    expect(s.scopeGroups?.map(g => g.scanRoot)).toEqual(['example.com'])
  })
})
