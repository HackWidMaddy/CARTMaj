/**
 * Pure state reducers for LATS (exploit-path tree search) events.
 *
 * A single card mutates in place, keyed by search_id: LATS_START seeds it,
 * each LATS_TREE_UPDATE replaces the latest snapshot and pushes history (for
 * the replay scrubber), LATS_COMPLETE marks it done. Handlers never throw;
 * an orphaned update (search never started) is tolerated by seeding a card
 * from the snapshot so the tree still renders.
 */

import type {
  LatsStartPayload,
  LatsTreeUpdatePayload,
  LatsCompletePayload,
  LatsTreeSnapshot,
} from '@/lib/websocket-types'
import type { ChatItem, LatsSearchItem } from '../types'

export function findLatsIndex(items: ChatItem[], search_id: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'lats_search' && it.search_id === search_id) return i
  }
  return -1
}

function withLats(
  items: ChatItem[],
  idx: number,
  updater: (it: LatsSearchItem) => LatsSearchItem,
): ChatItem[] {
  const next = updater(items[idx] as LatsSearchItem)
  return [...items.slice(0, idx), next, ...items.slice(idx + 1)]
}

function emptySnapshot(search_id: string, objective = '', phase = '', shadow_mode = false): LatsTreeSnapshot {
  return {
    search_id,
    objective,
    phase,
    shadow_mode,
    rollouts: 0,
    budget: { max_rollouts: 0, max_depth: 0 },
    active_id: null,
    best_trajectory: [],
    nodes: [],
  }
}

export function handleLatsStart(items: ChatItem[], p: LatsStartPayload): ChatItem[] {
  const existing = findLatsIndex(items, p.search_id)
  const snapshot = emptySnapshot(p.search_id, p.objective, p.phase, p.shadow_mode)
  snapshot.budget = p.budget
  const card: LatsSearchItem = {
    type: 'lats_search',
    id: p.search_id,
    search_id: p.search_id,
    timestamp: new Date(),
    objective: p.objective,
    phase: p.phase,
    shadow_mode: p.shadow_mode,
    status: 'running',
    latest: snapshot,
    history: [],
  }
  // A duplicate start (e.g. reconnect) refreshes the existing card in place
  // rather than stacking a second one.
  if (existing >= 0) return withLats(items, existing, () => card)
  return [...items, card]
}

export function handleLatsUpdate(items: ChatItem[], p: LatsTreeUpdatePayload): ChatItem[] {
  const idx = findLatsIndex(items, p.search_id)
  if (idx < 0) {
    // Orphan update (no prior start): seed a card straight from the snapshot so
    // the tree still renders instead of being dropped.
    const card: LatsSearchItem = {
      type: 'lats_search',
      id: p.search_id,
      search_id: p.search_id,
      timestamp: new Date(),
      objective: p.snapshot.objective,
      phase: p.snapshot.phase,
      shadow_mode: p.snapshot.shadow_mode,
      status: 'running',
      latest: p.snapshot,
      history: [p.snapshot],
    }
    return [...items, card]
  }
  return withLats(items, idx, it => ({
    ...it,
    latest: p.snapshot,
    history: [...it.history, p.snapshot],
    // Keep meta fresh in case the first start was missed.
    objective: p.snapshot.objective || it.objective,
    phase: p.snapshot.phase || it.phase,
    shadow_mode: p.snapshot.shadow_mode,
  }))
}

/**
 * Rebuild a single LatsSearchItem (including its per-wave history[]) by replaying
 * a persisted event sequence, for conversation restore (§18.2). Reuses the live
 * handlers so restore and live paths stay identical.
 */
export interface LatsRestoreEvent {
  _latsEvent: 'lats_start' | 'lats_tree_update' | 'lats_complete'
  payload: LatsStartPayload | LatsTreeUpdatePayload | LatsCompletePayload
}

export function buildLatsCardFromEvents(events: LatsRestoreEvent[]): LatsSearchItem | null {
  let items: ChatItem[] = []
  for (const e of events) {
    if (e._latsEvent === 'lats_start') {
      items = handleLatsStart(items, e.payload as LatsStartPayload)
    } else if (e._latsEvent === 'lats_tree_update') {
      items = handleLatsUpdate(items, e.payload as LatsTreeUpdatePayload)
    } else if (e._latsEvent === 'lats_complete') {
      items = handleLatsComplete(items, e.payload as LatsCompletePayload)
    }
  }
  return (items.find(i => i.type === 'lats_search') as LatsSearchItem | undefined) ?? null
}

/**
 * Restore post-pass (§18.2): fold inline LATS event markers into one card per
 * search_id, placed at the position of that search's FIRST event and stamped
 * with that event's persisted timestamp (so the timeline's sort-by-time keeps
 * it where it happened). Non-LATS items pass through untouched.
 *
 * A "marker" is `{ _latsEvent, payload, timestamp? }` produced by
 * useConversationRestoration from a persisted lats_* ChatMessage.
 */
export function foldLatsRestoreMarkers(items: ChatItem[]): ChatItem[] {
  const groups = new Map<string, { firstIndex: number; events: LatsRestoreEvent[] }>()
  const foldedIndices = new Set<number>()
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as unknown as { _latsEvent?: LatsRestoreEvent['_latsEvent']; payload?: { search_id?: string } }
    if (!it._latsEvent) continue
    foldedIndices.add(i)
    const sid = it.payload?.search_id
    if (!sid) continue
    if (!groups.has(sid)) groups.set(sid, { firstIndex: i, events: [] })
    groups.get(sid)!.events.push({ _latsEvent: it._latsEvent, payload: it.payload as LatsRestoreEvent['payload'] })
  }
  if (foldedIndices.size === 0) return items

  const cardAt = new Map<number, ChatItem>()
  for (const { firstIndex, events } of groups.values()) {
    const card = buildLatsCardFromEvents(events)
    if (card) {
      const ts = (items[firstIndex] as unknown as { timestamp?: Date }).timestamp
      cardAt.set(firstIndex, ts ? { ...card, timestamp: ts } : card)
    }
  }
  const out: ChatItem[] = []
  for (let i = 0; i < items.length; i++) {
    if (cardAt.has(i)) out.push(cardAt.get(i)!)
    else if (foldedIndices.has(i)) continue   // folded (non-first) lats event
    else out.push(items[i])
  }
  return out
}

export function handleLatsComplete(items: ChatItem[], p: LatsCompletePayload): ChatItem[] {
  const idx = findLatsIndex(items, p.search_id)
  if (idx < 0) {
    console.warn(`[lats] complete for unknown search=${p.search_id}`)
    return items
  }
  return withLats(items, idx, it => {
    // Pin the final best line onto the latest snapshot so the card shows it,
    // and onto the last replay frame so the expanded panel's latest frame draws
    // the same golden thread as the card (S3).
    const latest = { ...it.latest, best_trajectory: p.best_trajectory }
    const history = it.history.length > 0
      ? [...it.history.slice(0, -1),
         { ...it.history[it.history.length - 1], best_trajectory: p.best_trajectory }]
      : it.history
    return { ...it, status: 'complete', outcome: p.outcome, latest, history }
  })
}
