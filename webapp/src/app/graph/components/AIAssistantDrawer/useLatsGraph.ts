/**
 * Build React Flow nodes/edges from a LATS tree snapshot (§17.2).
 *
 * Pure so it can be unit-tested and memoized. Node face detail lives in the
 * custom LatsNode; here we only assign positions (from latsTreeLayout) and edge
 * styling (thickness ~ visits, golden thread on the best trajectory).
 */

import type { Node, Edge } from '@xyflow/react'
import type { LatsTreeSnapshot, LatsNodeView } from '@/lib/websocket-types'
import { latsTreeLayout } from './latsTreeLayout'

export interface LatsNodeData {
  node: LatsNodeView
  isBest: boolean
  isSelected: boolean
  [key: string]: unknown
}

const GOLD = '#fbbf24'
const DEAD = '#7f1d1d'
const NEUTRAL = '#64748b'

export function buildLatsGraph(
  snapshot: LatsTreeSnapshot,
  selectedId?: string | null,
): { nodes: Node<LatsNodeData>[]; edges: Edge[] } {
  const positions = latsTreeLayout(snapshot.nodes)
  const posById = new Map(positions.map(p => [p.id, p]))
  const bestSet = new Set(snapshot.best_trajectory)

  const bestEdgeKeys = new Set<string>()
  for (let i = 0; i < snapshot.best_trajectory.length - 1; i++) {
    bestEdgeKeys.add(`${snapshot.best_trajectory[i]}->${snapshot.best_trajectory[i + 1]}`)
  }

  const nodes: Node<LatsNodeData>[] = snapshot.nodes
    .filter(n => posById.has(n.id))
    .map(n => ({
      id: n.id,
      type: 'latsNode',
      position: { x: posById.get(n.id)!.x, y: posById.get(n.id)!.y },
      data: {
        node: n,
        isBest: bestSet.has(n.id) && n.status !== 'pruned',
        isSelected: n.id === selectedId,
      },
    }))

  const edges: Edge[] = snapshot.nodes
    .filter(n => n.parent_id && posById.has(n.parent_id))
    .map(n => {
      const key = `${n.parent_id}->${n.id}`
      const onBest = bestEdgeKeys.has(key)
      const pruned = n.status === 'pruned'
      return {
        id: key,
        source: n.parent_id as string,
        target: n.id,
        animated: n.status === 'executing',
        style: {
          strokeWidth: onBest ? 3 : Math.min(1 + n.visits * 0.6, 4),
          stroke: onBest ? GOLD : pruned ? DEAD : NEUTRAL,
          opacity: pruned ? 0.4 : 1,
        },
      }
    })

  return { nodes, edges }
}

/** Red -> green heat by value in [0,1]. */
export function latsValueColor(value: number): string {
  const v = Math.max(0, Math.min(1, value))
  return `hsl(${Math.round(120 * v)}, 68%, 45%)`
}
