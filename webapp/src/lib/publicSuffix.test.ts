import { describe, test, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { icannRegistrable, isIpLiteral, isPublicSuffix, orgDomain, publicSuffixOf } from './publicSuffix'

// Shared with recon/helpers/public_suffix.py, so the two libraries cannot drift.
const VECTORS = join(process.cwd(), '..', 'recon', 'tests', 'fixtures', 'public_suffix_vectors.json')

interface Vector { host: string; publicSuffix: string; org: string | null }

describe.skipIf(!existsSync(VECTORS))('public suffix: shared vectors', () => {
  const vectors: Vector[] = existsSync(VECTORS) ? JSON.parse(readFileSync(VECTORS, 'utf8')).vectors : []

  test.each(vectors.map(v => [v.host, v.publicSuffix, v.org] as const))(
    '%s -> suffix %s, org %s', (host, suffix, org) => {
      expect(publicSuffixOf(host)).toBe(suffix)
      expect(orgDomain(host)).toBe(org)
      expect(isPublicSuffix(host)).toBe(org === null)
    },
  )
})

describe('public suffix helpers', () => {
  test('the private section is on: a GitHub Pages site is its own org', () => {
    expect(orgDomain('www.alice.github.io')).toBe('alice.github.io')
    expect(isPublicSuffix('github.io')).toBe(true)
  })

  test('the ICANN name shows the platform owner', () => {
    expect(icannRegistrable('alice.github.io')).toBe('github.io')
    expect(icannRegistrable('www.acme.co.uk')).toBe('acme.co.uk')
  })

  test('an IP literal is neither an org nor a suffix', () => {
    expect(isIpLiteral('192.0.2.10')).toBe(true)
    expect(orgDomain('192.0.2.10')).toBeNull()
    expect(isPublicSuffix('192.0.2.10')).toBe(false)
  })
})
