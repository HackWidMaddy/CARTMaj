/**
 * Scan Timeline — version switch (Section 4.2).
 *
 * The switch must make the distinction impossible to miss: exactly one version is
 * "Active" (the live graph the agent and analytics use), and selecting any other
 * one is a read-only view.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { VersionSwitch } from './VersionSwitch'
import type { ScanVersionSummary } from '../../hooks/useScanVersions'

const v = (over: Partial<ScanVersionSummary>): ScanVersionSummary => ({
  id: 'v1', seq: 1, label: 'Scan 1', isCurrent: false, pinned: false,
  nodeCount: 10, linkCount: 5, createdAt: '2026-07-01T10:00:00.000Z',
  snapshotBytes: 2048, activatable: true, ...over,
})

const versions = [
  v({ id: 'v3', seq: 3, label: 'Scan 3', isCurrent: true, snapshotBytes: 0, activatable: false }),
  v({ id: 'v2', seq: 2, label: 'Scan 2' }),
  v({ id: 'v1', seq: 1, label: 'Scan 1', snapshotBytes: 0, activatable: false }),
]

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('VersionSwitch', () => {
  test('renders nothing when the project has no versions yet', () => {
    const { container } = render(
      <VersionSwitch versions={[]} selectedVersionId={null} onSelect={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  test('with no selection it shows the active version and no read-only badge', () => {
    render(<VersionSwitch versions={versions} selectedVersionId={null} onSelect={vi.fn()} />)
    expect(screen.getByText('Scan 3')).toBeTruthy()
    expect(screen.queryByText('read-only')).toBeNull()
  })

  test('selecting a past version reports its id; selecting the current one reports null', () => {
    const onSelect = vi.fn()
    render(<VersionSwitch versions={versions} selectedVersionId={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /Scan 3/ }))
    fireEvent.click(screen.getByRole('option', { name: /Scan 2/ }))
    expect(onSelect).toHaveBeenCalledWith('v2')

    onSelect.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /Scan 3/ }))
    fireEvent.click(screen.getByRole('option', { name: /Scan 3/ }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  test('viewing a past version is marked read-only in the trigger', () => {
    render(<VersionSwitch versions={versions} selectedVersionId="v2" onSelect={vi.fn()} />)
    expect(screen.getByText('read-only')).toBeTruthy()
    expect(screen.getByText('Scan 2')).toBeTruthy()
  })

  test('exactly one option is badged Active, and bytes-less versions say so', () => {
    render(<VersionSwitch versions={versions} selectedVersionId={null} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Scan 3/ }))
    expect(screen.getAllByText('Active')).toHaveLength(1)
    // v1 has no stored bytes -> flagged, because it cannot be activated (4A.6).
    expect(screen.getByText(/no snapshot/)).toBeTruthy()
  })

  test('an in-flight activation is surfaced in the trigger', () => {
    render(<VersionSwitch versions={versions} selectedVersionId={null} onSelect={vi.fn()} activating />)
    expect(screen.getByText('Activating…')).toBeTruthy()
  })

  test('Escape closes the dropdown and returns focus to the trigger', () => {
    render(<VersionSwitch versions={versions} selectedVersionId={null} onSelect={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /Scan 3/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('the trigger exposes its state to assistive tech', () => {
    render(<VersionSwitch versions={versions} selectedVersionId={null} onSelect={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /Scan 3/ })
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-label')).toMatch(/scan version/i)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  test('every option reports whether it is the selected one', () => {
    render(<VersionSwitch versions={versions} selectedVersionId="v2" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Scan 2/ }))
    const options = screen.getAllByRole('option')
    expect(options.map(o => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  })

  test('the manage entry is only rendered when a handler is provided', () => {
    const onManage = vi.fn()
    render(<VersionSwitch versions={versions} selectedVersionId={null} onSelect={vi.fn()} onManage={onManage} />)
    fireEvent.click(screen.getByRole('button', { name: /Scan 3/ }))
    fireEvent.click(screen.getByText('Manage versions…'))
    expect(onManage).toHaveBeenCalled()
  })
})
