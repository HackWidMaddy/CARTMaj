/**
 * Unit tests for deriveAgentStatus / hasAgentStatus (the Todos-bar KPI logic).
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/agentStatus.test.ts
 */

import { describe, test, expect } from 'vitest'
import { deriveAgentStatus, hasAgentStatus } from './agentStatus'
import type { ChatItem } from './types'

function thinking(over: Record<string, unknown>): ChatItem {
  return { type: 'thinking', ...over } as unknown as ChatItem
}
function lats(status: 'running' | 'complete', rollouts?: number, budget?: number): ChatItem {
  return {
    type: 'lats_search',
    status,
    latest: { rollouts, budget: { max_rollouts: budget } },
  } as unknown as ChatItem
}

describe('deriveAgentStatus', () => {
  test('empty timeline -> no status', () => {
    const s = deriveAgentStatus([])
    expect(s.latsActive).toBe(false)
    expect(hasAgentStatus(s)).toBe(false)
  })

  test('takes the LATEST thinking item score/tier/stall', () => {
    const items = [
      thinking({ productivity_score: 2.1, productivity_tier: 'yellow', stall: 1 }),
      thinking({ productivity_score: 7.3, productivity_tier: 'red', stall: 4 }),
    ]
    const s = deriveAgentStatus(items)
    expect(s.score).toBe(7.3)
    expect(s.tier).toBe('red')
    expect(s.stall).toBe(4)
    expect(hasAgentStatus(s)).toBe(true)
  })

  test('running LATS -> active with rollouts/budget', () => {
    const s = deriveAgentStatus([lats('running', 6, 24)])
    expect(s.latsActive).toBe(true)
    expect(s.latsRollouts).toBe(6)
    expect(s.latsBudget).toBe(24)
  })

  test('completed LATS -> idle', () => {
    const s = deriveAgentStatus([lats('complete', 6, 24)])
    expect(s.latsActive).toBe(false)
  })

  test('combines latest thinking with running LATS', () => {
    const items = [
      thinking({ productivity_score: 4.2, productivity_tier: 'orange', stall: 3 }),
      lats('running', 2, 24),
    ]
    const s = deriveAgentStatus(items)
    expect(s.score).toBe(4.2)
    expect(s.latsActive).toBe(true)
    expect(s.latsRollouts).toBe(2)
  })

  test('hasAgentStatus true when only stall is present', () => {
    const s = deriveAgentStatus([thinking({ productivity_score: null, stall: 0 })])
    expect(hasAgentStatus(s)).toBe(true)
  })

  test('hasAgentStatus false when thinking carries no KPIs', () => {
    const s = deriveAgentStatus([
      thinking({ productivity_score: null, productivity_tier: null, stall: null }),
    ])
    expect(hasAgentStatus(s)).toBe(false)
  })
})
