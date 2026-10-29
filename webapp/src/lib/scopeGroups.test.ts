import { describe, test, expect } from 'vitest'
import { groupHostsByScanRoot } from './domainBatch'
import {
  GRAPH_DOMAIN_IS_ORG, authScopePatterns, expectedDomainNames, groupLabel, guardrailNames, isScopeWidening,
  recordingScope, resolveScopeGroups, sameScope, scopeGuardrailNames, scopeSignature, scopeSummary,
  softGuardrailNames,
} from './scopeGroups'

const batch = (hosts: string[], nested = false) => groupHostsByScanRoot(hosts, { nestedWildcards: nested }).groups

describe('resolveScopeGroups', () => {
  test('a batch is derived from domainBatchHosts; the stored groups are ignored', () => {
    const { groups } = resolveScopeGroups({
      domainBatchMode: true, domainBatchHosts: ['www.acme.co.uk'],
      // An inconsistent legacy record must not matter.
      ...({ domainBatchGroups: [{ rootDomain: 'co.uk', prefixes: ['*'] }] } as object),
    })
    expect(groups.map(g => [g.scanRoot, g.mode])).toEqual([['acme.co.uk', 'exact']])
  })

  test('IP mode has no groups', () => {
    expect(resolveScopeGroups({ ipMode: true, domainBatchMode: true, domainBatchHosts: ['a.example.com'] }))
      .toEqual({ groups: [], invalid: [] })
  })

  test('single domain with no prefixes is one ENUMERATE group; "." turns Root on', () => {
    expect(resolveScopeGroups({ targetDomain: 'Api.Example.com', subdomainList: ['.'] }).groups).toEqual([{
      scanRoot: 'api.example.com', orgDomain: 'example.com', mode: 'enumerate', includeRoot: true,
      exactHosts: [], entries: ['*.api.example.com', 'api.example.com'], notes: [],
    }])
  })

  test('single domain with prefixes is one EXACT group; prefixes may have several labels', () => {
    const { groups } = resolveScopeGroups({ targetDomain: 'example.com', subdomainList: ['www.', 'eu.api.'] })
    expect(groups.map(g => [g.mode, g.includeRoot, g.exactHosts])).toEqual([
      ['exact', false, ['www.example.com', 'eu.api.example.com']],
    ])
  })

  test.each([
    ['*'], ['a*b.'], ['a..b.'], ['example.com'], ['www.example.com'], ['bad_label.'],
  ])('single-domain prefix %s is refused as invalid_prefix', (prefix) => {
    expect(resolveScopeGroups({ targetDomain: 'example.com', subdomainList: [prefix] }).invalid)
      .toEqual([{ entry: prefix, reason: 'invalid_prefix' }])
  })

  test('a single-domain target that is a public suffix or an IP is refused', () => {
    expect(resolveScopeGroups({ targetDomain: 'co.uk' }).invalid).toEqual([{ entry: 'co.uk', reason: 'public_suffix' }])
    expect(resolveScopeGroups({ targetDomain: '192.0.2.10' }).invalid).toEqual([{ entry: '192.0.2.10', reason: 'ip_literal' }])
  })

  test('a batch reports its refused entries', () => {
    expect(resolveScopeGroups({ domainBatchMode: true, domainBatchHosts: ['*.github.io', 'www.example.com'] }).invalid)
      .toEqual([{ entry: '*.github.io', reason: 'wildcard_on_suffix' }])
  })
})

describe('guardrail names', () => {
  test('entries first (markers stripped), then exact hosts, scan roots and orgs', () => {
    expect(guardrailNames(batch(['www.agency.gov.uk', '*.example.com', 'api.example.com'])))
      .toEqual(['www.agency.gov.uk', 'example.com', 'api.example.com', 'agency.gov.uk'])
  })

  test('scopeGuardrailNames covers every mode and names refused entries too', () => {
    expect(scopeGuardrailNames({ targetDomain: 'org.jm', subdomainList: ['isa.'] })).toEqual(['org.jm', 'isa.org.jm'])
    expect(scopeGuardrailNames({ ipMode: true, targetDomain: 'agency.gov.uk' })).toEqual([])
    expect(scopeGuardrailNames({ domainBatchMode: true, domainBatchHosts: ['*.gov.uk'] })).toEqual(['gov.uk'])
  })

  test('the soft guardrail also sees the ICANN owner of a private-section org', () => {
    expect(softGuardrailNames(batch(['www.alice.github.io', 'www.example.com'])))
      .toEqual(['alice.github.io', 'github.io', 'example.com'])
  })
})

describe('auth and recording scope (§4.6)', () => {
  test('ENUMERATE gives *.root (+ root with Root on); EXACT gives only its hosts', () => {
    const groups = batch(['*.example.org', 'example.org', 'www.acme.co.uk'])
    expect(authScopePatterns(groups)).toEqual(['*.example.org', 'example.org', 'www.acme.co.uk'])
    expect(recordingScope(groups)).toEqual(authScopePatterns(groups))
  })

  test('an EXACT single-domain project never authorises *.target', () => {
    const { groups } = resolveScopeGroups({ targetDomain: 'example.com', subdomainList: ['www.'] })
    expect(authScopePatterns(groups)).toEqual(['www.example.com'])
  })
})

describe('scope equality', () => {
  test('a reorder, or a legacy row re-derived, is the same scope', () => {
    expect(sameScope(batch(['www.b.com', 'www.a.com']), batch(['www.a.com', 'https://WWW.B.COM/']))).toBe(true)
  })

  test('a seed under an ENUMERATE root does not change the signature', () => {
    expect(scopeSignature(batch(['*.example.com', 'v1.example.com']))).toEqual(scopeSignature(batch(['*.example.com'])))
  })

  test('one host -> its whole domain is a change', () => {
    expect(sameScope(batch(['www.example.com']), batch(['*.example.com']))).toBe(false)
  })
})

describe('isScopeWidening (containment, D-21)', () => {
  test('*.example.com -> *.api.example.com is a narrowing', () => {
    expect(isScopeWidening(batch(['*.example.com']), batch(['*.api.example.com'], true))).toBe(false)
  })

  test('adding a host already covered by a wildcard is not a widening', () => {
    expect(isScopeWidening(batch(['*.example.com']), batch(['*.example.com', 'www.example.com']))).toBe(false)
  })

  test('adding *.other.com is a widening', () => {
    expect(isScopeWidening(batch(['*.example.com']), batch(['*.example.com', '*.other.com']))).toBe(true)
  })

  test('adding Root to *.api.example.com is a widening', () => {
    expect(isScopeWidening(batch(['*.api.example.com'], true), batch(['*.api.example.com', 'api.example.com'], true)))
      .toBe(true)
  })

  test('an exact host outside the old scope is a widening; removing one is not', () => {
    expect(isScopeWidening(batch(['www.example.com']), batch(['www.example.com', 'shop.example.com']))).toBe(true)
    expect(isScopeWidening(batch(['www.example.com', 'shop.example.com']), batch(['www.example.com']))).toBe(false)
  })
})

describe('expected Domain names and labels', () => {
  test('the graph Domain is the org, once per org', () => {
    expect(GRAPH_DOMAIN_IS_ORG).toBe(true)
    const { groups } = resolveScopeGroups({ targetDomain: 'Api.Example.com' })
    expect(expectedDomainNames(groups)).toEqual(['example.com'])
    expect(expectedDomainNames(batch(['www.acme.co.uk', 'shop.acme.co.uk', '*.example.org']))).toEqual(
      ['acme.co.uk', 'example.org'])
  })

  test('labels and the summary read as one line', () => {
    const groups = batch(['*.example.org', 'example.org', 'www.acme.co.uk', 'shop.acme.co.uk'])
    expect(groupLabel(groups[0])).toBe('*.example.org (enumerated, +root)')
    expect(groupLabel(groups[1])).toBe('acme.co.uk: www, shop (listed)')
    expect(scopeSummary(groups)).toBe('2 scope groups across 2 domains (1 enumerated)')
    expect(scopeSummary([])).toBe('')
  })
})
