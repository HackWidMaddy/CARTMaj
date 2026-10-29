/**
 * The Mute Rules tab (with its armed pill) and Muted Nodes in the table menu.
 *
 * Run: npx vitest run src/app/graph/components/ViewTabs/ViewTabs.nodeFilters.test.tsx
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../GraphCanvas', () => ({ AUTO_2D_THRESHOLD: 5000 }))
vi.mock('@/components/ui', () => ({ Toggle: () => null }))

import { ViewTabs, dropdownMode, parseTableViewMode, type NodeFilterStatus } from './ViewTabs'

const ARMED: NodeFilterStatus = { armed: true, mode: 'denylist', activeRules: 19, activeKinds: 7, runningApply: false }

afterEach(() => cleanup())

function tabs(props: Partial<Parameters<typeof ViewTabs>[0]> = {}) {
  const onViewChange = vi.fn()
  const onTableViewModeChange = vi.fn()
  render(<ViewTabs activeView="table" onViewChange={onViewChange} onTableViewModeChange={onTableViewModeChange} {...props} />)
  return { onViewChange, onTableViewModeChange }
}

describe('the Mute Rules tab', () => {
  test('opens the mute rules table view', () => {
    const { onViewChange, onTableViewModeChange } = tabs()
    fireEvent.click(screen.getByText('Mute Rules'))
    expect(onTableViewModeChange).toHaveBeenCalledWith('nodeFilters')
    expect(onViewChange).toHaveBeenCalledWith('table')
  })

  test('carries the armed pill with the rule count and a tooltip', () => {
    tabs({ nodeFilterStatus: ARMED })
    const pill = screen.getByText('19')
    expect(pill.getAttribute('title')).toBe('19 rules in 7 kinds will be applied to the next recon scan (denylist)')
  })

  test('no pill when the rules are not armed, or the status is unknown', () => {
    tabs({ nodeFilterStatus: { ...ARMED, armed: false } })
    expect(screen.queryByText('19')).toBeNull()
    cleanup()
    tabs({ nodeFilterStatus: null })
    expect(screen.queryByTitle(/will be applied/)).toBeNull()
  })

  test('only its own tab is selected, not the table dropdown as well', () => {
    tabs({ tableViewMode: 'nodeFilters' })
    const selected = screen.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toContain('Mute Rules')
    expect(dropdownMode('nodeFilters')).toBe('all')
  })
})

describe('Muted Nodes in the table menu', () => {
  test('is listed and selectable, and the dropdown then names it', () => {
    const { onTableViewModeChange } = tabs()
    fireEvent.click(document.querySelector('[class*="tabDropdownIcon"]')!)
    fireEvent.click(screen.getByText('Muted Nodes'))
    expect(onTableViewModeChange).toHaveBeenCalledWith('muted')
    cleanup()
    tabs({ tableViewMode: 'muted' })
    expect(screen.getByText('Muted Nodes')).toBeInTheDocument()
    expect(dropdownMode('muted')).toBe('muted')
  })

  test('both are deep-linkable', () => {
    expect(parseTableViewMode('muted')).toBe('muted')
    expect(parseTableViewMode('nodeFilters')).toBe('nodeFilters')
  })
})
