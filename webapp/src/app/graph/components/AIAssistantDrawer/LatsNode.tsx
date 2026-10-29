/**
 * Custom React Flow node for the LATS tree (§17.2). Renders a compact face;
 * heavy detail is reserved for the click inspector (Layer 3) so the graph stays
 * scannable. Both value (exploit term) and visits (explore term) are shown
 * because that is why the search moved where it did.
 */

'use client'

import { memo, useCallback } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Crown, AlertTriangle } from 'lucide-react'
import styles from './LatsTree.module.css'
import { latsValueColor, type LatsNodeData } from './useLatsGraph'

const STATUS_GLYPH: Record<string, string> = {
  proposed: '·', executing: '○', evaluated: '◉', pruned: '✗', terminal: '⚑',
}

function LatsNodeComponent({ data }: NodeProps) {
  const { node, isBest, isSelected } = data as unknown as LatsNodeData
  const onNodeClick = (data as unknown as { onNodeClick?: (id: string) => void }).onNodeClick

  const handleClick = useCallback(() => onNodeClick?.(node.id), [onNodeClick, node.id])

  const signal = node.error_class || node.verdict
  const cls = [
    styles.node,
    node.status === 'pruned' ? styles.nodePruned : '',
    node.status === 'terminal' ? styles.nodeTerminal : '',
    node.status === 'executing' ? styles.nodeExecuting : '',
    isBest ? styles.nodeBest : '',
    isSelected ? styles.nodeSelected : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} onClick={handleClick} title={node.observation || node.reflection || node.label}>
      <Handle type="target" position={Position.Left} className={styles.handle} />

      <div className={styles.nodeHead}>
        <span className={styles.nodeGlyph}>{STATUS_GLYPH[node.status] ?? '·'}</span>
        <span className={styles.nodeLabel}>{node.label || node.tool_name || node.id}</span>
        {node.is_dangerous && <AlertTriangle size={11} className={styles.nodeDanger} />}
        {node.exploit_succeeded && <Crown size={11} className={styles.nodeCrown} />}
      </div>

      <div className={styles.nodeMeter}>
        <div className={styles.nodeMeterFill}
             style={{ width: `${Math.round(Math.max(0, Math.min(1, node.value)) * 100)}%`,
                      background: latsValueColor(node.value) }} />
      </div>

      <div className={styles.nodeMetaRow}>
        <span className={styles.nodeValue}>{node.value.toFixed(2)}</span>
        <span className={styles.nodeVisits} title="visits (explore term)">×{node.visits}</span>
        {signal && <span className={styles.nodeSignal}>{signal}</span>}
      </div>

      {node.reflection && <div className={styles.nodeReflection}>{node.reflection}</div>}

      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  )
}

export const LatsNode = memo(LatsNodeComponent)
