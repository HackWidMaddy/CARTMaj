/**
 * Hand-rolled tidy-tree layout for the LATS exploit-path tree (§17.2).
 *
 * Left-to-right: root at x=0, depth grows right (x = depth * xStep). Leaves get
 * their own row; internal nodes are centered on their children. Reingold-Tilford
 * flavored but intentionally minimal - the tree is bounded at LATS_MAX_TREE_NODES
 * (~60), so an O(n) post-order pass is plenty and needs no external lib.
 */

import type { LatsNodeView } from '@/lib/websocket-types'

export const LATS_X_STEP = 230
export const LATS_Y_STEP = 68

export interface LatsLayoutPos {
  id: string
  x: number
  y: number
}

interface LayoutOpts {
  xStep?: number
  yStep?: number
}

export function latsTreeLayout(nodes: LatsNodeView[], opts: LayoutOpts = {}): LatsLayoutPos[] {
  const xStep = opts.xStep ?? LATS_X_STEP
  const yStep = opts.yStep ?? LATS_Y_STEP

  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []
  for (const n of nodes) {
    if (n.parent_id && byId.has(n.parent_id)) {
      if (!childrenOf.has(n.parent_id)) childrenOf.set(n.parent_id, [])
      childrenOf.get(n.parent_id)!.push(n.id)
    } else {
      roots.push(n.id)          // parentless (the synthetic root) or dangling
    }
  }

  const pos = new Map<string, LatsLayoutPos>()
  let nextLeafRow = 0
  const seen = new Set<string>()

  function place(id: string, depth: number): number {
    // Guard against a malformed cycle: never revisit a node.
    if (seen.has(id)) return pos.get(id)?.y ?? 0
    seen.add(id)
    const kids = childrenOf.get(id) ?? []
    const x = depth * xStep
    let y: number
    if (kids.length === 0) {
      y = nextLeafRow * yStep
      nextLeafRow += 1
    } else {
      const childY = kids.map(k => place(k, depth + 1))
      y = (childY[0] + childY[childY.length - 1]) / 2
    }
    pos.set(id, { id, x, y })
    return y
  }

  for (const r of roots) place(r, 0)

  // Preserve input order in the output for stable rendering.
  return nodes.filter(n => pos.has(n.id)).map(n => pos.get(n.id)!)
}
