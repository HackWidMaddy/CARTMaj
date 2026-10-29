import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import GlobalError from './global-error'

/**
 * Fix 4: the root error boundary. Without global-error.tsx, an error thrown
 * above the per-segment error.tsx (e.g. in the root layout / during hydration)
 * falls through to Next.js's bare "Application error: a client-side exception"
 * white screen -- exactly what a starved orchestrator triggered. This boundary
 * turns that into a recoverable, friendly message.
 */
describe('GlobalError (root error boundary)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders a friendly message and a retry button instead of a white screen', () => {
    render(<GlobalError error={new Error('boom')} reset={vi.fn()} />)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('does not leak the raw error message into the UI', () => {
    // The message is generic on purpose; the raw error goes to the console only.
    render(<GlobalError error={new Error('TypeError: cannot read x of undefined')} reset={vi.fn()} />)
    expect(screen.queryByText(/cannot read x of undefined/)).not.toBeInTheDocument()
  })

  it('calls reset() when the retry button is clicked', () => {
    const reset = vi.fn()
    render(<GlobalError error={new Error('boom')} reset={reset} />)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('hard-reloads on a stale-chunk error (post-redeploy recovery)', () => {
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    })
    try {
      const err = Object.assign(new Error('Loading chunk 42 failed'), { name: 'ChunkLoadError' })
      render(<GlobalError error={err} reset={vi.fn()} />)
      expect(reload).toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })
})
