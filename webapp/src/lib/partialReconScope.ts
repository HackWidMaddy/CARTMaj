/**
 * Partial recon: which scan roots a partial run is offered.
 *
 * The roots are the project's scope-group scan roots (resolveScopeGroups). The
 * orchestrator is the authority on scope: partial_project_roots() in
 * recon_orchestrator/batch_scope.py re-derives the roots from the project row
 * and refuses anything else. This is a mirror of it, used only to decide what
 * the modal shows and sends.
 */
import { GRAPH_DOMAIN_IS_ORG, type ScopeGroup, admitsHost, resolveScopeGroups } from '@/lib/scopeGroups'

const ROOT_CHARSET = /^[a-z0-9.-]+$/

export type PartialScopeMode = 'ip' | 'batch' | 'single'

export interface ProjectTargetFields {
  ipMode?: boolean | null
  targetDomain?: string | null
  subdomainList?: readonly string[] | null
  domainBatchMode?: boolean | null
  domainBatchHosts?: readonly string[] | null
  /** The legacy stored record: read only when the caller did not select the
   *  host list, so a reader not yet migrated keeps working. */
  domainBatchGroups?: unknown
}

export interface ProjectRoots {
  mode: PartialScopeMode
  /** Every scan root the project scans, in project order. */
  roots: string[]
  /** The scan roots whose group ENUMERATES, in any mode. An EXACT group, single
   *  domain included, never runs subdomain discovery. */
  wildcardRoots: string[]
  /** The scope groups, when derivable from the stored target fields; empty in
   *  IP mode and on the legacy fallback. */
  groups: ScopeGroup[]
}

/** The name recon/main.py mints for IP mode's synthetic Domain node. */
export function ipModeRoot(projectId: string): string {
  return `ip-targets.${projectId}`
}

function usableRoot(root: string): boolean {
  // Checked lowercased but kept as stored: a single-domain target is saved
  // trimmed, not lowercased, and its Domain node carries exactly that name.
  const low = root.trim().toLowerCase()
  return low.length > 0 && ROOT_CHARSET.test(low) && !low.includes('..')
}

export function resolveProjectRoots(project: ProjectTargetFields, projectId: string): ProjectRoots {
  if (project.ipMode) {
    const root = ipModeRoot(projectId)
    return { mode: 'ip', roots: usableRoot(root) ? [root] : [], wildcardRoots: [], groups: [] }
  }
  const derivable = project.domainBatchMode ? project.domainBatchHosts != null : project.subdomainList != null
  if (derivable) {
    const { groups } = resolveScopeGroups(project)
    const enumerating = groups.filter(g => g.mode === 'enumerate').map(g => g.scanRoot)
    if (project.domainBatchMode) {
      const roots = groups.map(g => g.scanRoot).filter(usableRoot)
      return { mode: 'batch', roots, wildcardRoots: enumerating, groups }
    }
    // The stored spelling, as the orchestrator returns it: a legacy single-domain
    // Domain node carries the target exactly as it was typed.
    const target = String(project.targetDomain ?? '').trim()
    const roots = usableRoot(target) && groups.length ? [target] : []
    return { mode: 'single', roots, wildcardRoots: roots.length ? enumerating : [], groups }
  }
  if (project.domainBatchMode) {
    const roots: string[] = []
    const wildcardRoots: string[] = []
    const groups = Array.isArray(project.domainBatchGroups) ? project.domainBatchGroups : []
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const { rootDomain, prefixes } = group as { rootDomain?: unknown; prefixes?: unknown }
      const root = String(rootDomain ?? '').trim().toLowerCase()
      if (!usableRoot(root)) continue
      if (!roots.includes(root)) roots.push(root)
      if (Array.isArray(prefixes) && prefixes.includes('*') && !wildcardRoots.includes(root)) {
        wildcardRoots.push(root)
      }
    }
    return { mode: 'batch', roots, wildcardRoots, groups: [] }
  }
  const target = String(project.targetDomain ?? '').trim()
  return { mode: 'single', roots: usableRoot(target) ? [target] : [], wildcardRoots: [], groups: [] }
}

export interface GraphDomainRow {
  name: string
  /** The Domain has at least one Subdomain or resolves to an IP. */
  hasData: boolean
}

export interface PartialScopeFields {
  domain: string | null
  domains: string[]
  stale_domains: string[]
  empty_domains: string[]
}

const byName = (a: string, b: string) => a.localeCompare(b)

/** The Domain node a scan root's hosts hang off: its org, once the graph
 *  names Domains after the org; the root itself in IP mode or without groups. */
export function graphDomainOf(scope: ProjectRoots, root: string): string {
  const low = root.toLowerCase()
  if (!GRAPH_DOMAIN_IS_ORG) return low
  const group = scope.groups.find(g => g.scanRoot.toLowerCase() === low)
  return (group?.orgDomain ?? low).toLowerCase()
}

/**
 * The scope part of a graph-inputs response.
 *
 * `graph` is the project's Domain nodes, or null when Neo4j could not be read;
 * the roots are then offered as they are, and the orchestrator still decides.
 * A tool not yet able to cover several roots is offered only the first.
 * Domain nodes are orgs: a scan root is "in the graph" when its org Domain is,
 * and a Domain no current scan root hangs off is stale.
 */
export function partialScopeFields(
  scope: ProjectRoots,
  graph: GraphDomainRow[] | null,
): PartialScopeFields {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const inGraph = (root: string) => (graph ?? []).some(row => same(row.name, graphDomainOf(scope, root)))

  let current = [...scope.roots]
  // IP mode's root exists only once a full recon has minted it. A domain root
  // is offered even without its node: partial discovery creates it.
  if (scope.mode === 'ip' && graph) current = current.filter(inGraph)
  current.sort(byName)

  const domains = current
  const graphNames = new Set(scope.roots.map(root => graphDomainOf(scope, root)))
  const stale = (graph ?? [])
    .map(row => row.name)
    .filter(name => !graphNames.has(name.toLowerCase()))
    .sort(byName)
  const withData = new Set((graph ?? []).filter(row => row.hasData).map(row => row.name.toLowerCase()))
  const empty = graph ? domains.filter(root => !withData.has(graphDomainOf(scope, root))) : []

  return { domain: domains[0] ?? null, domains, stale_domains: stale, empty_domains: empty }
}

/** The roots a SubdomainDiscovery run may enumerate: only an ENUMERATE group,
 *  in a batch or a single domain (group_discovery_enabled in recon). The
 *  legacy fallback of a single domain cannot tell, and offers its target. */
export function discoveryDomains(scope: ProjectRoots, domains: string[]): string[] {
  if (scope.mode === 'ip' || (scope.mode === 'single' && scope.groups.length === 0)) return [...domains]
  const enumerating = new Set(scope.wildcardRoots.map(r => r.toLowerCase()))
  return domains.filter(root => enumerating.has(root.toLowerCase()))
}

/**
 * Whether a host the operator types may be scanned by a partial run (§4.6): a
 * strict subdomain of an ENUMERATE scan root, a listed host of an EXACT group,
 * or a scan root itself only when Root is on. Without scope groups (IP mode,
 * the legacy fallback) it is the plain under-a-root test.
 */
export function admitsPartialHost(scope: ProjectRoots, host: string): boolean {
  const h = host.trim().toLowerCase()
  if (scope.groups.length === 0) return underAnyRoot(h, scope.roots)
  return admitsHost(scope.groups, h)
}

/** True when `host` is one of the roots or sits under one (label boundary). */
export function underAnyRoot(host: string, roots: readonly string[]): boolean {
  const h = host.toLowerCase()
  return roots.some(r => {
    const root = r.toLowerCase()
    return h === root || h.endsWith('.' + root)
  })
}

/**
 * The parameters of the graph's positive scope test for a partial run over
 * `selected` scan roots (§4.6 partial-recon graph targets): a host is in scope
 * when its LONGEST scan root is one of them and that group admits it, i.e. an
 * EXACT group's listed host, a scan root with Root on, or a strict subdomain of
 * an ENUMERATE root. Lower-cased; the Cypher form is `graphHostInScopeCypher`.
 */
export interface GraphScopeParams {
  /** Listed hosts of the selected groups (EXACT hosts, roots with Root on). */
  listed: string[]
  /** Selected ENUMERATE scan roots. */
  enumRoots: string[]
  /** Every current scan root: a longer one claims its hosts from a shorter one. */
  allRoots: string[]
}

function longestRoot(host: string, roots: readonly string[]): string | undefined {
  return roots.filter(r => host === r || host.endsWith(`.${r}`)).sort((a, b) => b.length - a.length)[0]
}

export function graphScopeParams(scope: ProjectRoots, selected: readonly string[]): GraphScopeParams {
  const wanted = new Set(selected.map(r => r.toLowerCase()))
  const allRoots = [...new Set(scope.groups.map(g => g.scanRoot.toLowerCase()))]
  const listed: string[] = []
  const enumRoots: string[] = []
  for (const g of scope.groups) {
    const root = g.scanRoot.toLowerCase()
    if (!wanted.has(root)) continue
    if (g.mode === 'enumerate') enumRoots.push(root)
    for (const h of [...g.exactHosts, ...(g.includeRoot ? [g.scanRoot] : [])]) {
      const host = h.toLowerCase()
      if (longestRoot(host, allRoots) === root && !listed.includes(host)) listed.push(host)
    }
  }
  return { listed, enumRoots, allRoots }
}

/** `graphScopeParams`' test in TypeScript, the predicate the Cypher runs. */
export function graphHostInScope(params: GraphScopeParams, host: string): boolean {
  const h = host.toLowerCase()
  if (params.listed.includes(h)) return true
  return params.enumRoots.some(r => h.endsWith(`.${r}`)
    && !params.allRoots.some(x => x.length > r.length && (h === x || h.endsWith(`.${x}`))))
}

/** The same test on a lower-cased Cypher host expression, over $listed,
 *  $enumRoots and $allRoots. */
export function graphHostInScopeCypher(host: string): string {
  return `(${host} IN $listed OR ANY(r IN $enumRoots WHERE ${host} ENDS WITH '.' + r
    AND NOT ANY(x IN $allRoots WHERE size(x) > size(r) AND (${host} = x OR ${host} ENDS WITH '.' + x))))`
}
