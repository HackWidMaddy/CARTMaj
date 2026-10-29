/**
 * Mute Rules presets: a named mode + rules document a user saves once and can
 * load into any of their projects.
 *
 * A project records `{ name, fingerprint }` of the preset last loaded (the
 * `loaded_preset` column). The header shows the name only while the rules on
 * screen still hash to that fingerprint, so any edit hides it and Discard
 * brings it back: the same scheme as the recon presets.
 */
import { canonicalJson, cyrb53 } from '@/lib/fingerprint'
import { coerceDoc, type NodeFilterMode } from './model'
import { countActiveRules } from './validate'

export interface LoadedMuteRulesPreset {
  name: string
  fingerprint: string
}

export const PRESET_LIMITS = { name: 100, description: 500 } as const

/**
 * A digest of what a preset loads. The JSON round trip drops keys an edit left
 * as `undefined`, which the stored copy never has, so reverting an edit by hand
 * brings the badge back.
 */
export function muteRulesFingerprint(mode: NodeFilterMode, rules: unknown): string {
  const doc = JSON.parse(JSON.stringify(coerceDoc(rules)))
  return cyrb53(`mode=${mode}\nrules=${canonicalJson(doc)}`)
}

export function readLoadedPreset(value: unknown): LoadedMuteRulesPreset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { name, fingerprint } = value as Record<string, unknown>
  return typeof name === 'string' && name !== '' && typeof fingerprint === 'string' && fingerprint !== ''
    ? { name, fingerprint }
    : null
}

/** The preset to badge, if `mode` + `rules` are still exactly what it loaded. */
export function appliedPresetName(loaded: unknown, mode: NodeFilterMode, rules: unknown): string | null {
  const preset = readLoadedPreset(loaded)
  return preset && muteRulesFingerprint(mode, rules) === preset.fingerprint ? preset.name : null
}

/** The `loadedPreset` a save may carry: null clears it, anything malformed is refused. */
export function parseLoadedPresetInput(
  value: unknown,
): { ok: true; value: LoadedMuteRulesPreset | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null }
  const preset = readLoadedPreset(value)
  // cyrb53 is at most 14 hex digits; the slack only guards the column.
  if (!preset || preset.name.length > PRESET_LIMITS.name || preset.fingerprint.length > 32) {
    return { ok: false, error: 'loadedPreset must be null or { name, fingerprint }' }
  }
  return { ok: true, value: preset }
}

/** A preset's name and description as stored, or why they are refused. */
export function parsePresetText(
  name: unknown, description: unknown,
): { ok: true; name: string; description: string } | { ok: false; error: string } {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'Preset name is required' }
  if (name.trim().length > PRESET_LIMITS.name) {
    return { ok: false, error: `Preset name is at most ${PRESET_LIMITS.name} characters` }
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return { ok: false, error: 'description must be a string' }
  }
  const desc = typeof description === 'string' ? description.trim() : ''
  if (desc.length > PRESET_LIMITS.description) {
    return { ok: false, error: `Description is at most ${PRESET_LIMITS.description} characters` }
  }
  return { ok: true, name: name.trim(), description: desc }
}

export interface MuteRulesPresetSummary {
  id: string
  name: string
  description: string
  mode: NodeFilterMode
  counts: { rules: number; kinds: number }
  createdAt: string | Date
  updatedAt: string | Date
}

/** What a preset list shows: everything but the rules themselves. */
export function presetSummary(row: {
  id: string; name: string; description: string; mode: string; rules: unknown; createdAt: Date; updatedAt: Date
}): MuteRulesPresetSummary {
  const mode: NodeFilterMode = row.mode === 'allowlist' ? 'allowlist' : 'denylist'
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode,
    counts: countActiveRules(mode, row.rules),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
