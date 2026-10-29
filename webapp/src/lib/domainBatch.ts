/**
 * Domain batch: turn the operator's host list into ordered scope groups.
 *
 * This is the ONLY implementation of the grouping rule. The form renders its
 * preview from it, every write path re-derives from it, and resolveScopeGroups()
 * (scopeGroups.ts) derives the groups every reader uses from the stored host
 * list, so what the operator approved is literally what the pipeline runs.
 *
 * An entry is either an EXACT host ("scan exactly this host") or a WILDCARD
 * `*.X` ("enumerate everything under X"), at any depth. Hosts group by their
 * registrable (org) domain from the Public Suffix List (publicSuffix.ts), never
 * by "the last two labels": `foo.example.co.uk` belongs to `example.co.uk`, and
 * `*.co.uk` is refused because co.uk is a public suffix.
 *
 * Group order is the order of the first entry that formed or joined each group,
 * and it is the RUN order: the operator approves a list in the preview and the
 * pipeline walks it top to bottom.
 */
import { isIpLiteral, orgDomain } from '@/lib/publicSuffix'

/** Legacy stored-prefix markers, read by not-yet-migrated readers and 7.1.0:
 *  "." is the root itself, "*" means "enumerate this domain". */
export const ROOT_DOMAIN_PREFIX = '.'
export const WILDCARD_PREFIX = '*'

/**
 * Whether `*.api.example.com` (a wildcard below the org) is a scan root of its
 * own. It needs the graph to attach a deeper scan root to its org Domain, so
 * it ships with GRAPH_DOMAIN_IS_ORG. Not a user setting; kept as a constant so
 * the refusal path (nested_wildcard_disabled) stays testable.
 */
export const NESTED_WILDCARDS_ENABLED = true

/**
 * Caps on one batch. MAX_BATCH_GROUPS mirrors supplyChainOrgMaxRepos: without
 * one, a pasted list becomes a single run that holds the project's one scan slot
 * for weeks. They bound the TYPED list, not the run: an ENUMERATE group finds
 * hosts the list never named, which the preview badge and cost warning cover.
 */
export const MAX_BATCH_HOSTS = 500
export const MAX_BATCH_GROUPS = 50

/** Why an entry was refused; the UI and the APIs show one line per entry. */
export type InvalidReason =
  | 'not_hostname' | 'too_long' | 'ip_literal' | 'public_suffix' | 'wildcard_on_suffix'
  | 'malformed_wildcard' | 'nested_wildcard_disabled' | 'invalid_prefix'

export interface InvalidEntry {
  /** As typed. */
  entry: string
  reason: InvalidReason
}

export const INVALID_REASON_TEXT: Record<InvalidReason, string> = {
  not_hostname: 'not a valid hostname',
  too_long: 'longer than 253 characters',
  ip_literal: 'an IP address: use IP mode',
  public_suffix: 'a public suffix, where anyone can register names: enter a domain under it',
  wildcard_on_suffix: 'a wildcard on a public suffix would enumerate everyone registered under it',
  malformed_wildcard: 'a wildcard is "*.name" (or "*name"), once, at the start',
  nested_wildcard_disabled: 'a wildcard below the registrable domain is not supported yet: use *.<registrable domain>',
  invalid_prefix: 'not a valid subdomain prefix',
}

/** One pass of the recon pipeline. Derived on every read, never stored. */
export interface ScopeGroup {
  /** What the group enumerates or scans under; unique per group. */
  scanRoot: string
  /** The registrable domain of the scan root. */
  orgDomain: string
  /** exact: scan exactly the listed hosts. enumerate: discover and scan everything under scanRoot. */
  mode: 'exact' | 'enumerate'
  /** The scan root itself is a target (the "Root" checkbox). */
  includeRoot: boolean
  /** EXACT: the listed hosts. ENUMERATE: seeds scanned even if discovery misses them.
   *  Never contains "*", never the scan root. */
  exactHosts: string[]
  /** The normalised entries that formed the group, for display. */
  entries: string[]
  /** Nested wildcards collapsed into this group's broader one. */
  notes: { entry: string; coveredBy: string }[]
}

/**
 * The record stored in Project.domainBatchGroups: the shape 7.1.0 and the
 * not-yet-migrated readers expect, computed from the scope groups on every write.
 * No new reader reads it.
 */
export interface DomainGroup {
  /** === scanRoot. */
  rootDomain: string
  /** "*" if enumerate, "." if includeRoot, then each exact host minus ".<root>" with a trailing dot. */
  prefixes: string[]
  /** === entries (contains "*.x" tokens: never an auth scope). */
  hosts: string[]
  /** === (mode === 'enumerate'). */
  wildcard: boolean
}

/**
 * Everything a hostname may contain once normalized. This is the choke point for
 * untrusted input: a host reaches a Cypher MERGE, a scan target and a filename,
 * so anything outside this set is REJECTED rather than sanitized - silently
 * stripping characters would scan a different host than the operator read.
 */
const HOSTNAME_CHARSET = /^[a-z0-9.-]+$/
const MAX_HOSTNAME_LENGTH = 253

/** Strip the things people paste around a hostname: scheme, credentials, path,
 *  query, port, surrounding whitespace and a trailing root dot. An IPv6 literal
 *  is kept whole so it can be refused as an address rather than mangled. */
export function normalizeHost(raw: string): string {
  let h = String(raw ?? '').trim().toLowerCase()
  if (!h) return ''
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')  // scheme
  h = h.split('/')[0].split('?')[0].split('#')[0]  // path / query / fragment
  const at = h.lastIndexOf('@')
  if (at !== -1) h = h.slice(at + 1)  // credentials
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'))
  if ((h.match(/:/g) ?? []).length > 1) return h  // bare IPv6
  h = h.split(':')[0]  // port
  h = h.replace(/\.+$/, '')  // trailing root dot
  return h
}

/**
 * Split a leading wildcard marker off an entry, before any charset test.
 *
 * `*` is recognized in exactly ONE place - here - so HOSTNAME_CHARSET stays free
 * of metacharacters and every other gate keeps rejecting a stray star. Both
 * spellings an operator might paste mean the same thing: `*.example.com` and
 * `*example.com`. Only ONE marker is stripped, so `**.example.com` keeps a `*`
 * and is refused as malformed.
 */
export function splitWildcard(host: string): { wildcard: boolean; rest: string } {
  if (host.startsWith('*.')) return { wildcard: true, rest: host.slice(2) }
  if (host.startsWith('*')) return { wildcard: true, rest: host.slice(1) }
  return { wildcard: false, rest: host }
}

/** The shape REGEX_DOMAIN enforces: two or more labels of 1-63 characters, no
 *  label starting or ending with a hyphen, and an alphabetic TLD. */
function isHostnameShape(host: string): boolean {
  if (!host || !HOSTNAME_CHARSET.test(host)) return false
  const labels = host.split('.')
  if (labels.length < 2) return false
  if (labels.some(l => l.length === 0 || l.length > 63)) return false
  if (labels.some(l => l.startsWith('-') || l.endsWith('-'))) return false
  return /^[a-z]{2,}$/.test(labels[labels.length - 1])
}

export type ParsedEntry =
  | { ok: true; host: string; wildcard: boolean; org: string }
  | { ok: false; reason: InvalidReason }

export interface GroupingOptions {
  /** Defaults to NESTED_WILDCARDS_ENABLED; tests exercise both settings. */
  nestedWildcards?: boolean
}

/** Normalise and validate one entry (§4.1). The PSL is consulted on the name
 *  with its wildcard marker stripped: tldts answers null for `*.example.com`. */
export function parseEntry(raw: string, opts: GroupingOptions = {}): ParsedEntry {
  const { wildcard, rest } = splitWildcard(normalizeHost(raw))
  if (rest.includes('*') || (wildcard && !rest)) return { ok: false, reason: 'malformed_wildcard' }
  if (isIpLiteral(rest)) return { ok: false, reason: 'ip_literal' }
  if (rest.length > MAX_HOSTNAME_LENGTH) return { ok: false, reason: 'too_long' }
  if (!isHostnameShape(rest)) return { ok: false, reason: 'not_hostname' }
  const org = orgDomain(rest)
  if (org === null) return { ok: false, reason: wildcard ? 'wildcard_on_suffix' : 'public_suffix' }
  if (wildcard && rest !== org && !(opts.nestedWildcards ?? NESTED_WILDCARDS_ENABLED)) {
    return { ok: false, reason: 'nested_wildcard_disabled' }
  }
  return { ok: true, host: rest, wildcard, org }
}

/** `host` is `root` or strictly under it, on a label boundary. */
export function isAtOrUnder(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`)
}

export interface GroupingResult {
  groups: ScopeGroup[]
  invalid: InvalidEntry[]
  /** The deduped normalised entries in operator order, wildcards written `*.x`,
   *  collapsed ones included: exactly what is stored in domainBatchHosts. */
  entries: string[]
}

/**
 * Group entries into scope groups (§4.2).
 *
 *   1. normalise + validate; dedupe on the PAIR (wildcard, host): `*.example.com`
 *      and `example.com` reduce to one host but mean different things;
 *   2. a wildcard under another wildcard collapses into it (noted on the group);
 *   3. each surviving wildcard is an ENUMERATE group;
 *   4. an exact host under a wildcard root joins it (the root itself turns Root
 *      on, anything below is a seed); any other exact host joins the EXACT group
 *      of its org (the org itself turns Root on);
 *   5. groups are ordered by the first entry that formed or joined them.
 */
export function groupHostsByScanRoot(rawEntries: readonly string[], opts: GroupingOptions = {}): GroupingResult {
  const invalid: InvalidEntry[] = []
  const entries: string[] = []
  const parsed: { host: string; wildcard: boolean; org: string; index: number }[] = []
  const seen = new Set<string>()

  for (const raw of rawEntries) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const p = parseEntry(raw, opts)
    if (!p.ok) {
      if (!invalid.some(i => i.entry === raw.trim())) invalid.push({ entry: raw.trim(), reason: p.reason })
      continue
    }
    const token = p.wildcard ? `*.${p.host}` : p.host
    if (seen.has(token)) continue
    seen.add(token)
    entries.push(token)
    parsed.push({ host: p.host, wildcard: p.wildcard, org: p.org, index: parsed.length })
  }

  const wildcardRoots = parsed.filter(e => e.wildcard)
  const surviving = wildcardRoots.filter(w => !wildcardRoots.some(o => o !== w && w.host.endsWith(`.${o.host}`)))

  const groups = new Map<string, ScopeGroup>()
  const firstIndex = new Map<string, number>()
  const join = (key: string, index: number) => {
    firstIndex.set(key, Math.min(firstIndex.get(key) ?? Infinity, index))
  }

  for (const w of surviving) {
    groups.set(w.host, {
      scanRoot: w.host, orgDomain: w.org, mode: 'enumerate', includeRoot: false,
      exactHosts: [], entries: [`*.${w.host}`], notes: [],
    })
    join(w.host, w.index)
  }
  for (const w of wildcardRoots) {
    if (surviving.includes(w)) continue
    // The broadest surviving wildcard covers it: collapse is transitive.
    const cover = surviving.find(s => w.host.endsWith(`.${s.host}`))!
    const g = groups.get(cover.host)!
    g.entries.push(`*.${w.host}`)
    g.notes.push({ entry: `*.${w.host}`, coveredBy: `*.${cover.host}` })
    join(cover.host, w.index)
  }

  for (const e of parsed) {
    if (e.wildcard) continue
    const under = surviving.find(s => isAtOrUnder(e.host, s.host))
    const key = under ? under.host : e.org
    let g = groups.get(key)
    if (!g) {
      g = { scanRoot: e.org, orgDomain: e.org, mode: 'exact', includeRoot: false, exactHosts: [], entries: [], notes: [] }
      groups.set(key, g)
    }
    g.entries.push(e.host)
    if (e.host === g.scanRoot) g.includeRoot = true
    else if (!g.exactHosts.includes(e.host)) g.exactHosts.push(e.host)
    join(key, e.index)
  }

  const ordered = [...groups.entries()]
    .sort((a, b) => (firstIndex.get(a[0]) ?? 0) - (firstIndex.get(b[0]) ?? 0))
    .map(([, g]) => g)
  return { groups: ordered, invalid, entries }
}

/** The legacy stored record of one scope group (see DomainGroup). */
export function toLegacyRecord(g: ScopeGroup): DomainGroup {
  const prefixes: string[] = []
  if (g.mode === 'enumerate') prefixes.push(WILDCARD_PREFIX)
  if (g.includeRoot) prefixes.push(ROOT_DOMAIN_PREFIX)
  for (const h of g.exactHosts) prefixes.push(`${h.slice(0, h.length - g.scanRoot.length - 1)}.`)
  return { rootDomain: g.scanRoot, prefixes, hosts: [...g.entries], wildcard: g.mode === 'enumerate' }
}

/** One line per refused entry, as the routes and the MCP tools report it. */
export function describeInvalid(invalid: readonly InvalidEntry[], max = 5): string {
  const shown = invalid.slice(0, max).map(i => `${i.entry} (${INVALID_REASON_TEXT[i.reason]})`)
  return `Not accepted: ${shown.join('; ')}` + (invalid.length > max ? ` (+${invalid.length - max} more)` : '')
}

export interface BatchValidation {
  ok: boolean
  errors: string[]
  groups: ScopeGroup[]
  invalid: InvalidEntry[]
  /** What to store in domainBatchHosts (normalised, collapsed entries included). */
  entries: string[]
  /** What to store in domainBatchGroups. */
  legacy: DomainGroup[]
}

/**
 * The shared gate for a batch host list: grouping plus the caps. Used by the form
 * before submit and by every write path before persisting, so the UI and the
 * server can never disagree about what is acceptable.
 */
export function validateDomainBatch(hosts: readonly string[]): BatchValidation {
  const { groups, invalid, entries } = groupHostsByScanRoot(hosts)
  const errors: string[] = []

  const supplied = hosts.filter(h => typeof h === 'string' && h.trim()).length
  if (supplied > MAX_BATCH_HOSTS) {
    errors.push(`Too many hostnames: ${supplied}. The limit is ${MAX_BATCH_HOSTS}.`)
  }
  if (groups.length > MAX_BATCH_GROUPS) {
    errors.push(`Too many scope groups: ${groups.length}. The limit is ${MAX_BATCH_GROUPS}.`)
  }
  if (invalid.length > 0) errors.push(describeInvalid(invalid))
  if (groups.length === 0 && errors.length === 0) {
    errors.push('Domain batch mode needs at least one hostname.')
  }

  return { ok: errors.length === 0, errors, groups, invalid, entries, legacy: groups.map(toLegacyRecord) }
}
