/**
 * useNodeFilters across a project switch.
 *
 * The page keeps the Mute Rules view mounted when the project changes, so a
 * slow answer for the previous project can arrive after the new one's. Landing
 * it would show project A's rules under project B, and Save would then write
 * A's rules into B.
 *
 * Run: npx vitest run src/app/graph/components/NodeFilters/useNodeFilters.test.ts
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useNodeFilters } from './useNodeFilters'
import { muteRulesFingerprint } from '@/lib/nodeFilters/presets'
import type { NodeFilterDoc } from '@/lib/nodeFilters/model'

const doc = (name: string): NodeFilterDoc => ({ version: 1, kinds: { 'vuln.nuclei': { enabled: true, action: 'mute', rules: [
  { id: 'k3f9a2', name, enabled: true, all: [{ field: 'severity', op: 'in', value: ['info'] }] },
] } } })
const state = (revision: number, name: string) => ({
  mode: 'denylist', applyToScans: false, rules: doc(name), revision, exists: true,
  loadedPreset: null,
  exemptionCounts: {}, activeVersion: null, lastRun: null, lastCompleted: null, liveRunId: null,
})
const reply = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useNodeFilters', () => {
  test('late_load_crosses_projects: a slow answer for the previous project never lands under the new one', async () => {
    let releaseA: () => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/projects/pA/')) {
        return new Promise(resolve => { releaseA = () => resolve(reply(state(11, 'Rules of A'))) })
      }
      return Promise.resolve(reply(state(22, 'Rules of B')))
    }))

    const { result, rerender } = renderHook(({ pid }) => useNodeFilters(pid), { initialProps: { pid: 'pA' } })
    rerender({ pid: 'pB' })
    await waitFor(() => expect(result.current.saved?.revision).toBe(22))

    await act(async () => { releaseA() })
    expect(result.current.saved?.revision).toBe(22)
    expect(result.current.draft.kinds['vuln.nuclei'].rules[0].name).toBe('Rules of B')
    expect(result.current.dirty).toBe(false)
  })
})

describe('useNodeFilters presets', () => {
  /** A server that remembers the last PUT, so a reload reads back what was saved. */
  function server(initial: ReturnType<typeof state>) {
    let current: Record<string, unknown> = { ...initial }
    const puts: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        puts.push(body)
        const revision = (current.revision as number) + 1
        current = { ...current, mode: body.mode, rules: body.rules, revision,
                    ...('loadedPreset' in body ? { loadedPreset: body.loadedPreset } : {}) }
        return Promise.resolve(reply({ ok: true, revision }))
      }
      return Promise.resolve(reply(current))
    }))
    return puts
  }

  test('preset_saved_with_stale_draft: applyPreset saves the PRESET, not the draft from before the load', async () => {
    const puts = server(state(4, 'What was on screen'))
    const { result } = renderHook(() => useNodeFilters('p1'))
    await waitFor(() => expect(result.current.saved?.revision).toBe(4))

    const preset = { name: 'Quiet perimeter', mode: 'allowlist' as const, rules: doc('From the preset') }
    await act(async () => { await result.current.applyPreset(preset) })

    expect(puts).toHaveLength(1)
    expect(puts[0].mode).toBe('allowlist')
    expect((puts[0].rules as NodeFilterDoc).kinds['vuln.nuclei'].rules[0].name).toBe('From the preset')
    expect(puts[0].loadedPreset).toEqual({
      name: 'Quiet perimeter', fingerprint: muteRulesFingerprint('allowlist', doc('From the preset')),
    })
    expect(puts[0].revision).toBe(4)
  })

  test('the badge shows after a load, hides on any edit, and comes back on Discard', async () => {
    server(state(4, 'Before'))
    const { result } = renderHook(() => useNodeFilters('p1'))
    await waitFor(() => expect(result.current.saved?.revision).toBe(4))
    expect(result.current.appliedPreset).toBeNull()

    await act(async () => {
      await result.current.applyPreset({ name: 'Quiet perimeter', mode: 'denylist', rules: doc('Preset rules') })
    })
    await waitFor(() => expect(result.current.appliedPreset).toBe('Quiet perimeter'))
    expect(result.current.dirty).toBe(false)

    act(() => { result.current.setDraft(doc('Edited by hand')) })
    expect(result.current.appliedPreset).toBeNull()
    expect(result.current.dirty).toBe(true)

    act(() => { result.current.discard() })
    expect(result.current.appliedPreset).toBe('Quiet perimeter')

    act(() => { result.current.setDraftMode('allowlist') })
    expect(result.current.appliedPreset).toBeNull()
  })

  test('an ordinary save does not send a preset record', async () => {
    const puts = server(state(4, 'Before'))
    const { result } = renderHook(() => useNodeFilters('p1'))
    await waitFor(() => expect(result.current.saved?.revision).toBe(4))
    act(() => { result.current.setDraft(doc('Edited')) })
    await act(async () => { await result.current.save() })
    expect(puts[0]).not.toHaveProperty('loadedPreset')
  })
})
