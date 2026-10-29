/**
 * What the node drawer and the LLM node context say about scope (§4.11.7).
 *
 * The graph's Domain is the registrable domain (org); the scan roots under it
 * come from the project's current scope groups, never from the graph, which
 * still holds a removed root's data until the next full recon. A removed root
 * is one the Domain's `recon_coverage_roots` names but no current group does.
 */
import { type ScopeGroup, groupLabel } from '@/lib/scopeGroups'
import type { GraphNode } from '../types'

export interface DomainScopeRoots {
  /** Current groups whose org is this Domain, as one-line labels. */
  current: string[]
  /** Scan roots the graph still holds for this Domain that no group names now. */
  removed: string[]
}

function coverageRoots(node: GraphNode): string[] {
  const raw = node.properties?.recon_coverage_roots
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string').map(r => r.toLowerCase()) : []
}

/**
 * The scan roots under a Domain node. `groups` undefined means the project row
 * is not at hand (a saved version): the stored roots are listed as they are,
 * without a current/removed split.
 */
export function domainScopeRoots(node: GraphNode, groups: readonly ScopeGroup[] | undefined): DomainScopeRoots | null {
  if (node.type !== 'Domain' || node.properties?.ip_mode) return null
  const org = node.name.toLowerCase()
  const stored = coverageRoots(node)
  if (!groups) return stored.length ? { current: stored, removed: [] } : null
  const mine = groups.filter(g => g.orgDomain === org)
  const currentRoots = new Set(groups.map(g => g.scanRoot))
  const removed = stored.filter(r => !currentRoots.has(r))
  if (mine.length === 0 && removed.length === 0) return null
  return { current: mine.map(groupLabel), removed }
}

/**
 * The badge of a Subdomain that is a scan root: its mode and Root, or "former
 * scan root (removed)" when no current group names it. Null for any other node.
 */
export function scanRootBadge(node: GraphNode, groups: readonly ScopeGroup[] | undefined): string | null {
  if (node.type !== 'Subdomain' || node.properties?.is_scan_root !== true) return null
  if (!groups) return 'Scan root'
  const g = groups.find(x => x.scanRoot === node.name.toLowerCase())
  if (!g) return 'former scan root (removed)'
  return g.mode === 'enumerate'
    ? `Scan root (enumerate${g.includeRoot ? ', +root' : ''})`
    : 'Scan root (listed hosts)'
}
