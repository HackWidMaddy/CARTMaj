/**
 * The note a saved graph view gets when its Cypher names a Domain the graph no
 * longer has (WEB-30). Domain nodes carry the registrable domain since the org
 * model, so `Domain {name: 'api.example.com'}` matches nothing and the view
 * returns an empty answer that reads as a clean target. The query is never
 * rewritten; the person is told what the name is now.
 */
import { domainNameLiterals } from '@/lib/graphViewScope'
import { type ScopeGroup, expectedDomainNames } from '@/lib/scopeGroups'

export function staleViewNote(cypher: string | null | undefined, groups: readonly ScopeGroup[]): string | null {
  if (!cypher || groups.length === 0) return null
  const expected = new Set(expectedDomainNames(groups))
  const stale = domainNameLiterals(cypher).filter(name => !expected.has(name))
  if (stale.length === 0) return null
  return stale.map(name => {
    const org = groups.find(g => name === g.scanRoot || name.endsWith(`.${g.orgDomain}`))?.orgDomain
    return org
      ? `names ${name}, which is no longer a graph Domain; it is now a Subdomain of ${org}`
      : `names ${name}, which is no longer a graph Domain and is out of scope`
  }).join('; ')
}
