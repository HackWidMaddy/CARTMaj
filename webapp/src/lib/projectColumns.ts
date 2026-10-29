import { Prisma } from '@prisma/client'

/**
 * A Project row's own columns.
 *
 * Prisma's create and update also accept nested relation writes, so a body
 * handed to them unfiltered can create, rewrite or delete rows in any related
 * table (node filters and their runs, triage runs, scan jobs, ...), past every
 * check those tables' own routes make. Whatever arrives from a client or an
 * import bundle goes through this first.
 */
export const PROJECT_SCALAR_COLUMNS: ReadonlySet<string> = new Set(Object.keys(Prisma.ProjectScalarFieldEnum))

export function pickProjectColumns(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => PROJECT_SCALAR_COLUMNS.has(key)))
}
