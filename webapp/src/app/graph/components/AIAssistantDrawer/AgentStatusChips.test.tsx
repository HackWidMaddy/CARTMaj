/**
 * Component tests for AgentStatusChips — the live Todos-bar KPI chips.
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/AgentStatusChips.test.tsx
 *
 * Covers: score+tier render & color class, stall value + warn threshold, LATS
 * active rollouts vs idle, and graceful placeholders for missing values.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentStatusChips } from './AgentStatusChips'

afterEach(cleanup)

describe('AgentStatusChips', () => {
  test('renders score, stall, and active LATS rollouts', () => {
    render(
      <AgentStatusChips
        score={4.2}
        tier="orange"
        stall={2}
        latsActive={true}
        latsRollouts={6}
        latsBudget={24}
      />,
    )
    expect(screen.getByText('4.2')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('6/24')).toBeInTheDocument()
  })

  test('applies the tier color class to the productivity chip', () => {
    render(<AgentStatusChips score={9.5} tier="critical" stall={0} latsActive={false} />)
    const chip = screen.getByText('9.5').parentElement
    expect(chip?.className).toMatch(/tier_critical/)
  })

  test('flags a stall at/above the warn threshold', () => {
    render(<AgentStatusChips score={1} tier="green" stall={5} latsActive={false} />)
    const chip = screen.getByText('5').parentElement
    expect(chip?.className).toMatch(/stallWarn/)
  })

  test('does NOT flag a stall below the threshold', () => {
    render(<AgentStatusChips score={1} tier="green" stall={4} latsActive={false} />)
    const chip = screen.getByText('4').parentElement
    expect(chip?.className).not.toMatch(/stallWarn/)
  })

  test('shows idle when no LATS search is running', () => {
    render(<AgentStatusChips score={1} tier="green" stall={0} latsActive={false} />)
    expect(screen.getByText('idle')).toBeInTheDocument()
  })

  test('renders placeholders when score/stall are missing', () => {
    render(<AgentStatusChips score={null} tier={null} stall={null} latsActive={false} />)
    // score and stall both show the hyphen placeholder
    expect(screen.getAllByText('-').length).toBe(2)
  })
})
