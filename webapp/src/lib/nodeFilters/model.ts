/**
 * The node-filter rule document, as stored in `ProjectNodeFilter.rules`, and the
 * `muted_by` convention that ties a muted node back to the rule that muted it.
 *
 * Validation lives in `validate.ts`; this module is the shape and the pure
 * helpers every route and component share. The Python side of the same
 * contract is `graph_db/node_filters/model.py`.
 */

export type NodeFilterMode = 'denylist' | 'allowlist'

export const NODE_FILTER_MODES: readonly NodeFilterMode[] = ['denylist', 'allowlist']

export interface NodeFilterCondition {
  field: string
  op: string
  value?: unknown
}

export interface NodeFilterRule {
  id: string
  name: string
  enabled: boolean
  all: NodeFilterCondition[]
  /** An empty `all` is invalid unless this is set; refused in allowlist mode. */
  match_all?: boolean
}

export interface NodeFilterKind {
  enabled: boolean
  action: 'mute'
  rules: NodeFilterRule[]
}

export interface NodeFilterDoc {
  version: 1
  kinds: Record<string, NodeFilterKind>
}

export const EMPTY_NODE_FILTER_DOC: NodeFilterDoc = { version: 1, kinds: {} }

/** The prefix every rule mute's `muted_by` carries. A user id never starts with it. */
export const RULE_MUTE_PREFIX = 'rule:'

/** The `muted_by` an allowlist mute carries: no single rule muted it. */
export const ALLOWLIST_RULE_ID = 'allowlist'

export function ruleMutedBy(kind: string, ruleId: string): string {
  return `${RULE_MUTE_PREFIX}${kind}/${ruleId}`
}

export function isRuleMute(mutedBy: string | null | undefined): boolean {
  return typeof mutedBy === 'string' && mutedBy.startsWith(RULE_MUTE_PREFIX)
}

/** `rule:vuln.nuclei/k3f9a2` -> { kind: 'vuln.nuclei', ruleId: 'k3f9a2' }. */
export function parseRuleMutedBy(mutedBy: string): { kind: string; ruleId: string } | null {
  if (!isRuleMute(mutedBy)) return null
  const rest = mutedBy.slice(RULE_MUTE_PREFIX.length)
  const slash = rest.lastIndexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  return { kind: rest.slice(0, slash), ruleId: rest.slice(slash + 1) }
}

/** Coerce whatever is stored into a document, never throwing: bad input is empty. */
export function coerceDoc(raw: unknown): NodeFilterDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, kinds: {} }
  const kinds = (raw as { kinds?: unknown }).kinds
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return { version: 1, kinds: {} }
  return { version: 1, kinds: kinds as Record<string, NodeFilterKind> }
}

/**
 * Every `muted_by` a rule in this document can still produce: one per rule,
 * plus the allowlist marker per kind. A rule mute whose `muted_by` is not in
 * this set came from a rule, or a kind, that has since been deleted.
 */
export function liveRuleMutedBy(doc: NodeFilterDoc): string[] {
  const out: string[] = []
  for (const [kind, entry] of Object.entries(doc.kinds ?? {})) {
    out.push(ruleMutedBy(kind, ALLOWLIST_RULE_ID))
    for (const rule of entry?.rules ?? []) {
      if (rule && typeof rule.id === 'string') out.push(ruleMutedBy(kind, rule.id))
    }
  }
  return out
}

export type MutedByState =
  | { via: 'person' }
  | { via: 'rule'; kind: string; ruleId: string; ruleName: string | null; deleted: boolean }

/** How the Muted Nodes table describes who, or which rule, muted a row. */
export function describeMutedBy(doc: NodeFilterDoc, mutedBy: string): MutedByState {
  const parsed = parseRuleMutedBy(mutedBy)
  if (!parsed) return { via: 'person' }
  const kind = doc.kinds?.[parsed.kind]
  if (!kind) return { via: 'rule', ...parsed, ruleName: null, deleted: true }
  if (parsed.ruleId === ALLOWLIST_RULE_ID) {
    return { via: 'rule', ...parsed, ruleName: 'Allowlist: not kept by any rule', deleted: false }
  }
  const rule = (kind.rules ?? []).find(r => r?.id === parsed.ruleId)
  if (!rule) return { via: 'rule', ...parsed, ruleName: null, deleted: true }
  return { via: 'rule', ...parsed, ruleName: rule.name, deleted: false }
}
