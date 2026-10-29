/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { NODE_FILTER_CATALOG } from '@/lib/nodeFilters/catalog'
import { EMPTY_NODE_FILTER_DOC } from '@/lib/nodeFilters/model'
import { validateNodeFilters } from '@/lib/nodeFilters/validate'
import { describeCondition, opLabel } from './describeCondition'
import {
  addRule, defaultCondition, newRuleId, removeRule, sameDoc, setKindEnabled, updateRule,
} from './draft'

const NUCLEI = NODE_FILTER_CATALOG.kinds['vuln.nuclei']

describe('rule ids', () => {
  test('are 8 characters the engine accepts', () => {
    for (let i = 0; i < 50; i++) expect(newRuleId()).toMatch(/^[a-z0-9]{8}$/)
  })

  test('are never reused within a kind', () => {
    let n = 0
    const rigged = () => (n++ < 8 ? 0 : 0.5)   // first id is all 'a', then a different one
    expect(newRuleId(['aaaaaaaa'], rigged)).not.toBe('aaaaaaaa')
  })
})

describe('editing a draft', () => {
  test('adding the first rule switches the kind on', () => {
    const { doc, id } = addRule(EMPTY_NODE_FILTER_DOC, 'vuln.nuclei', {
      name: 'Info', all: [{ field: 'severity', op: 'in', value: ['info'] }],
    })
    expect(doc.kinds['vuln.nuclei'].enabled).toBe(true)
    expect(doc.kinds['vuln.nuclei'].rules[0].id).toBe(id)
    expect(validateNodeFilters('denylist', doc).activeKinds).toEqual(['vuln.nuclei'])
  })

  test('edits never mutate the previous document', () => {
    const { doc, id } = addRule(EMPTY_NODE_FILTER_DOC, 'secret', { all: [] })
    const renamed = updateRule(doc, 'secret', id, { name: 'Renamed' })
    expect(doc.kinds.secret.rules[0].name).not.toBe('Renamed')
    expect(renamed.kinds.secret.rules[0].name).toBe('Renamed')
    const off = setKindEnabled(renamed, 'secret', false)
    expect(renamed.kinds.secret.enabled).toBe(true)
    expect(off.kinds.secret.enabled).toBe(false)
    expect(removeRule(off, 'secret', id).kinds.secret.rules).toEqual([])
  })

  test('a default condition fits its field', () => {
    expect(defaultCondition('severity', NUCLEI.fields.severity, NODE_FILTER_CATALOG.operators.ordinal))
      .toEqual({ field: 'severity', op: 'in', value: [] })
    expect(defaultCondition('cvss', NUCLEI.fields.cvss, NODE_FILTER_CATALOG.operators.number))
      .toEqual({ field: 'cvss', op: 'lt', value: 0 })
  })

  test('unsaved changes ignore key order', () => {
    expect(sameDoc({ version: 1, kinds: { a: { enabled: true, rules: [] } } },
                   { kinds: { a: { rules: [], enabled: true } }, version: 1 })).toBe(true)
    expect(sameDoc({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('how a condition reads', () => {
  test.each([
    [{ field: 'severity', op: 'in', value: ['info', 'low'] }, 'Severity is one of info, low'],
    [{ field: 'cvss', op: 'between', value: [4, 6.9] }, 'CVSS score is between 4 and 6.9'],
    [{ field: 'template_id', op: 'missing' }, 'Template id is missing'],
    [{ field: 'host', op: 'glob', value: '*.example.com' }, 'Host matches *.example.com'],
  ])('%j', (cond, text) => {
    expect(describeCondition(cond, NUCLEI.fields[cond.field])).toBe(text)
  })

  test('eq reads differently on a number and on text', () => {
    expect(opLabel('eq', 'number')).toBe('equals')
    expect(opLabel('eq', 'text')).toBe('is')
  })
})
