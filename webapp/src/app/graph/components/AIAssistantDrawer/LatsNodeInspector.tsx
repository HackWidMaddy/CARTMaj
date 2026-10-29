/**
 * LATS node inspector (Layer 3, §17.3). The trust-builder: shows the exact
 * probe, the score breakdown (why value is what it is), and the UCT breakdown
 * (why the search picked this node over its sibling) - computed client-side from
 * value/visits + the parent's visits, both already in the snapshot.
 */

'use client'

import { X } from 'lucide-react'
import styles from './LatsTree.module.css'
import type { LatsNodeView, LatsTreeSnapshot } from '@/lib/websocket-types'

interface LatsNodeInspectorProps {
  node: LatsNodeView
  snapshot: LatsTreeSnapshot
  onClose: () => void
}

const UCT_C = 1.4   // display constant; matches the LATS_UCT_C default

export function LatsNodeInspector({ node, snapshot, onClose }: LatsNodeInspectorProps) {
  const parent = node.parent_id ? snapshot.nodes.find(n => n.id === node.parent_id) : null
  const parentVisits = parent?.visits ?? 0

  // UCT = value (exploit) + c * sqrt(ln(parent.visits) / visits) (explore).
  const exploreTerm = node.visits > 0 && parentVisits > 0
    ? UCT_C * Math.sqrt(Math.log(Math.max(parentVisits, 1)) / node.visits)
    : Infinity

  const cmd = node.tool_name
    ? `${node.tool_name} ${JSON.stringify(node.tool_args ?? {}, null, 0)}`
    : '(root)'

  return (
    <div className={styles.inspector} data-testid="lats-node-inspector">
      <div className={styles.inspectorHeader}>
        <span className={styles.inspectorTitle}>{node.label || node.tool_name || node.id}</span>
        <button className={styles.inspectorClose} onClick={onClose} aria-label="Close inspector">
          <X size={14} />
        </button>
      </div>

      <div className={styles.inspectorSection}>
        <div className={styles.inspectorLabel}>Command</div>
        <div className={styles.inspectorCode}>{cmd}</div>
      </div>

      {node.observation && (
        <div className={styles.inspectorSection}>
          <div className={styles.inspectorLabel}>Observation</div>
          <div className={styles.inspectorCode}>{node.observation}</div>
        </div>
      )}

      {node.reflection && (
        <div className={styles.inspectorSection}>
          <div className={styles.inspectorLabel}>Reflection</div>
          <div className={styles.inspectorCode}>{node.reflection}</div>
        </div>
      )}

      <div className={styles.inspectorSection}>
        <div className={styles.inspectorLabel}>Score breakdown</div>
        <div className={styles.inspectorKV}><span>status</span><span>{node.status}</span></div>
        <div className={styles.inspectorKV}><span>value (subtree max)</span><span>{node.value.toFixed(3)}</span></div>
        <div className={styles.inspectorKV}><span>local value (own)</span><span>{node.local_value.toFixed(3)}</span></div>
        <div className={styles.inspectorKV}><span>verdict</span><span>{node.verdict || '-'}</span></div>
        <div className={styles.inspectorKV}><span>error class</span><span>{node.error_class || '-'}</span></div>
        <div className={styles.inspectorKV}><span>finding confidence</span><span>{node.finding_confidence || 0}</span></div>
        <div className={styles.inspectorKV}><span>exploit succeeded</span><span>{node.exploit_succeeded ? 'yes' : 'no'}</span></div>
      </div>

      <div className={styles.inspectorSection}>
        <div className={styles.inspectorLabel}>UCT breakdown</div>
        <div className={styles.inspectorKV}><span>exploit (value)</span><span>{node.value.toFixed(3)}</span></div>
        <div className={styles.inspectorKV}>
          <span>explore</span>
          <span>{exploreTerm === Infinity ? '∞ (unvisited)' : exploreTerm.toFixed(3)}</span>
        </div>
        <div className={styles.inspectorKV}><span>visits</span><span>{node.visits}</span></div>
        <div className={styles.inspectorKV}><span>parent visits</span><span>{parentVisits}</span></div>
        <div className={styles.inspectorKV}><span>depth</span><span>{node.depth}</span></div>
        <div className={styles.inspectorKV}><span>duration</span><span>{node.duration_ms} ms</span></div>
      </div>
    </div>
  )
}
