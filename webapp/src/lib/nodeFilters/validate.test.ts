/**
 * The webapp validator against the engine's own fixtures.
 *
 * graph_db/node_filters/build.py copies the synthetic documents here; the engine
 * test (tests/test_node_filters_engine.py) runs the same files through
 * model.parse. Same verdict, same active kinds, same number of errors: an
 * editor that accepts what the engine refuses, or the other way round, fails
 * one of the two.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_FILTER_CATALOG, enabledKinds } from './catalog'
import { allErrors, countActiveRules, validNetwork, validRuleName, validateNodeFilters } from './validate'

const FIXTURES = join(__dirname, 'fixtures')
const files = readdirSync(FIXTURES).filter(f => f.endsWith('.json')).sort()

describe('the shared fixtures', () => {
  test('were copied here by the engine build', () => {
    expect(files.length).toBeGreaterThanOrEqual(25)
  })

  test.each(files)('%s', file => {
    const c = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'))
    const v = validateNodeFilters(c.mode, c.rules)
    expect({ ok: v.ok, active: v.activeKinds, errors: allErrors(v).length }).toEqual(c.expect)
  })
})

describe('the catalog the editor offers', () => {
  test('is the engine phase-one set', () => {
    expect(enabledKinds().map(k => k.id)).toContain('vuln.nuclei')
    expect(enabledKinds().every(k => k.phase === 1)).toBe(true)
  })

  test('every example in the catalog is a valid rule', () => {
    for (const kind of enabledKinds()) {
      kind.examples.forEach((ex, i) => {
        const doc = { version: 1, kinds: { [kind.id]: { enabled: true, action: 'mute', rules: [
          { id: `example${String(i).padStart(2, '0')}`, enabled: true, ...ex },
        ] } } }
        expect(allErrors(validateNodeFilters('denylist', doc)), `${kind.id} example ${i}`).toEqual([])
      })
    }
  })

  test('operators come from the catalog, not a second list', () => {
    expect(NODE_FILTER_CATALOG.operators.ordinal).toContain('lte')
    expect(NODE_FILTER_CATALOG.operators.ip).toEqual(['in_cidr', 'not_in_cidr', 'missing'])
  })
})

describe('helpers', () => {
  test('rule names', () => {
    expect(validRuleName('Informational templates')).toBe(true)
    expect(validRuleName('Modèle già visto')).toBe(true)
    for (const bad of ['', ' x', 'x ', '<b>', '=1+1', "a'b", 'x'.repeat(81), 7]) {
      expect(validRuleName(bad), String(bad)).toBe(false)
    }
  })

  test('networks, as ip_network(strict=False) reads them', () => {
    for (const ok of ['192.0.2.0/24', '192.0.2.10', '192.0.2.10/24', '2001:db8::/32', '2001:db8::1',
      '::1', '::', '::ffff:192.0.2.1', '2001:db8:0:0:0:0:0:1']) {
      expect(validNetwork(ok), ok).toBe(true)
    }
    for (const bad of ['192.0.2.0/33', '256.0.0.1', '192.0.2', '010.0.0.1', '2001:db8::/129',
      '2001:db8:::1', '1:2:3:4:5:6:7:8:9', 'example.com', '192.0.2.0/24/1', '']) {
      expect(validNetwork(bad), bad).toBe(false)
    }
  })

  test('the active-rule count for the badge', () => {
    const doc = { version: 1, kinds: {
      'vuln.nuclei': { enabled: true, action: 'mute', rules: [
        { id: 'k3f9a2', name: 'One', enabled: true, all: [{ field: 'severity', op: 'in', value: ['info'] }] },
        { id: 'p81c0d', name: 'Two', enabled: false, all: [{ field: 'severity', op: 'in', value: ['low'] }] },
        { id: 'q12345', name: 'Bad', enabled: true, all: [{ field: 'nope', op: 'in', value: ['x'] }] },
      ] },
      secret: { enabled: false, action: 'mute', rules: [
        { id: 'r12345', name: 'Off kind', enabled: true, all: [{ field: 'source', op: 'in', value: ['jsluice'] }] },
      ] },
    } }
    expect(countActiveRules('denylist', doc)).toEqual({ rules: 1, kinds: 1 })
    expect(countActiveRules('allowlist', doc)).toEqual({ rules: 0, kinds: 0 })
  })
})

describe('documents the webapp must refuse', () => {
  const DOC = { version: 1, kinds: { 'vuln.nuclei': { enabled: true, action: 'mute', rules: [
    { id: 'k3f9a2', name: 'Info', enabled: true, all: [{ field: 'severity', op: 'in', value: ['info'] }] },
  ] } } }

  test('string_rules_document: a JSON string is refused, not parsed', () => {
    // A PUT stored it as an empty document (coerceDoc(string)), silently wiping
    // the rules; an import stored it raw, where the UI showed no rules but the
    // scan sweep parsed and applied them.
    const verdict = validateNodeFilters('denylist', JSON.stringify(DOC))
    expect(verdict.ok).toBe(false)
    expect(verdict.errors[0]).toMatch(/must be a JSON object/)
  })

  test('prototype_key_field_names: inherited names are unknown fields, not a crash', () => {
    for (const field of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const doc = { version: 1, kinds: { 'vuln.nuclei': { enabled: true, action: 'mute', rules: [
        { id: 'k3f9a2', name: 'Info', enabled: true, all: [{ field, op: 'in', value: ['x'] }] },
      ] } } }
      const verdict = validateNodeFilters('denylist', doc)
      expect(verdict.kindErrors['vuln.nuclei'][0], field).toMatch(/unknown field/)
      expect(verdict.activeKinds).toEqual([])
    }
    for (const kind of ['constructor', '__proto__', 'toString']) {
      const verdict = validateNodeFilters('denylist', { version: 1, kinds: JSON.parse(`{"${kind}": {"enabled": true}}`) })
      expect(verdict.errors[0], kind).toMatch(/unknown kind/)
    }
  })
})
