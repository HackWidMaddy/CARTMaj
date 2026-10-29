/**
 * React Flow canvas for the LATS tree (Layer 2, §17.2). Left-to-right node-link
 * tree with a custom node face, pan/zoom, and click-to-inspect. Mirrors the
 * WorkflowView setup (including the Turbopack style-injection workaround).
 */

'use client'

import { useMemo, useCallback } from 'react'
import { ReactFlow, Controls, MiniMap, Background } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTheme } from '@/hooks/useTheme'
import { LatsNode } from './LatsNode'
import { buildLatsGraph } from './useLatsGraph'
import type { LatsTreeSnapshot } from '@/lib/websocket-types'

const nodeTypes = { latsNode: LatsNode }

interface LatsTreeCanvasProps {
  snapshot: LatsTreeSnapshot
  selectedId: string | null
  onSelectNode: (id: string) => void
}

export function LatsTreeCanvas({ snapshot, selectedId, onSelectNode }: LatsTreeCanvasProps) {
  const { resolvedTheme } = useTheme()

  const { nodes, edges } = useMemo(() => {
    const g = buildLatsGraph(snapshot, selectedId)
    // Inject the click handler into each node's data (WorkflowView pattern).
    const nodes = g.nodes.map(n => ({ ...n, data: { ...n.data, onNodeClick: onSelectNode } }))
    return { nodes, edges: g.edges }
  }, [snapshot, selectedId, onSelectNode])

  const handlePaneClick = useCallback(() => onSelectNode(''), [onSelectNode])

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 420 }} data-testid="lats-tree-canvas">
      {/* React Flow base CSS is not loaded by Turbopack from node_modules. */}
      <style dangerouslySetInnerHTML={{ __html: `
        .react-flow__edges svg { overflow: visible !important; position: absolute !important; pointer-events: none !important; width: 100% !important; height: 100% !important; top: 0 !important; left: 0 !important; }
        .react-flow__edges { position: absolute !important; width: 100% !important; height: 100% !important; top: 0 !important; left: 0 !important; }
        .react-flow__edge-path { fill: none; }
        .react-flow__nodes { z-index: 10 !important; }
        .react-flow__viewport { transform-origin: 0 0; }
      `}} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        colorMode={resolvedTheme === 'light' ? 'light' : 'dark'}
        onPaneClick={handlePaneClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable
          nodeColor={(n) => {
            const d = n.data as { node?: { status?: string } }
            const s = d.node?.status
            return s === 'pruned' ? '#7f1d1d' : s === 'terminal' ? '#a16207' : '#22c55e'
          }} />
      </ReactFlow>
    </div>
  )
}
