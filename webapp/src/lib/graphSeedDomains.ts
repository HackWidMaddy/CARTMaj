/**
 * Make sure a project's Domain nodes exist in the graph: one per org (the
 * registrable domain of each scope group, `expectedDomainNames`), never one per
 * scan root, which would leave a stray Domain(api.example.com) beside the
 * Domain(example.com) recon writes.
 *
 * The partial-recon picker lists Domain nodes, so an org added to a project
 * after creation had no way to be scanned on its own until a full recon created
 * its node. Called by project create and save, and by update_project_scope.
 *
 * `Domain` is an entity node, so it MERGEs on the tenant triple: without
 * `user_id` and `project_id` in the key, two projects that share a root would
 * share one node. `ON CREATE SET` only, so a scan's own fields are never
 * overwritten by a seed.
 *
 * Best-effort by contract: it never throws. The caller's write has already
 * landed, and the next full recon creates the node anyway.
 */
import { getGraphSession } from '@/app/api/graph/neo4j'
import { type ScopeGroup, expectedDomainNames } from '@/lib/scopeGroups'

/** The Domain names to seed for these scope groups: their orgs, deduped. */
export function seedDomainNames(groups: readonly ScopeGroup[]): string[] {
  return expectedDomainNames(groups)
}

export async function seedProjectDomains(
  domains: string[],
  userId: string,
  projectId: string,
): Promise<boolean> {
  domains = [...new Set(domains.map(d => d.toLowerCase()))]
  if (domains.length === 0) return true
  try {
    const session = getGraphSession()
    try {
      for (const name of domains) {
        await session.run(
          `MERGE (d:Domain {name: $name, user_id: $userId, project_id: $projectId})
           ON CREATE SET d.source = 'project_creation', d.updated_at = datetime()`,
          { name, userId, projectId }
        )
      }
    } finally {
      await session.close()
    }
    return true
  } catch (e) {
    console.warn('Failed to ensure Domain nodes in Neo4j:', e)
    return false
  }
}
