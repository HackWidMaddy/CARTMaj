/**
 * Derives the live Todos-bar KPIs from the chat timeline.
 *
 * Pure + framework-free so it can be unit-tested without rendering: a single
 * reverse scan takes the latest thinking item's productivity score/tier/stall
 * and the latest RUNNING LATS search's rollouts/budget.
 */

import type { ChatItem } from './types'
import type { ThinkingItem, LatsSearchItem } from './AgentTimeline'

export interface AgentStatus {
  score?: number | null
  tier?: string | null
  stall?: number | null
  latsActive: boolean
  latsRollouts?: number
  latsBudget?: number
}

export function deriveAgentStatus(items: ChatItem[]): AgentStatus {
  let score: number | null | undefined
  let tier: string | null | undefined
  let stall: number | null | undefined
  let seenThinking = false
  let latsActive = false
  let latsRollouts: number | undefined
  let latsBudget: number | undefined

  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (!seenThinking && it.type === 'thinking') {
      const t = it as ThinkingItem
      score = t.productivity_score
      tier = t.productivity_tier
      stall = t.stall
      seenThinking = true
    }
    if (!latsActive && it.type === 'lats_search' && (it as LatsSearchItem).status === 'running') {
      const l = it as LatsSearchItem
      latsActive = true
      latsRollouts = l.latest?.rollouts
      latsBudget = l.latest?.budget?.max_rollouts
    }
    if (seenThinking && latsActive) break
  }

  return { score, tier, stall, latsActive, latsRollouts, latsBudget }
}

/** Whether there is anything worth showing on the bar. */
export function hasAgentStatus(s: AgentStatus): boolean {
  return s.score != null || s.stall != null || s.latsActive
}
