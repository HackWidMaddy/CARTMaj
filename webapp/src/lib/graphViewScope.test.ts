import { describe, expect, test } from 'vitest'
import { resolveScopeGroups } from '@/lib/scopeGroups'
import { domainNameLiterals, viewMayNeedUpdate } from './graphViewScope'

const single = (targetDomain: string) => resolveScopeGroups({ targetDomain, subdomainList: [] }).groups

describe('domainNameLiterals', () => {
  test('reads the literals a Domain is matched on', () => {
    expect(domainNameLiterals("MATCH (d:Domain {name:'API.nwlab.test'})-[:HAS_SUBDOMAIN]->(s) RETURN d, s"))
      .toEqual(['api.nwlab.test'])
    expect(domainNameLiterals('MATCH (x:Domain) WHERE x.name = "example.com" RETURN x')).toEqual(['example.com'])
    expect(domainNameLiterals("MATCH (x:Domain) WHERE x.name IN ['a.test', \"b.test\"] RETURN x"))
      .toEqual(['a.test', 'b.test'])
  })

  test('ignores names that are not a Domain', () => {
    expect(domainNameLiterals("MATCH (s:Subdomain {name: 'api.nwlab.test'}) RETURN s")).toEqual([])
    expect(domainNameLiterals("MATCH (d:Domain) WHERE d.registrar = 'R' RETURN d")).toEqual([])
  })
})

describe('viewMayNeedUpdate', () => {
  test('a view on the old scan-root Domain is flagged once the graph names the org', () => {
    const view = "MATCH (d:Domain {name:'api.nwlab.test'})-[:HAS_SUBDOMAIN]->(s) RETURN d, s"
    expect(viewMayNeedUpdate(view, single('api.nwlab.test'))).toBe(true)
  })

  test('a view on the org Domain, or naming no Domain, is not', () => {
    expect(viewMayNeedUpdate("MATCH (d:Domain {name:'nwlab.test'}) RETURN d", single('api.nwlab.test'))).toBe(false)
    expect(viewMayNeedUpdate('MATCH (d:Domain) RETURN d', single('api.nwlab.test'))).toBe(false)
  })

  test('no scope (IP mode) never flags', () => {
    expect(viewMayNeedUpdate("MATCH (d:Domain {name:'x.test'}) RETURN d", [])).toBe(false)
  })
})
