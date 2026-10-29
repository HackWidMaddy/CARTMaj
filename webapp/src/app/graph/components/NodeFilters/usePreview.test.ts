/**
 * The live preview's state while newer rules are being counted.
 *
 * Run: npx vitest run src/app/graph/components/NodeFilters/usePreview.test.ts
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePreview, PREVIEW_DEBOUNCE_MS } from './usePreview'
import type { NodeFilterDoc } from '@/lib/nodeFilters/model'

const doc = (sev: string): NodeFilterDoc => ({ version: 1, kinds: { 'vuln.nuclei': { enabled: true, action: 'mute', rules: [
  { id: 'k3f9a2', name: 'Rule', enabled: true, all: [{ field: 'severity', op: 'in', value: [sev] }] },
] } } })
const result = (would: number) => ({ ok: true, partial: false, totals: {}, kinds: { 'vuln.nuclei': { would_mute: would } } })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('usePreview', () => {
  test('stale_preview_shown_as_current: counts for the previous rules are marked updating until the new ones arrive', async () => {
    // The state stayed "ready" through the debounce and the request, so the
    // panel showed the previous rules' counts as if they were current.
    let release: (v: unknown) => void = () => {}
    const bodies = [result(2), result(6)]
    vi.stubGlobal('fetch', vi.fn(() => {
      const body = bodies.shift()
      return body === undefined ? new Promise(() => {}) : body.kinds['vuln.nuclei'].would_mute === 6
        ? new Promise(r => { release = () => r({ status: 200, json: () => Promise.resolve(body) }) })
        : Promise.resolve({ status: 200, json: () => Promise.resolve(body) })
    }))

    const { result: hook, rerender } = renderHook(({ rules }) => usePreview('p1', 'denylist', rules), { initialProps: { rules: doc('info') } })
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10) })
    expect(hook.current.state).toBe('ready')
    expect(hook.current.result?.kinds['vuln.nuclei'].would_mute).toBe(2)

    rerender({ rules: doc('high') })
    await act(async () => { await Promise.resolve() })
    expect(hook.current.state).toBe('updating')

    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10) })
    expect(hook.current.state).toBe('updating')
    await act(async () => { release(null); await vi.advanceTimersByTimeAsync(0) })
    expect(hook.current.state).toBe('ready')
    expect(hook.current.result?.kinds['vuln.nuclei'].would_mute).toBe(6)
  })
})
