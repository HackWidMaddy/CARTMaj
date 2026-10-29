/**
 * Does a saved graph view name a Domain the graph no longer has (WEB-30)?
 *
 * Domain nodes are named after the org (the registrable domain) since the
 * graph's org model. A view written before, `MATCH (d:Domain {name:
 * 'api.example.com'})`, now matches nothing and returns an empty answer that
 * looks like a clean target. This reads the Domain name literals out of the
 * view's Cypher (`:Domain {name: '…'}`, `<var>.name = '…'` and
 * `<var>.name IN ['…']` on a Domain variable) and reports whether any is not a
 * name the current scope gives a Domain node. It is a hint for a person, so it
 * stays a boolean: the literal and the query are never handed to an MCP caller.
 */
import { type ScopeGroup, expectedDomainNames } from '@/lib/scopeGroups'

const STRING = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`

function literals(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(new RegExp(STRING, 'g'))) out.push((m[1] ?? m[2] ?? '').toLowerCase())
  return out
}

/** The Domain name literals a Cypher query matches on, lower-cased. */
export function domainNameLiterals(cypher: string): string[] {
  const names: string[] = []
  // :Domain {…name: '…'…}
  for (const m of cypher.matchAll(/:Domain\s*\{([^}]*)\}/gi)) {
    for (const p of m[1].matchAll(new RegExp(String.raw`\bname\s*:\s*${STRING}`, 'gi'))) {
      names.push((p[1] ?? p[2] ?? '').toLowerCase())
    }
  }
  // <var>.name = '…' / <var>.name IN [ … ] for every variable bound to :Domain
  const vars = new Set([...cypher.matchAll(/\(\s*([A-Za-z_]\w*)\s*:\s*Domain\b/gi)].map(m => m[1]))
  for (const v of vars) {
    for (const m of cypher.matchAll(new RegExp(String.raw`\b${v}\.name\s*=\s*${STRING}`, 'g'))) {
      names.push((m[1] ?? m[2] ?? '').toLowerCase())
    }
    for (const m of cypher.matchAll(new RegExp(String.raw`\b${v}\.name\s+IN\s*\[([^\]]*)\]`, 'gi'))) {
      names.push(...literals(m[1]))
    }
  }
  return [...new Set(names.filter(Boolean))]
}

/** True when the view names a Domain the current scope gives no Domain node. */
export function viewMayNeedUpdate(cypher: string | null | undefined, groups: readonly ScopeGroup[]): boolean {
  if (!cypher || groups.length === 0) return false
  const expected = new Set(expectedDomainNames(groups))
  return domainNameLiterals(cypher).some(name => !expected.has(name))
}
