/**
 * Immutable edits to a rule document, so the editor can compare a draft with
 * what was saved and every change is one small, testable function.
 */
import type { CatalogField } from '@/lib/nodeFilters/catalog'
import { NO_VALUE_OPS } from '@/lib/nodeFilters/catalog'
import type {
  NodeFilterCondition, NodeFilterDoc, NodeFilterKind, NodeFilterRule,
} from '@/lib/nodeFilters/model'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 8 characters of [a-z0-9]: the engine accepts 6-12. Never reused within a kind. */
export function newRuleId(taken: Iterable<string> = [], random: () => number = Math.random): string {
  const used = new Set(taken)
  for (;;) {
    let id = ''
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)]
    if (!used.has(id)) return id
  }
}

export function kindEntry(doc: NodeFilterDoc, kind: string): NodeFilterKind {
  return doc.kinds[kind] ?? { enabled: false, action: 'mute', rules: [] }
}

export function setKind(doc: NodeFilterDoc, kind: string, next: NodeFilterKind): NodeFilterDoc {
  return { ...doc, kinds: { ...doc.kinds, [kind]: next } }
}

export function setKindEnabled(doc: NodeFilterDoc, kind: string, enabled: boolean): NodeFilterDoc {
  return setKind(doc, kind, { ...kindEntry(doc, kind), enabled })
}

export function addRule(doc: NodeFilterDoc, kind: string, rule?: Partial<NodeFilterRule>): {
  doc: NodeFilterDoc; id: string
} {
  const entry = kindEntry(doc, kind)
  const id = newRuleId(entry.rules.map(r => r.id))
  const next: NodeFilterRule = {
    id, name: rule?.name ?? `Rule ${entry.rules.length + 1}`, enabled: rule?.enabled ?? true,
    all: rule?.all ?? [], ...(rule?.match_all ? { match_all: true } : {}),
  }
  // A kind the operator is adding rules to is one they mean to use.
  const enabled = entry.rules.length === 0 ? true : entry.enabled
  return { doc: setKind(doc, kind, { ...entry, enabled, rules: [...entry.rules, next] }), id }
}

export function updateRule(
  doc: NodeFilterDoc, kind: string, id: string, patch: Partial<NodeFilterRule>,
): NodeFilterDoc {
  const entry = kindEntry(doc, kind)
  return setKind(doc, kind, {
    ...entry, rules: entry.rules.map(r => (r.id === id ? { ...r, ...patch } : r)),
  })
}

export function removeRule(doc: NodeFilterDoc, kind: string, id: string): NodeFilterDoc {
  const entry = kindEntry(doc, kind)
  return setKind(doc, kind, { ...entry, rules: entry.rules.filter(r => r.id !== id) })
}

/** A sensible starting condition for a field: its first operator, and an empty value. */
export function defaultCondition(name: string, field: CatalogField, operators: string[]): NodeFilterCondition {
  const op = operators[0]
  return { field: name, op, ...(NO_VALUE_OPS.has(op) ? {} : { value: defaultValue(op, field) }) }
}

export function defaultValue(op: string, field: CatalogField): unknown {
  if (NO_VALUE_OPS.has(op)) return undefined
  if (op === 'between') return [0, 10]
  if (['in', 'not_in', 'contains_any', 'contains_all', 'not_contains_any', 'in_cidr', 'not_in_cidr'].includes(op)) {
    return []
  }
  if (field.type === 'number') return 0
  if (op === 'older_than_days' || op === 'newer_than_days') return 30
  return ''
}

/** Same document, ignoring key order: what "unsaved changes" compares. */
export function sameDoc(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}
