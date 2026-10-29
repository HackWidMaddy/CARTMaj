import { describe, test, expect } from 'vitest'
import {
  admitsPartialHost, discoveryDomains, graphDomainOf, graphHostInScope, graphScopeParams, partialScopeFields,
  resolveProjectRoots,
} from './partialReconScope'

const PID = 'p1'

describe('resolveProjectRoots', () => {
  test('a batch offers its scope-group scan roots, derived from the host list', () => {
    const scope = resolveProjectRoots({
      domainBatchMode: true, domainBatchHosts: ['www.acme.co.uk', '*.example.com', 'v1.example.com'],
      // A stale legacy record grouped under the bare suffix must not be offered.
      domainBatchGroups: [{ rootDomain: 'co.uk', prefixes: ['www.acme.'] }],
    }, PID)
    expect(scope.roots).toEqual(['acme.co.uk', 'example.com'])
    expect(scope.wildcardRoots).toEqual(['example.com'])
  })

  test('a single domain keeps the stored spelling of its target', () => {
    expect(resolveProjectRoots({ targetDomain: 'Alpha.test', subdomainList: [] }, PID).roots).toEqual(['Alpha.test'])
  })

  test('a single-domain target the scope refuses offers no root', () => {
    expect(resolveProjectRoots({ targetDomain: 'co.uk', subdomainList: [] }, PID).roots).toEqual([])
  })

  test('without the host list it falls back to the legacy record', () => {
    const scope = resolveProjectRoots({
      domainBatchMode: true, domainBatchGroups: [{ rootDomain: 'example.com', prefixes: ['*'] }],
    }, PID)
    expect(scope.roots).toEqual(['example.com'])
    expect(scope.groups).toEqual([])
  })

  test('IP mode offers the synthetic root', () => {
    expect(resolveProjectRoots({ ipMode: true }, PID).roots).toEqual(['ip-targets.p1'])
  })
})

describe('discoveryDomains', () => {
  test('only an ENUMERATE group is offered to SubdomainDiscovery', () => {
    const scope = resolveProjectRoots({ domainBatchMode: true, domainBatchHosts: ['*.a.com', 'www.b.com'] }, PID)
    expect(discoveryDomains(scope, ['a.com', 'b.com'])).toEqual(['a.com'])
  })

  test('an EXACT single-domain project no longer enumerates', () => {
    const exact = resolveProjectRoots({ targetDomain: 'example.com', subdomainList: ['www.'] }, PID)
    expect(discoveryDomains(exact, ['example.com'])).toEqual([])
    const enumerate = resolveProjectRoots({ targetDomain: 'example.com', subdomainList: ['.'] }, PID)
    expect(discoveryDomains(enumerate, ['example.com'])).toEqual(['example.com'])
  })
})

describe('admitsPartialHost (§4.6 partial user-typed rule)', () => {
  const scope = resolveProjectRoots({
    domainBatchMode: true, domainBatchHosts: ['www.example.com', 'example.com'],
  }, PID)

  test('ENUMERATE admits strict subdomains, the root only with Root on', () => {
    const enumOnly = resolveProjectRoots({ domainBatchMode: true, domainBatchHosts: ['*.example.org'] }, PID)
    expect(admitsPartialHost(enumOnly, 'x.example.org')).toBe(true)
    expect(admitsPartialHost(enumOnly, 'example.org')).toBe(false)
  })

  test('EXACT admits its listed hosts and its root with Root on, nothing else', () => {
    expect(admitsPartialHost(scope, 'WWW.example.com')).toBe(true)
    expect(admitsPartialHost(scope, 'example.com')).toBe(true)
    expect(admitsPartialHost(scope, 'mail.example.com')).toBe(false)
  })
})

describe('partialScopeFields', () => {
  test('a graph Domain that is no scan root is stale', () => {
    const scope = resolveProjectRoots({ domainBatchMode: true, domainBatchHosts: ['www.acme.co.uk'] }, PID)
    const fields = partialScopeFields(scope, [
      { name: 'co.uk', hasData: true }, { name: 'acme.co.uk', hasData: false },
    ])
    expect(fields.domains).toEqual(['acme.co.uk'])
    expect(fields.stale_domains).toEqual(['co.uk'])
    expect(fields.empty_domains).toEqual(['acme.co.uk'])
  })
})

describe('the graph scope test (§4.6 partial-recon graph targets)', () => {
  const single = resolveProjectRoots({ targetDomain: 'api.example.com', subdomainList: [] }, PID)

  test('a deep single-domain root hangs off its org Domain', () => {
    expect(graphDomainOf(single, 'api.example.com')).toBe('example.com')
    const fields = partialScopeFields(single, [{ name: 'example.com', hasData: true }])
    expect(fields.domains).toEqual(['api.example.com'])
    expect(fields.stale_domains).toEqual([])
    expect(fields.empty_domains).toEqual([])
  })

  test('an enumerated root admits its strict subdomains, the root only with Root on', () => {
    const params = graphScopeParams(single, ['api.example.com'])
    expect(graphHostInScope(params, 'v1.api.example.com')).toBe(true)
    expect(graphHostInScope(params, 'api.example.com')).toBe(false)
    expect(graphHostInScope(params, 'www.example.com')).toBe(false)
  })

  test('the longest scan root decides, and only selected roots count', () => {
    const scope = resolveProjectRoots({
      domainBatchMode: true, domainBatchHosts: ['*.example.com', 'shop.example.org', 'example.org'],
    }, PID)
    const params = graphScopeParams(scope, ['example.org'])
    expect(graphHostInScope(params, 'shop.example.org')).toBe(true)
    expect(graphHostInScope(params, 'example.org')).toBe(true)
    expect(graphHostInScope(params, 'mail.example.org')).toBe(false)  // EXACT: listed only
    expect(graphHostInScope(params, 'www.example.com')).toBe(false)   // not a selected root
  })

  test("a removed scan root's hosts are not in scope (§4.11.7)", () => {
    // Before: *.example.com and the org; after the edit only www.example.com
    // is listed, so the old enumerated hosts still hang off Domain(example.com).
    const scope = resolveProjectRoots({ domainBatchMode: true, domainBatchHosts: ['www.example.com'] }, PID)
    const params = graphScopeParams(scope, ['example.com'])
    expect(graphHostInScope(params, 'www.example.com')).toBe(true)
    expect(graphHostInScope(params, 'old.example.com')).toBe(false)
    expect(discoveryDomains(scope, ['example.com'])).toEqual([])
  })
})
