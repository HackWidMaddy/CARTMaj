/**
 * A project's scope as scope groups, derived on every read and never stored.
 *
 * The one source of truth is the stored target fields: domainBatchHosts for a
 * Domain batch, targetDomain + subdomainList for a single domain (a batch with
 * one group). The stored domainBatchGroups is a legacy record for not-yet-
 * migrated readers and is never read here. GET /api/projects/[id] returns the
 * result as `scopeGroups`, so every service reads one derivation.
 */
import {
  type InvalidEntry, type ScopeGroup, describeInvalid, groupHostsByScanRoot, isAtOrUnder, normalizeHost,
  splitWildcard,
} from '@/lib/domainBatch'
import { icannRegistrable, isIpLiteral, orgDomain } from '@/lib/publicSuffix'

export type { ScopeGroup } from '@/lib/domainBatch'

/**
 * Which name the graph's Domain node carries: the org (registrable domain).
 * A deeper scan root is a Subdomain of it (`is_scan_root`) when it is a target.
 */
export const GRAPH_DOMAIN_IS_ORG = true

/** The scope fields of a project row or a create/update body. */
export interface ScopeFields {
  ipMode?: boolean | null
  domainBatchMode?: boolean | null
  domainBatchHosts?: readonly string[] | null
  targetDomain?: string | null
  subdomainList?: readonly string[] | null
}

export interface ResolvedScope {
  groups: ScopeGroup[]
  invalid: InvalidEntry[]
}

/** A single-domain project as one group (§4.4). The target may be at any depth,
 *  never a public suffix or an IP; prefixes may have several labels. */
function singleDomainScope(targetDomain: string, subdomainList: readonly string[]): ResolvedScope {
  const typed = String(targetDomain ?? '').trim()
  if (!typed) return { groups: [], invalid: [] }
  const target = splitWildcard(normalizeHost(typed)).rest
  if (isIpLiteral(target)) return { groups: [], invalid: [{ entry: typed, reason: 'ip_literal' }] }
  const org = orgDomain(target)
  if (!org) return { groups: [], invalid: [{ entry: typed, reason: 'public_suffix' }] }

  const invalid: InvalidEntry[] = []
  const prefixes: string[] = []
  let includeRoot = false
  for (const raw of subdomainList ?? []) {
    const p = String(raw ?? '').trim().toLowerCase()
    if (!p) continue
    if (p === '.') { includeRoot = true; continue }
    const clean = p.replace(/\.+$/, '')
    const host = `${clean}.${target}`
    const bad = !clean || clean.includes('*') || clean.split('.').some(l => !l)
      || clean === target || clean.endsWith(`.${target}`)
      || !/^[a-z0-9.-]+$/.test(clean) || clean.split('.').some(l => l.length > 63 || l.startsWith('-') || l.endsWith('-'))
      || host.length > 253
    if (bad) { invalid.push({ entry: String(raw), reason: 'invalid_prefix' }); continue }
    if (!prefixes.includes(clean)) prefixes.push(clean)
  }

  const exactHosts = prefixes.map(p => `${p}.${target}`)
  return {
    groups: [{
      scanRoot: target, orgDomain: org,
      mode: exactHosts.length > 0 ? 'exact' : 'enumerate',
      includeRoot, exactHosts,
      entries: [
        ...(exactHosts.length > 0 ? [] : [`*.${target}`]),
        ...(includeRoot ? [target] : []),
        ...exactHosts,
      ],
      notes: [],
    }],
    invalid,
  }
}

/** The project's scope groups and the entries the current rules refuse. */
export function resolveScopeGroups(project: ScopeFields): ResolvedScope {
  if (project.ipMode) return { groups: [], invalid: [] }
  if (project.domainBatchMode) {
    const { groups, invalid } = groupHostsByScanRoot(project.domainBatchHosts ?? [])
    return { groups, invalid }
  }
  return singleDomainScope(project.targetDomain ?? '', project.subdomainList ?? [])
}

function dedupe(names: Iterable<string>): string[] {
  const out: string[] = []
  for (const n of names) if (n && !out.includes(n)) out.push(n)
  return out
}

/**
 * Every name the hard guardrail checks (§4.7): each entry (wildcard marker
 * stripped, collapsed ones included), each exact host, each scan root and each
 * org. Entries first, so a refusal names the line the operator typed.
 */
export function guardrailNames(groups: readonly ScopeGroup[]): string[] {
  return dedupe([
    ...groups.flatMap(g => g.entries.map(e => splitWildcard(e).rest)),
    ...groups.flatMap(g => g.exactHosts),
    ...groups.map(g => g.scanRoot),
    ...groups.map(g => g.orgDomain),
  ])
}

/** The hard-guardrail names of a project row or body, whatever its mode. An
 *  entry the rules refuse is named too: refused for a reason does not mean
 *  it may skip the one check that cannot be switched off. */
export function scopeGuardrailNames(scope: ScopeFields): string[] {
  if (scope.ipMode) return []
  if (!scope.domainBatchMode) {
    // From the fields, not the groups: a target refused as a public suffix
    // (org.jm) still names its prefix hosts (isa.org.jm).
    const target = splitWildcard(normalizeHost(scope.targetDomain ?? '')).rest
    if (!target) return []
    return dedupe([target, ...(scope.subdomainList ?? []).map(raw => {
      const prefix = String(raw ?? '').trim().toLowerCase().replace(/\.+$/, '')
      return prefix && !prefix.includes('*') ? `${prefix}.${target}` : ''
    })])
  }
  const { groups, invalid } = resolveScopeGroups(scope)
  return dedupe([
    ...guardrailNames(groups),
    ...invalid.map(i => splitWildcard(normalizeHost(i.entry)).rest),
  ])
}

/**
 * The names the soft (LLM) guardrail judges: orgs and scan roots, plus the ICANN
 * registrable domain of a private-section org (`alice.github.io` -> also
 * `github.io`), so the model sees the platform owner. The agent has no PSL.
 */
export function softGuardrailNames(groups: readonly ScopeGroup[]): string[] {
  const names: string[] = []
  for (const g of groups) {
    names.push(g.orgDomain, g.scanRoot)
    const icann = icannRegistrable(g.orgDomain)
    if (icann && icann !== g.orgDomain) names.push(icann)
  }
  return dedupe(names)
}

/**
 * Where an authenticated session may send its headers (§4.6): `*.<root>` (strict
 * subdomains) for an ENUMERATE group, the exact hosts for an EXACT one, and the
 * scan root itself only when it is a target.
 */
export function authScopePatterns(groups: readonly ScopeGroup[]): string[] {
  const out: string[] = []
  for (const g of groups) {
    if (g.mode === 'enumerate') out.push(`*.${g.scanRoot}`)
    else out.push(...g.exactHosts)
    if (g.includeRoot) out.push(g.scanRoot)
  }
  return dedupe(out)
}

/** The default scope of a traffic recording: the same hosts as the auth scope. */
export function recordingScope(groups: readonly ScopeGroup[]): string[] {
  return authScopePatterns(groups)
}

/**
 * The canonical scope, for EQUALITY only ("did the scope change"): a regroup of
 * the same hosts, a reordering, or a legacy stored row re-derived, gives the
 * same set. A seed under an ENUMERATE root is not part of it: the root already
 * admits it.
 */
export function scopeSignature(groups: readonly ScopeGroup[]): Set<string> {
  const sig = new Set<string>()
  for (const g of groups) {
    if (g.mode === 'enumerate') sig.add(`enum|${g.scanRoot}`)
    else for (const h of g.exactHosts) sig.add(`exact|${h}`)
    if (g.includeRoot) sig.add(`root|${g.scanRoot}`)
  }
  return sig
}

export function sameScope(a: readonly ScopeGroup[], b: readonly ScopeGroup[]): boolean {
  const x = scopeSignature(a)
  const y = scopeSignature(b)
  return x.size === y.size && [...x].every(s => y.has(s))
}

/** Whether this scope admits `host` (§4.6 scan targets: strict subdomains of an
 *  ENUMERATE root, an EXACT group's hosts, a scan root only with Root on). */
export function admitsHost(groups: readonly ScopeGroup[], host: string): boolean {
  return groups.some(g =>
    (g.includeRoot && host === g.scanRoot)
    || g.exactHosts.includes(host)
    || (g.mode === 'enumerate' && host.endsWith(`.${g.scanRoot}`)))
}

/**
 * True when `next` admits a host `old` did not (D-21, containment): an exact host
 * not covered, an ENUMERATE root neither equal to nor strictly under an old one,
 * or a newly included scan root. A narrowing (`*.example.com` ->
 * `*.api.example.com`) or a regroup is not a widening.
 */
export function isScopeWidening(old: readonly ScopeGroup[], next: readonly ScopeGroup[]): boolean {
  const oldEnumRoots = old.filter(g => g.mode === 'enumerate').map(g => g.scanRoot)
  for (const g of next) {
    if (g.mode === 'enumerate'
        && !oldEnumRoots.some(r => isAtOrUnder(g.scanRoot, r))) return true
    if (g.includeRoot && !admitsHost(old, g.scanRoot)) return true
    if (g.mode === 'exact' && g.exactHosts.some(h => !admitsHost(old, h))) return true
  }
  return false
}

/** The names the graph's Domain nodes should carry for this scope (D-18). */
export function expectedDomainNames(groups: readonly ScopeGroup[]): string[] {
  return dedupe(groups.map(g => (GRAPH_DOMAIN_IS_ORG ? g.orgDomain : g.scanRoot).toLowerCase()))
}

/** One group as one short line: `*.api.example.com (enumerated, +root)` or
 *  `example.com: www, shop (listed)`. */
export function groupLabel(g: ScopeGroup): string {
  if (g.mode === 'enumerate') {
    return `*.${g.scanRoot} (enumerated${g.includeRoot ? ', +root' : ''}${g.exactHosts.length ? `, ${g.exactHosts.length} seeded` : ''})`
  }
  const shown = g.exactHosts.slice(0, 3).map(h => h.slice(0, h.length - g.scanRoot.length - 1))
  const more = g.exactHosts.length > 3 ? ` +${g.exactHosts.length - 3}` : ''
  const listed = [...(g.includeRoot ? [g.scanRoot] : []), ...shown].join(', ')
  return `${g.scanRoot}: ${listed}${more} (listed)`
}

/** The whole scope as one line, for cards, headers and the report cover. */
export function scopeSummary(groups: readonly ScopeGroup[]): string {
  if (groups.length === 0) return ''
  if (groups.length === 1) return groupLabel(groups[0])
  const orgs = new Set(groups.map(g => g.orgDomain)).size
  const enumerated = groups.filter(g => g.mode === 'enumerate').length
  return `${groups.length} scope groups across ${orgs} domain${orgs === 1 ? '' : 's'}`
    + (enumerated ? ` (${enumerated} enumerated)` : '')
}

/**
 * Why a scan of this saved scope cannot start, or null. A row saved under older
 * rules can hold entries the current ones refuse. A headless start (a schedule,
 * the queue), re-enabling a schedule and the schedule badge all ask this one
 * question, so they agree on when a schedule is paused for its scope.
 */
export function scopeStartProblem(project: ScopeFields): { invalid: InvalidEntry[]; message: string } | null {
  if (project.ipMode) return null
  const { groups, invalid } = resolveScopeGroups(project)
  if (invalid.length > 0) {
    return { invalid, message: `The saved scope is no longer valid. ${describeInvalid(invalid)}.` }
  }
  if (project.domainBatchMode && groups.length === 0) {
    return { invalid, message: 'Project has no valid domain groups. Re-save its hostname list before scanning.' }
  }
  return null
}
