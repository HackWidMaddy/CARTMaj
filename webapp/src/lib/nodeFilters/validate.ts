/**
 * Validate a node-filter rule document before it is saved, exactly as the engine
 * will read it (graph_db/node_filters/model.py).
 *
 * The two must agree, so the synthetic documents in `fixtures/` (written by the
 * engine's build.py) are run through both: same verdict, same active kinds, same
 * number of errors. The engine still re-validates everything it runs; this is
 * what lets the editor say what is wrong before the save rather than after.
 *
 * Fail-closed semantics, as in the engine:
 *  - denylist: an invalid rule is skipped and reported;
 *  - allowlist: one invalid ENABLED rule deactivates its whole kind;
 *  - a document that is not a version 1 object means nothing is filtered.
 */
import { NODE_FILTER_CATALOG, NO_VALUE_OPS, type CatalogKind, type NodeFilterCatalog } from './catalog'
import { NODE_FILTER_MODES, type NodeFilterMode } from './model'

export interface NodeFilterValidation {
  /** False when the document itself is unusable: nothing would be filtered. */
  ok: boolean
  /** Problems not tied to one kind (an unknown kind, a bad document). */
  errors: string[]
  /** Problems per kind, including each invalid rule. */
  kindErrors: Record<string, string[]>
  /** Per kind, the ids of rules that are invalid. */
  invalidRules: Record<string, string[]>
  /** Kinds with their switch on and at least one valid enabled rule. */
  activeKinds: string[]
  /** Per kind, how many valid enabled rules the engine would run. */
  runnableRules: Record<string, number>
}

const RULE_ID = /^[a-z0-9]{6,12}$/
const RULE_NAME = /^[\p{L}\p{N} .,:()_/+-]+$/u
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/

class Invalid extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** `obj.get(key, fallback)` as Python reads it: a key present with null stays null. */
function get(obj: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback
}

/** A catalog entry by a client-supplied name: `constructor` is not a field. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

export function validRuleName(name: unknown, maxLength = NODE_FILTER_CATALOG.limits.name_length): boolean {
  if (typeof name !== 'string') return false
  if (name.length < 1 || [...name].length > maxLength) return false
  if (name.trim() !== name || !name.trim()) return false
  return RULE_NAME.test(name)
}

function parseIpv4(text: string): boolean {
  const parts = text.split('.')
  if (parts.length !== 4) return false
  return parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
}

function parseIpv6(text: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return false
  const halves = text.split('::')
  if (halves.length > 2) return false
  const groups = (s: string) => (s === '' ? [] : s.split(':'))
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const all = [...head, ...tail]
  let width = 0
  for (let i = 0; i < all.length; i++) {
    const g = all[i]
    if (i === all.length - 1 && g.includes('.')) {
      if (!parseIpv4(g)) return false
      width += 2
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false
      width += 1
    }
  }
  return halves.length === 2 ? width < 8 : width === 8
}

/** An IP address or CIDR, as Python's `ip_network(strict=False)` accepts it. */
export function validNetwork(value: string): boolean {
  const [addr, prefix, extra] = value.split('/')
  if (extra !== undefined) return false
  const v4 = parseIpv4(addr)
  const v6 = !v4 && parseIpv6(addr)
  if (!v4 && !v6) return false
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  return Number(prefix) <= (v4 ? 32 : 128)
}

function str(value: unknown, what: string, catalog: NodeFilterCatalog): string {
  if (typeof value !== 'string' || !value.trim()) throw new Invalid(`${what} must be a non-empty string`)
  if (value.length > catalog.limits.string_length) {
    throw new Invalid(`${what} is longer than ${catalog.limits.string_length} characters`)
  }
  return value.trim()
}

function strList(value: unknown, what: string, catalog: NodeFilterCatalog): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Invalid(`${what} must be a non-empty list`)
  if (value.length > catalog.limits.values_per_list) {
    throw new Invalid(`${what} has more than ${catalog.limits.values_per_list} values`)
  }
  return value.map(v => str(v, what, catalog))
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Invalid(`${what} must be a number`)
  return value
}

function checkCondition(raw: unknown, kind: CatalogKind, catalog: NodeFilterCatalog, where: string): void {
  if (!isObject(raw)) throw new Invalid(`${where}: a condition must be an object`)
  const name = raw.field
  const fdef = typeof name === 'string' ? own(kind.fields, name) : undefined
  if (!fdef) throw new Invalid(`${where}: unknown field ${JSON.stringify(name)}`)
  const op = raw.op
  if (typeof op !== 'string' || !catalog.operators[fdef.type].includes(op)) {
    throw new Invalid(`${where}: operator ${JSON.stringify(op)} does not apply to ${fdef.type} field ${name}`)
  }
  const value = raw.value
  const what = `${where} (${name} ${op})`

  if (NO_VALUE_OPS.has(op)) {
    const empty = value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0)
    if (!empty) throw new Invalid(`${what} takes no value`)
    return
  }

  switch (fdef.type) {
    case 'ordinal': {
      const scale = (catalog.ordinals[fdef.scale ?? ''] ?? []).map(s => s.toLowerCase())
      const values = op === 'in' || op === 'not_in'
        ? strList(value, what, catalog)
        : [str(value, what, catalog)]
      const bad = values.find(v => !scale.includes(v.toLowerCase()))
      if (bad !== undefined) throw new Invalid(`${what}: "${bad}" is not one of ${scale.join(', ')}`)
      return
    }
    case 'number': {
      if (op === 'between') {
        if (!Array.isArray(value) || value.length !== 2) throw new Invalid(`${what} needs two numbers`)
        const lo = num(value[0], what)
        const hi = num(value[1], what)
        if (lo > hi) throw new Invalid(`${what}: the lower bound is above the upper one`)
        return
      }
      num(value, what)
      return
    }
    case 'enum':
    case 'list':
      strList(value, what, catalog)
      return
    case 'ip': {
      for (const v of strList(value, what, catalog)) {
        if (!validNetwork(v)) throw new Invalid(`${what}: "${v}" is not an IP address or CIDR`)
      }
      return
    }
    case 'date': {
      if (op === 'older_than_days' || op === 'newer_than_days') {
        const days = num(value, what)
        if (days < 0 || days > catalog.limits.max_days) {
          throw new Invalid(`${what} must be between 0 and ${catalog.limits.max_days} days`)
        }
        return
      }
      const text = str(value, what, catalog)
      if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(text.replace(' ', 'T')))) {
        throw new Invalid(`${what}: "${text}" is not an ISO date`)
      }
      return
    }
    default: {
      const text = str(value, what, catalog)
      if ((op === 'glob' || op === 'not_glob') && (text.match(/\*/g)?.length ?? 0) > catalog.limits.glob_stars) {
        throw new Invalid(`${what}: more than ${catalog.limits.glob_stars} wildcards`)
      }
    }
  }
}

function checkRule(
  raw: unknown, kind: CatalogKind, catalog: NodeFilterCatalog, mode: NodeFilterMode,
  where: string, seen: Set<string>,
): { enabled: boolean } {
  if (!isObject(raw)) throw new Invalid(`${where}: a rule must be an object`)
  const id = raw.id
  if (typeof id !== 'string' || !RULE_ID.test(id)) {
    throw new Invalid(`${where}: rule id must be 6-12 lowercase letters or digits`)
  }
  if (seen.has(id)) throw new Invalid(`${where}: duplicate rule id "${id}"`)
  seen.add(id)
  if (!validRuleName(raw.name, catalog.limits.name_length)) {
    throw new Invalid(`${where}: rule names are 1-80 letters, digits, spaces or .,:()_/+-`)
  }
  const enabled = get(raw, 'enabled', true)
  if (typeof enabled !== 'boolean') throw new Invalid(`${where}: enabled must be true or false`)
  const matchAll = get(raw, 'match_all', false)
  if (typeof matchAll !== 'boolean') throw new Invalid(`${where}: match_all must be true or false`)
  const conditions = get(raw, 'all', [])
  if (!Array.isArray(conditions)) throw new Invalid(`${where}: \`all\` must be a list`)
  if (conditions.length > catalog.limits.conditions_per_rule) {
    throw new Invalid(`${where}: more than ${catalog.limits.conditions_per_rule} conditions`)
  }
  if (matchAll && mode === 'allowlist') throw new Invalid(`${where}: \`match all\` is refused in allowlist mode`)
  if (conditions.length === 0 && !matchAll) throw new Invalid(`${where}: a rule needs at least one condition`)
  if (matchAll && conditions.length > 0) throw new Invalid(`${where}: a \`match all\` rule takes no conditions`)
  conditions.forEach((c, i) => checkCondition(c, kind, catalog, `${where} condition ${i + 1}`))
  return { enabled }
}

function documentBytes(doc: unknown): number {
  return new TextEncoder().encode(typeof doc === 'string' ? doc : JSON.stringify(doc ?? null)).length
}

export function validateNodeFilters(
  mode: unknown,
  rules: unknown,
  catalog: NodeFilterCatalog = NODE_FILTER_CATALOG,
): NodeFilterValidation {
  const out: NodeFilterValidation = {
    ok: true, errors: [], kindErrors: {}, invalidRules: {}, activeKinds: [], runnableRules: {},
  }
  const fail = (msg: string) => ({ ...out, ok: false, errors: [msg] })

  if (typeof mode !== 'string' || !(NODE_FILTER_MODES as readonly string[]).includes(mode)) {
    return fail(`unknown mode ${JSON.stringify(mode)}; nothing is filtered`)
  }
  if (rules === undefined || rules === null) return out
  const doc: unknown = rules
  if (documentBytes(doc) > catalog.limits.document_bytes) return fail('the rule document is larger than 64 KB')
  // The engine also parses a JSON string, but the webapp stores what it
  // validates: a string would be saved as an empty document by coerceDoc, or
  // raw by an import, where the UI shows no rules and the scan sweep runs them.
  if (typeof doc === 'string') return fail('the rules must be a JSON object, not a string')
  if (!isObject(doc) || get(doc, 'version', 1) !== 1) return fail('the rules must be a version 1 document')
  const kinds = get(doc, 'kinds', {})
  if (!isObject(kinds)) return fail('`kinds` must be an object')

  const phases = new Set(catalog.enabled_phases)
  const active: string[] = []
  for (const [kindId, entry] of Object.entries(kinds)) {
    const kind = own(catalog.kinds, kindId)
    if (!kind) { out.errors.push(`unknown kind "${kindId}": ignored`); continue }
    if (!phases.has(kind.phase)) { out.errors.push(`kind "${kindId}" cannot be filtered yet: ignored`); continue }
    if (!isObject(entry)) { out.errors.push(`${kindId}: must be an object: ignored`); continue }
    const errors: string[] = []
    const invalid: string[] = []
    out.kindErrors[kindId] = errors
    out.invalidRules[kindId] = invalid
    const enabled = entry.enabled === true
    if (get(entry, 'action', 'mute') !== 'mute') { errors.push(`${kindId}: only the mute action exists in this phase`); continue }
    const rulesRaw = get(entry, 'rules', [])
    if (!Array.isArray(rulesRaw)) { errors.push(`${kindId}: \`rules\` must be a list`); continue }
    if (rulesRaw.length > catalog.limits.rules_per_kind) {
      errors.push(`${kindId}: more than ${catalog.limits.rules_per_kind} rules`)
      continue
    }
    const seen = new Set<string>()
    let validEnabled = 0
    let invalidEnabled = false
    rulesRaw.forEach((raw, i) => {
      try {
        if (checkRule(raw, kind, catalog, mode as NodeFilterMode, `${kindId} rule ${i + 1}`, seen).enabled) {
          validEnabled += 1
        }
      } catch (e) {
        if (!(e instanceof Invalid)) throw e
        errors.push(e.message)
        if (isObject(raw) && typeof raw.id === 'string') invalid.push(raw.id)
        invalidEnabled = invalidEnabled || !isObject(raw) || raw.enabled !== false
      }
    })
    if (mode === 'allowlist' && invalidEnabled) {
      errors.push(`${kindId}: an invalid keep rule deactivates the whole kind in allowlist mode`)
      validEnabled = 0
    }
    out.runnableRules[kindId] = validEnabled
    if (enabled && validEnabled > 0) active.push(kindId)
  }
  out.activeKinds = active.sort()
  return out
}

/** Every error in one list, for a 400 body or a banner. */
export function allErrors(v: NodeFilterValidation): string[] {
  return [...v.errors, ...Object.values(v.kindErrors).flat()]
}

/** Enabled rules in active kinds: what the armed badge counts. */
export function countActiveRules(
  mode: unknown, rules: unknown, catalog: NodeFilterCatalog = NODE_FILTER_CATALOG,
): { rules: number; kinds: number } {
  const v = validateNodeFilters(mode, rules, catalog)
  if (!v.ok) return { rules: 0, kinds: 0 }
  const count = v.activeKinds.reduce((sum, kindId) => sum + (v.runnableRules[kindId] ?? 0), 0)
  return { rules: count, kinds: v.activeKinds.length }
}
