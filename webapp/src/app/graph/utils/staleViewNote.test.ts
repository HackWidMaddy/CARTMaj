import { describe, test, expect } from 'vitest'
import { resolveScopeGroups } from '@/lib/scopeGroups'
import { staleViewNote } from './staleViewNote'

const groups = resolveScopeGroups({ domainBatchMode: true, domainBatchHosts: ['*.api.example.com', 'www.other.test'] }).groups

describe('a saved view naming an old Domain is flagged (WEB-30)', () => {
  test('a deeper scan root is now a Subdomain of its org', () => {
    expect(staleViewNote("MATCH (d:Domain {name:'api.example.com'})-[:HAS_SUBDOMAIN]->(s) RETURN s", groups))
      .toBe('names api.example.com, which is no longer a graph Domain; it is now a Subdomain of example.com')
  })

  test('a name outside the scope says so', () => {
    expect(staleViewNote("MATCH (d:Domain) WHERE d.name = 'co.uk' RETURN d", groups))
      .toBe('names co.uk, which is no longer a graph Domain and is out of scope')
  })

  test('a view on a current Domain, or with no Domain literal, is not flagged', () => {
    expect(staleViewNote("MATCH (d:Domain {name:'example.com'}) RETURN d", groups)).toBeNull()
    expect(staleViewNote('MATCH (s:Subdomain) RETURN s', groups)).toBeNull()
  })
})
