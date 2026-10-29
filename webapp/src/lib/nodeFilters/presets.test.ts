/**
 * The Mute Rules preset badge: when it shows, and what a preset may be saved as.
 *
 * Run: npx vitest run src/lib/nodeFilters/presets.test.ts
 */
import { describe, test, expect } from 'vitest'
import {
  appliedPresetName, muteRulesFingerprint, parseLoadedPresetInput, parsePresetText, presetSummary,
  readLoadedPreset, PRESET_LIMITS,
} from './presets'
import type { NodeFilterDoc } from './model'

const RULE = { id: 'k3f9a2', name: 'Informational templates', enabled: true,
               all: [{ field: 'severity', op: 'in', value: ['info'] }] }
const DOC: NodeFilterDoc = { version: 1, kinds: { 'vuln.nuclei': { enabled: true, action: 'mute', rules: [RULE] } } }
const loadedFrom = (doc: NodeFilterDoc, mode: 'denylist' | 'allowlist' = 'denylist') =>
  ({ name: 'Quiet perimeter', fingerprint: muteRulesFingerprint(mode, doc) })

describe('appliedPresetName', () => {
  test('names the preset while the rules are exactly what it loaded', () => {
    expect(appliedPresetName(loadedFrom(DOC), 'denylist', DOC)).toBe('Quiet perimeter')
  })

  test('badge_survives_key_order: jsonb reorders keys, so the copy read back must still match', () => {
    const reordered = JSON.parse(JSON.stringify({ kinds: { 'vuln.nuclei': {
      rules: [{ all: [{ value: ['info'], op: 'in', field: 'severity' }], enabled: true, name: RULE.name, id: RULE.id }],
      action: 'mute', enabled: true,
    } }, version: 1 }))
    expect(appliedPresetName(loadedFrom(DOC), 'denylist', reordered)).toBe('Quiet perimeter')
  })

  test('any edit to a rule hides the badge', () => {
    const edited = structuredClone(DOC)
    edited.kinds['vuln.nuclei'].rules[0].all[0].value = ['info', 'low']
    expect(appliedPresetName(loadedFrom(DOC), 'denylist', edited)).toBeNull()
  })

  test('switching the mode alone hides the badge: the same rules mean the opposite', () => {
    expect(appliedPresetName(loadedFrom(DOC), 'allowlist', DOC)).toBeNull()
  })

  test('turning a kind off hides the badge', () => {
    const off = structuredClone(DOC)
    off.kinds['vuln.nuclei'].enabled = false
    expect(appliedPresetName(loadedFrom(DOC), 'denylist', off)).toBeNull()
  })

  test('badge_returns_after_manual_revert: a key an edit left undefined does not count', () => {
    const reverted = structuredClone(DOC) as NodeFilterDoc & { kinds: Record<string, { rules: Array<Record<string, unknown>> }> }
    reverted.kinds['vuln.nuclei'].rules[0].match_all = undefined
    expect(appliedPresetName(loadedFrom(DOC), 'denylist', reverted)).toBe('Quiet perimeter')
  })

  test('no badge without a well-formed record', () => {
    for (const loaded of [null, undefined, {}, { name: 'x' }, { name: '', fingerprint: 'ab' }, 'x', []]) {
      expect(appliedPresetName(loaded, 'denylist', DOC)).toBeNull()
    }
  })
})

describe('readLoadedPreset / parseLoadedPresetInput', () => {
  test('reads back what a save stored', () => {
    expect(readLoadedPreset({ name: 'A', fingerprint: 'f00' })).toEqual({ name: 'A', fingerprint: 'f00' })
  })

  test('null clears the record', () => {
    expect(parseLoadedPresetInput(null)).toEqual({ ok: true, value: null })
  })

  test('malformed or oversized records are refused, not stored', () => {
    for (const bad of [{}, 'x', 42, { name: 'A' }, { name: 'A', fingerprint: 'f'.repeat(33) },
                       { name: 'x'.repeat(PRESET_LIMITS.name + 1), fingerprint: 'f00' }]) {
      expect(parseLoadedPresetInput(bad).ok).toBe(false)
    }
  })

  test('only name and fingerprint are kept', () => {
    const got = parseLoadedPresetInput({ name: 'A', fingerprint: 'f00', rules: { huge: true } })
    expect(got).toEqual({ ok: true, value: { name: 'A', fingerprint: 'f00' } })
  })
})

describe('parsePresetText', () => {
  test('trims the name and description', () => {
    expect(parsePresetText('  Quiet  ', '  why ')).toEqual({ ok: true, name: 'Quiet', description: 'why' })
  })

  test('a missing description is an empty one', () => {
    expect(parsePresetText('Quiet', undefined)).toEqual({ ok: true, name: 'Quiet', description: '' })
  })

  test('refuses a blank, oversized or non-string name, and an oversized description', () => {
    expect(parsePresetText('   ', '').ok).toBe(false)
    expect(parsePresetText(42, '').ok).toBe(false)
    expect(parsePresetText('x'.repeat(PRESET_LIMITS.name + 1), '').ok).toBe(false)
    expect(parsePresetText('ok', 'x'.repeat(PRESET_LIMITS.description + 1)).ok).toBe(false)
    expect(parsePresetText('ok', { not: 'text' }).ok).toBe(false)
  })
})

describe('presetSummary', () => {
  test('counts the active rules and never returns the rules themselves', () => {
    const row = { id: 'p1', name: 'Quiet', description: '', mode: 'denylist', rules: DOC,
                  createdAt: new Date(), updatedAt: new Date() }
    const summary = presetSummary(row)
    expect(summary.counts).toEqual({ rules: 1, kinds: 1 })
    expect(summary).not.toHaveProperty('rules')
  })

  test('an unknown stored mode reads as denylist', () => {
    const row = { id: 'p1', name: 'Q', description: '', mode: 'weird', rules: DOC, createdAt: new Date(), updatedAt: new Date() }
    expect(presetSummary(row).mode).toBe('denylist')
  })
})
