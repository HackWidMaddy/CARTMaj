/**
 * Component tests for the LATS replay scrubber (Layer 3).
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/LatsReplayScrubber.test.tsx
 */

import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { LatsReplayScrubber } from './LatsReplayScrubber'

afterEach(cleanup)

describe('LatsReplayScrubber', () => {
  test('shows the current position and total', () => {
    render(<LatsReplayScrubber count={5} index={2} onChange={() => {}} />)
    expect(screen.getByText('3/5')).toBeInTheDocument()
  })

  test('marks the latest snapshot as live', () => {
    render(<LatsReplayScrubber count={5} index={4} onChange={() => {}} />)
    expect(screen.getByText('5/5 (live)')).toBeInTheDocument()
  })

  test('slider change reports the new index', () => {
    const onChange = vi.fn()
    render(<LatsReplayScrubber count={5} index={4} onChange={onChange} />)
    const slider = screen.getByLabelText('Replay search rollouts') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '1' } })
    expect(onChange).toHaveBeenCalledWith(1)
  })

  test('slider is bounded to the history length', () => {
    render(<LatsReplayScrubber count={3} index={0} onChange={() => {}} />)
    const slider = screen.getByLabelText('Replay search rollouts') as HTMLInputElement
    expect(slider.max).toBe('2')
    expect(slider.min).toBe('0')
  })
})
