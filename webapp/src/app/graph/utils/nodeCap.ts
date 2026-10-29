/**
 * Hard render cap for the /graph view.
 *
 * Above this node count we skip the client-side clustering pipeline and the
 * force-graph canvas entirely, and show a static message instead. The clustering
 * pass (utils/clusterNodes.ts) is a multi-pass, main-thread computation that
 * freezes the tab on very large graphs, so the gate must fire BEFORE it runs.
 *
 * The count checked is the number of nodes clustering would actually process
 * (the active saved-filter view, or the type/session-filtered set), not the raw
 * unfiltered graph, so a large project narrowed by a filter still renders.
 */
export const MAX_RENDER_NODES = 100000

export function isOverNodeCap(nodeCount: number): boolean {
  return nodeCount > MAX_RENDER_NODES
}
