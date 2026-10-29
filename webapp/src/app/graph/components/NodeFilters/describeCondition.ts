/**
 * Operator wording, and how one condition reads as a sentence on a rule card:
 * "severity is one of info, low", "host matches *.example.com".
 */
import type { CatalogField, FieldType } from '@/lib/nodeFilters/catalog'
import type { NodeFilterCondition } from '@/lib/nodeFilters/model'

export const OP_LABELS: Record<string, string> = {
  lt: 'is below', lte: 'is at most', gt: 'is above', gte: 'is at least', between: 'is between',
  missing: 'is missing', in: 'is one of', not_in: 'is not one of',
  not_eq: 'is not', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', ends_with: 'ends with', glob: 'matches', not_glob: 'does not match',
  in_cidr: 'is in', not_in_cidr: 'is not in', is_true: 'is true', is_false: 'is false',
  contains_any: 'contains any of', contains_all: 'contains all of', not_contains_any: 'contains none of',
  is_empty: 'is empty', before: 'is before', after: 'is after',
  older_than_days: 'is older than (days)', newer_than_days: 'is newer than (days)',
}

/** `eq` reads differently on a number and on text. */
export function opLabel(op: string, type: FieldType): string {
  if (op === 'eq') return type === 'number' ? 'equals' : 'is'
  return OP_LABELS[op] ?? op
}

/** Operators whose value is a list. */
export const LIST_OPS = new Set([
  'in', 'not_in', 'contains_any', 'contains_all', 'not_contains_any', 'in_cidr', 'not_in_cidr',
])

export function fieldLabel(name: string, field?: CatalogField): string {
  return field?.label ?? name.replace(/_/g, ' ')
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(v => String(v)).join(', ')
  if (value === undefined || value === null) return ''
  return String(value)
}

export function describeCondition(cond: NodeFilterCondition, field?: CatalogField): string {
  const type = field?.type ?? 'text'
  const label = fieldLabel(cond.field, field)
  const op = opLabel(cond.op, type)
  if (cond.op === 'between' && Array.isArray(cond.value)) {
    return `${label} ${op} ${cond.value[0]} and ${cond.value[1]}`
  }
  const value = formatValue(cond.value)
  return value ? `${label} ${op} ${value}` : `${label} ${op}`
}
