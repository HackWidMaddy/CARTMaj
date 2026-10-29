/**
 * Neo4j property serialization for the EXPORT (restore-fidelity) format.
 *
 * Extracted verbatim from `api/projects/[id]/export/route.ts` so the project
 * exporter and the Scan Timeline snapshot capture (`lib/scanSnapshot.ts`) produce
 * byte-identical payloads - that is what makes a snapshot restorable back into
 * Neo4j by the shared restore path (`lib/graphRestore.ts`).
 *
 * Unlike `api/graph/format.ts:serializeProperties` (render shape, integers only)
 * this also flattens Neo4j temporal types and recurses into arrays.
 */

export function serializeGraphValue(value: unknown): unknown {
  if (value === null || value === undefined) return value

  // Neo4j DateTime: has year/month/day fields (check before integer check)
  if (typeof value === 'object' && 'year' in value && 'month' in value && 'day' in value) {
    const v = value as Record<string, unknown>
    const get = (k: string): number => {
      const f = v[k]
      if (f && typeof f === 'object' && 'low' in f) return (f as { low: number }).low
      return typeof f === 'number' ? f : 0
    }
    const year = get('year')
    const month = String(get('month')).padStart(2, '0')
    const day = String(get('day')).padStart(2, '0')
    const hour = String(get('hour')).padStart(2, '0')
    const minute = String(get('minute')).padStart(2, '0')
    const second = String(get('second')).padStart(2, '0')
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
  }

  // Neo4j Integer: has low/high fields (driver Integer objects)
  if (typeof value === 'object' && 'low' in value && 'high' in value) {
    return (value as { low: number }).low
  }

  // Arrays: recurse into elements
  if (Array.isArray(value)) {
    return value.map(v => serializeGraphValue(v))
  }

  return value
}

export function serializeGraphProperties(props: Record<string, unknown>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props || {})) {
    serialized[key] = serializeGraphValue(value)
  }
  return serialized
}
