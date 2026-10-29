/**
 * LATS tree overlay (§17.2/§17.3). A large Modal wrapping the React Flow canvas,
 * the node inspector (Layer 3), and the replay scrubber (Layer 3). Opened from
 * the LatsSearchCard's "Expand tree" button.
 */

'use client'

import { useState, useMemo } from 'react'
import { Modal } from '@/components/ui'
import { LatsTreeCanvas } from './LatsTreeCanvas'
import { LatsNodeInspector } from './LatsNodeInspector'
import { LatsReplayScrubber } from './LatsReplayScrubber'
import styles from './LatsTree.module.css'
import type { LatsSearchItem } from './AgentTimeline'

interface LatsTreePanelProps {
  item: LatsSearchItem
  isOpen: boolean
  onClose: () => void
}

export function LatsTreePanel({ item, isOpen, onClose }: LatsTreePanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Scrubber index into history; default to the latest snapshot.
  const [snapIndex, setSnapIndex] = useState<number | null>(null)

  const history = item.history.length > 0 ? item.history : [item.latest]
  const effectiveIndex = snapIndex == null ? history.length - 1 : Math.min(snapIndex, history.length - 1)
  const snapshot = history[effectiveIndex] ?? item.latest

  const selectedNode = useMemo(
    () => snapshot.nodes.find(n => n.id === selectedId) ?? null,
    [snapshot, selectedId],
  )

  const title = `Exploit-Path Search · ${item.phase}${item.shadow_mode ? ' · observe-only' : ''}`

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="large" className={styles.treeModal}>
      <div className={styles.panel}>
        <div className={styles.panelCanvas}>
          <LatsTreeCanvas
            snapshot={snapshot}
            selectedId={selectedId}
            onSelectNode={(id) => setSelectedId(id || null)}
          />
        </div>
        {selectedNode && (
          <LatsNodeInspector
            node={selectedNode}
            snapshot={snapshot}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
      {history.length > 1 && (
        <LatsReplayScrubber
          count={history.length}
          index={effectiveIndex}
          onChange={setSnapIndex}
        />
      )}
    </Modal>
  )
}
