/**
 * The scan-time node-filter sweep prints `[NODE-FILTER] <kind> mode=... muted=N ...`
 * per kind and rule, and `[!][NODE-FILTER] ...` when it failed or stopped early.
 * The drawer renders those as a card so the mutes a scan applied are not lost in
 * the scroll; a failure gets the warning style, because the unswept findings stay
 * visible until the next scan or an apply.
 */
export type NodeFilterLineKind = 'summary' | 'problem'

export function nodeFilterLineKind(text: string): NodeFilterLineKind | null {
  if (text.includes('[!][NODE-FILTER]')) return 'problem'
  if (text.includes('[NODE-FILTER]')) return 'summary'
  return null
}
