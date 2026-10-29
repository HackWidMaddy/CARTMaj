import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { normalizeOrchestratorStartError } from './orchestratorError'

/**
 * Regression test reproducing the ACTUAL crash and proving the fix.
 *
 * The browser console showed:
 *   "Objects are not valid as a React child (found: object with keys
 *    {admitted, limitType, resource, current, ceiling, settingName, detail})"
 * after starting a partial scan. That object is the governor's rejection detail,
 * which the pre-fix routes forwarded as `error` and a toast then rendered.
 */
describe('governor rejection render safety', () => {
  afterEach(() => cleanup())

  const GOVERNOR_PAYLOAD = {
    admitted: false,
    limitType: 'ram',
    resource: 'scan',
    current: 1,
    ceiling: 2,
    settingName: null,
    detail: 'not enough reserved memory budget for another scan',
  }

  it('PRE-FIX behavior: rendering the raw governor object as a child throws', () => {
    // This is exactly what `toast.error(data.error)` did when `error` was the
    // object. React refuses to render an object child. Silence the expected
    // React error log for this negative case.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        // @ts-expect-error intentionally rendering an object child (the bug)
        render(<div>{GOVERNOR_PAYLOAD}</div>),
      ).toThrow(/Objects are not valid as a React child/)
    } finally {
      spy.mockRestore()
    }
  })

  it('POST-FIX behavior: the normalized error is a string and renders cleanly', () => {
    const { error } = normalizeOrchestratorStartError({ detail: GOVERNOR_PAYLOAD }, 'Failed to start partial recon')
    expect(typeof error).toBe('string')
    let container: HTMLElement | null = null
    expect(() => {
      container = render(<div>{error}</div>).container
    }).not.toThrow()
    expect(container!.textContent).toContain('RAM limit')
  })
})
