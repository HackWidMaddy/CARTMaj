/**
 * Old-model detection (§4.11.6, D-18): a Domain node that still holds data
 * under a name the current scope model would not give it.
 *
 * Release B regroups batch hosts by the Public Suffix List, so a batch that
 * scanned `www.acme.co.uk` before it holds `Domain(co.uk)` while its scope now
 * expects `Domain(acme.co.uk)`. A partial recon, GVM or AI-attack run on that
 * graph attaches to the wrong node or finds nothing, so every writer that
 * attaches to Domain nodes refuses until a full recon rebuilds the graph.
 *
 * The recon container runs the same query as a backstop (graph_db
 * `legacy_domain_nodes`), failing closed; here the check is best-effort, so a
 * Neo4j outage does not block a start the container will judge anyway.
 */
import { getGraphSession } from '@/app/api/graph/neo4j'
import { type ScopeGroup, expectedDomainNames } from '@/lib/scopeGroups'

export const LEGACY_GRAPH_MESSAGE =
  "This project's graph was built before the current scope model; run a full recon first"

/** Case-insensitive: a legacy single-domain target kept its typed case. A
 *  Domain unrelated to the scope is a removed root, not an old-model one. */
export const LEGACY_DOMAINS_QUERY = `MATCH (d:Domain {user_id: $uid, project_id: $pid})
WITH d, toLower(d.name) AS n
WHERE NOT n IN $expected AND coalesce(d.ip_mode, false) = false
  AND ANY(r IN $related WHERE n = r OR n ENDS WITH '.' + r OR r ENDS WITH '.' + n)
  AND (EXISTS { (d)-[:HAS_SUBDOMAIN]->() } OR d.recon_coverage_at IS NOT NULL)
RETURN collect(d.name) AS legacy`

export function legacyGraphParams(groups: readonly ScopeGroup[]): { expected: string[]; related: string[] } {
  const related: string[] = []
  for (const g of groups) {
    for (const name of [g.orgDomain, g.scanRoot]) {
      const low = name.toLowerCase()
      if (!related.includes(low)) related.push(low)
    }
  }
  return { expected: expectedDomainNames(groups), related }
}

/** One Domain node as the query sees it. */
export interface DomainRow {
  name: string
  ipMode?: boolean
  /** Has a HAS_SUBDOMAIN edge or a recon coverage stamp. */
  hasData: boolean
}

/** The query's predicate in TypeScript, for the shared test vectors. */
export function legacyDomainNames(rows: readonly DomainRow[], groups: readonly ScopeGroup[]): string[] {
  const { expected, related } = legacyGraphParams(groups)
  return legacyDomainNamesFor(rows, expected, related)
}

/** The predicate on the query's own parameters (lower-cased names). */
export function legacyDomainNamesFor(
  rows: readonly DomainRow[], expected: readonly string[], related: readonly string[],
): string[] {
  return rows.filter(d => {
    const n = d.name.toLowerCase()
    return !expected.includes(n) && !d.ipMode && d.hasData
      && related.some(r => n === r || n.endsWith(`.${r}`) || r.endsWith(`.${n}`))
  }).map(d => d.name)
}

interface QueryRunner {
  run(query: string, params: Record<string, unknown>): Promise<{ records: { get(key: string): unknown }[] }>
}

export async function findLegacyDomains(
  runner: QueryRunner, userId: string, projectId: string, groups: readonly ScopeGroup[],
): Promise<string[]> {
  if (groups.length === 0) return []
  const result = await runner.run(LEGACY_DOMAINS_QUERY, { uid: userId, pid: projectId, ...legacyGraphParams(groups) })
  const legacy = result.records[0]?.get('legacy')
  return Array.isArray(legacy) ? legacy.filter((n): n is string => typeof n === 'string') : []
}

/** The old-model Domain names of a project, or null when Neo4j could not be
 *  asked (the caller proceeds; the container backstop fails closed). */
export async function legacyGraphDomains(
  userId: string, projectId: string, groups: readonly ScopeGroup[],
): Promise<string[] | null> {
  if (groups.length === 0) return []
  try {
    const session = getGraphSession()
    try {
      return await findLegacyDomains(session, userId, projectId, groups)
    } finally {
      await session.close()
    }
  } catch (e) {
    console.warn('Old-model graph check failed; letting the start through:', e)
    return null
  }
}

/** The 409 body for a refused start, naming the old Domain nodes. */
export function legacyGraphRefusal(legacy: readonly string[]): { error: string; code: 'legacy_graph'; legacyGraph: string[] } {
  const shown = legacy.slice(0, 5).join(', ') + (legacy.length > 5 ? ` (+${legacy.length - 5} more)` : '')
  return { error: `${LEGACY_GRAPH_MESSAGE} (old domain nodes: ${shown}).`, code: 'legacy_graph', legacyGraph: [...legacy] }
}
