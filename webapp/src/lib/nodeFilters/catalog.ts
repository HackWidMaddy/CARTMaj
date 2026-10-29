/**
 * The node-filter catalog, as the engine builds it (graph_db/node_filters/build.py
 * writes catalog.json here). The editor offers exactly these kinds, fields and
 * operators, and validate.ts checks a document against them.
 */
import catalogJson from './catalog.json'

export type FieldType =
  | 'number' | 'ordinal' | 'enum' | 'text' | 'host' | 'url' | 'ip' | 'bool' | 'list' | 'date'

export interface CatalogField {
  type: FieldType
  label?: string
  prop?: string
  normalizer?: string
  from?: string
  scale?: string
  values?: string[]
  value_groups?: Record<string, string[]>
}

export interface CatalogExample {
  name: string
  all?: { field: string; op: string; value?: unknown }[]
  match_all?: boolean
}

export interface CatalogKind {
  id: string
  group: string
  label: string
  graph_label: string
  key: string
  select: Record<string, unknown>[]
  sources: string[]
  behaviour: string
  phase: number
  fields: Record<string, CatalogField>
  overlaps: { setting: string; tab: string }[]
  examples: CatalogExample[]
  notes: string[]
}

export interface NodeFilterCatalog {
  version: number
  enabled_phases: number[]
  ordinals: Record<string, string[]>
  groups: { id: string; label: string }[]
  operators: Record<FieldType, string[]>
  limits: {
    rules_per_kind: number
    conditions_per_rule: number
    values_per_list: number
    string_length: number
    document_bytes: number
    glob_stars: number
    max_days: number
    name_length: number
  }
  kinds: Record<string, CatalogKind>
  unfiltered_sources: Record<string, string>
  asset_sources: Record<string, string>
  locked: { label: string; reason: string }[]
  planned: { id: string; label: string; phase: number; behaviour: string }[]
}

export const NODE_FILTER_CATALOG = catalogJson as unknown as NodeFilterCatalog

/** Kinds in the phases the engine filters today, in catalog order. */
export function enabledKinds(catalog: NodeFilterCatalog = NODE_FILTER_CATALOG): CatalogKind[] {
  const phases = new Set(catalog.enabled_phases)
  return Object.values(catalog.kinds).filter(k => phases.has(k.phase))
}

/** Operators that take no value. */
export const NO_VALUE_OPS = new Set(['missing', 'is_true', 'is_false', 'is_empty'])
