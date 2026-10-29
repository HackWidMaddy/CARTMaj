/**
 * The Domain batch grouping rule (§4.1-4.3 of the nested-wildcard plan).
 *
 * Hosts group by their registrable domain (Public Suffix List), never by "the
 * last two labels": `foo.example.co.uk` belongs to `example.co.uk`, and `*.co.uk`
 * is refused. An entry is an EXACT host or a `*.X` wildcard; a wildcard below
 * its org is a scan root of its own (NESTED_WILDCARDS_ENABLED); the refusal path
 * and the collapse logic are exercised here through the `nestedWildcards` option.
 */
import { describe, test, expect } from 'vitest'
import {
  type ScopeGroup,
  MAX_BATCH_GROUPS, MAX_BATCH_HOSTS, NESTED_WILDCARDS_ENABLED,
  groupHostsByScanRoot, normalizeHost, parseEntry, toLegacyRecord, validateDomainBatch,
} from './domainBatch'
import { orgDomain } from './publicSuffix'

const NESTED = { nestedWildcards: true }

function rows(groups: ScopeGroup[]) {
  return groups.map(g => [g.scanRoot, g.orgDomain, g.mode, g.includeRoot, g.exactHosts])
}

/** The §4.2 invariants every grouping must hold. */
function assertInvariants(groups: ScopeGroup[]) {
  const roots = groups.map(g => g.scanRoot)
  expect(new Set(roots).size).toBe(roots.length)
  for (const g of groups) {
    expect(g.orgDomain).toBe(orgDomain(g.scanRoot))
    if (g.mode === 'exact') {
      expect(g.scanRoot).toBe(g.orgDomain)
      expect(g.includeRoot || g.exactHosts.length > 0).toBe(true)
    }
    for (const h of g.exactHosts) {
      expect(h.endsWith(`.${g.scanRoot}`)).toBe(true)
      expect(h).not.toBe(g.scanRoot)
      expect(h).not.toContain('*')
    }
  }
}

describe('grouping by registrable domain', () => {
  test('the screenshot cases are valid and group under their org', () => {
    const { groups, invalid } = groupHostsByScanRoot([
      '*.acme.com.cn', 'www.shop.acme.com.hk', '*.acme.bet.br', 'foo.example.co.uk',
    ])
    expect(invalid).toEqual([])
    expect(rows(groups)).toEqual([
      ['acme.com.cn', 'acme.com.cn', 'enumerate', false, []],
      ['acme.com.hk', 'acme.com.hk', 'exact', false, ['www.shop.acme.com.hk']],
      ['acme.bet.br', 'acme.bet.br', 'enumerate', false, []],
      ['example.co.uk', 'example.co.uk', 'exact', false, ['foo.example.co.uk']],
    ])
    assertInvariants(groups)
  })

  test('two companies under one public suffix are two groups', () => {
    const { groups } = groupHostsByScanRoot(['www.acme.co.uk', 'www.other.co.uk'])
    expect(groups.map(g => g.scanRoot)).toEqual(['acme.co.uk', 'other.co.uk'])
  })

  test('a deep exact host joins its org, at any depth', () => {
    const { groups } = groupHostsByScanRoot(['a.b.c.d.example.com', 'www.example.com'])
    expect(rows(groups)).toEqual([['example.com', 'example.com', 'exact', false, ['a.b.c.d.example.com', 'www.example.com']]])
  })

  test('the bare org turns Root on in an EXACT group', () => {
    const { groups } = groupHostsByScanRoot(['example.com', 'www.example.com'])
    expect(rows(groups)).toEqual([['example.com', 'example.com', 'exact', true, ['www.example.com']]])
  })

  test('an exact host under a wildcard is a seed; the wildcard name itself turns Root on', () => {
    const { groups } = groupHostsByScanRoot(['*.example.org', 'v1.example.org', 'example.org'])
    expect(rows(groups)).toEqual([['example.org', 'example.org', 'enumerate', true, ['v1.example.org']]])
    assertInvariants(groups)
  })

  test('group order is the first entry that formed or joined each group', () => {
    const { groups } = groupHostsByScanRoot(['www.b.com', 'x.a.com', '*.c.com', 'a.com', 'y.b.com'])
    expect(groups.map(g => g.scanRoot)).toEqual(['b.com', 'a.com', 'c.com'])
  })
})

describe('nested wildcards (NESTED_WILDCARDS_ENABLED)', () => {
  test('the flag is on: the graph attaches a deeper scan root to its org', () => {
    expect(NESTED_WILDCARDS_ENABLED).toBe(true)
    const { groups, invalid } = groupHostsByScanRoot(['*.sub.example.com'])
    expect(invalid).toEqual([])
    expect(groups.map(g => [g.scanRoot, g.orgDomain, g.mode])).toEqual([['sub.example.com', 'example.com', 'enumerate']])
  })

  test('off: a wildcard below the org is refused with its own reason', () => {
    const { groups, invalid } = groupHostsByScanRoot(['*.sub.example.com'], { nestedWildcards: false })
    expect(groups).toEqual([])
    expect(invalid).toEqual([{ entry: '*.sub.example.com', reason: 'nested_wildcard_disabled' }])
  })

  test('on: the worked example of the plan groups as specified', () => {
    const { groups, invalid } = groupHostsByScanRoot([
      '*.acme.com.cn', 'www.shop.acme.com.hk', '*.api.example.com', 'api.example.com',
      'v1.api.example.com', 'www.example.com', 'a.b.c.d.example.com',
      '*.dev.eu.corp.example.com', '*.eu.corp.example.com', '*.co.uk',
    ], NESTED)
    expect(invalid).toEqual([{ entry: '*.co.uk', reason: 'wildcard_on_suffix' }])
    expect(rows(groups)).toEqual([
      ['acme.com.cn', 'acme.com.cn', 'enumerate', false, []],
      ['acme.com.hk', 'acme.com.hk', 'exact', false, ['www.shop.acme.com.hk']],
      ['api.example.com', 'example.com', 'enumerate', true, ['v1.api.example.com']],
      ['example.com', 'example.com', 'exact', false, ['www.example.com', 'a.b.c.d.example.com']],
      ['eu.corp.example.com', 'example.com', 'enumerate', false, []],
    ])
    expect(groups[4].notes).toEqual([{ entry: '*.dev.eu.corp.example.com', coveredBy: '*.eu.corp.example.com' }])
    assertInvariants(groups)
  })

  test('on: a collapsed entry is still stored, in operator order', () => {
    const { entries } = groupHostsByScanRoot(['*.dev.eu.corp.example.com', '*.eu.corp.example.com'], NESTED)
    expect(entries).toEqual(['*.dev.eu.corp.example.com', '*.eu.corp.example.com'])
  })

  test('on: collapse is transitive and the note names the broadest survivor', () => {
    const { groups } = groupHostsByScanRoot(['*.a.b.example.com', '*.b.example.com', '*.example.com'], NESTED)
    expect(groups.map(g => g.scanRoot)).toEqual(['example.com'])
    expect(groups[0].notes.map(n => n.coveredBy)).toEqual(['*.example.com', '*.example.com'])
  })
})

describe('refusals carry a reason and the entry as typed', () => {
  test.each([
    ['*.co.uk', 'wildcard_on_suffix'],
    ['*.github.io', 'wildcard_on_suffix'],
    ['*.com.vn', 'wildcard_on_suffix'],
    ['*.bet.br', 'wildcard_on_suffix'],
    ['co.uk', 'public_suffix'],
    ['github.io', 'public_suffix'],
    ['192.0.2.10', 'ip_literal'],
    ['https://192.0.2.10:8443/x', 'ip_literal'],
    ['[2001:db8::1]', 'ip_literal'],
    ['**.example.com', 'malformed_wildcard'],
    ['*.', 'malformed_wildcard'],
    ['*', 'malformed_wildcard'],
    ['a.*.example.com', 'malformed_wildcard'],
    ['example.com*', 'malformed_wildcard'],
    [`${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.com`, 'too_long'],
  ])('%s -> %s', (entry, reason) => {
    expect(groupHostsByScanRoot([entry]).invalid).toEqual([{ entry, reason }])
  })

  // Every one of these would otherwise reach a Cypher MERGE, a scan target and a
  // filename: rejected, never sanitized.
  test.each([
    ['a single label', 'localhost'],
    ['path traversal', '../../etc/passwd'],
    ['a backslash', 'evil.com\\..\\x'],
    ['an underscore', 'bad_host.example.com'],
    ['a NUL byte', 'evil\0.com'],
    ['a space', 'ev il.com'],
    ['an empty label', 'a..b.com'],
    ['a leading hyphen label', '-bad.example.com'],
    ['a trailing hyphen label', 'bad-.example.com'],
    ['a numeric TLD', 'example.123'],
    ['a one-letter TLD', 'example.c'],
    ['a shell metacharacter', 'evil.com;whoami'],
    ['a Cypher quote', "evil.com'})--"],
  ])('%s is not a hostname', (_why, entry) => {
    const { groups, invalid } = groupHostsByScanRoot([entry])
    expect(groups).toEqual([])
    expect(invalid).toEqual([{ entry: entry.trim(), reason: 'not_hostname' }])
  })

  test('the entry is reported as typed, so the UI can point at the line', () => {
    expect(groupHostsByScanRoot(['  Bad Host  ']).invalid).toEqual([{ entry: 'Bad Host', reason: 'not_hostname' }])
  })

  test('one bad entry does not discard the good ones', () => {
    const { groups, invalid } = groupHostsByScanRoot(['ok.example.com', 'co.uk'])
    expect(groups.map(g => g.scanRoot)).toEqual(['example.com'])
    expect(invalid).toHaveLength(1)
  })
})

describe('normalization and dedupe', () => {
  test('scheme, credentials, port, path, case and a trailing dot are stripped', () => {
    expect(normalizeHost('HTTPS://user:pw@WWW.Example.COM:8443/path?q=1#f')).toBe('www.example.com')
    expect(normalizeHost('www.example.com.')).toBe('www.example.com')
  })

  test('both wildcard spellings mean the same thing and store one token', () => {
    const { entries, groups } = groupHostsByScanRoot(['*.example.com', '*example.com'])
    expect(entries).toEqual(['*.example.com'])
    expect(groups).toHaveLength(1)
  })

  test('a wildcard and its bare name are different entries', () => {
    const { entries, groups } = groupHostsByScanRoot(['*.example.com', 'example.com'])
    expect(entries).toEqual(['*.example.com', 'example.com'])
    expect(groups[0].includeRoot).toBe(true)
  })

  test('duplicates after normalization are dropped', () => {
    expect(groupHostsByScanRoot(['www.example.com', 'WWW.EXAMPLE.COM.', 'https://www.example.com/']).entries)
      .toEqual(['www.example.com'])
  })

  test('blank and non-string entries are skipped, not reported', () => {
    const { invalid, entries } = groupHostsByScanRoot(['', '  ', 'www.example.com', null as unknown as string])
    expect(invalid).toEqual([])
    expect(entries).toEqual(['www.example.com'])
  })
})

describe('parseEntry', () => {
  test('returns the org of a valid entry', () => {
    expect(parseEntry('*.acme.com.cn')).toEqual({ ok: true, host: 'acme.com.cn', wildcard: true, org: 'acme.com.cn' })
  })
})

describe('the legacy stored record', () => {
  test('keeps the 7.1.0 shape, computed from the new grouping', () => {
    const { groups } = groupHostsByScanRoot(['*.example.org', 'example.org', 'v1.example.org', 'www.acme.co.uk'])
    expect(groups.map(toLegacyRecord)).toEqual([
      { rootDomain: 'example.org', prefixes: ['*', '.', 'v1.'], hosts: ['*.example.org', 'example.org', 'v1.example.org'], wildcard: true },
      { rootDomain: 'acme.co.uk', prefixes: ['www.'], hosts: ['www.acme.co.uk'], wildcard: false },
    ])
  })
})

describe('validateDomainBatch', () => {
  test('accepts a normal list and returns what to store', () => {
    const v = validateDomainBatch(['www.example.com', '*.acme.com.cn'])
    expect(v.ok).toBe(true)
    expect(v.entries).toEqual(['www.example.com', '*.acme.com.cn'])
    expect(v.legacy.map(g => g.rootDomain)).toEqual(['example.com', 'acme.com.cn'])
  })

  test('an empty list is refused: batch mode needs a target', () => {
    expect(validateDomainBatch([]).errors).toEqual(['Domain batch mode needs at least one hostname.'])
  })

  test('an invalid entry fails the whole list, naming the entry and its reason', () => {
    const v = validateDomainBatch(['www.example.com', '*.co.uk'])
    expect(v.ok).toBe(false)
    expect(v.errors.join(' ')).toContain('*.co.uk (a wildcard on a public suffix')
  })

  test(`refuses more than ${MAX_BATCH_HOSTS} hostnames`, () => {
    const hosts = Array.from({ length: MAX_BATCH_HOSTS + 1 }, (_, i) => `h${i}.example.com`)
    expect(validateDomainBatch(hosts).errors.join(' ')).toContain('Too many hostnames')
  })

  test(`refuses more than ${MAX_BATCH_GROUPS} scope groups`, () => {
    const hosts = Array.from({ length: MAX_BATCH_GROUPS + 1 }, (_, i) => `www.d${i}.com`)
    expect(validateDomainBatch(hosts).errors.join(' ')).toContain('Too many scope groups')
  })
})
