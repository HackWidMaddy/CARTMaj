/**
 * Public Suffix List answers for the whole webapp. Nothing else imports `tldts`.
 *
 * The private section of the list is ON: `alice.github.io` is its own
 * registrable domain and `github.io` is a suffix, so `*.github.io` can never be
 * enumerated. tldts defaults it OFF, which would hand every GitHub Pages site
 * to one org. `icannRegistrable` is the one deliberate exception: the soft
 * guardrail also shows the LLM the platform owner (`github.io`).
 *
 * Mirrors recon/helpers/public_suffix.py (`publicsuffixlist`); both read the
 * vectors in recon/tests/fixtures/public_suffix_vectors.json. Bump the two
 * pinned versions together (docs/readmes/README.DEV.md, release procedure).
 */
import { getDomain, getPublicSuffix, parse } from 'tldts'

const WITH_PRIVATE = { allowPrivateDomains: true } as const

/** An IPv4 or IPv6 literal: never a domain, so never an org or a suffix. */
export function isIpLiteral(host: string): boolean {
  return parse(host).isIp === true
}

/** The registrable (org) domain, e.g. `www.shop.acme.com.hk` -> `acme.com.hk`;
 *  null when the name IS a public suffix, or is an IP literal. */
export function orgDomain(host: string): string | null {
  if (!host || isIpLiteral(host)) return null
  return getDomain(host, WITH_PRIVATE)
}

/** The public suffix of a name, e.g. `acme.bet.br` -> `bet.br`. */
export function publicSuffixOf(host: string): string | null {
  if (!host || isIpLiteral(host)) return null
  return getPublicSuffix(host, WITH_PRIVATE)
}

/** True when anyone can register names directly under this one (`co.uk`,
 *  `github.io`, `com`): it is never a target and never enumerated. */
export function isPublicSuffix(name: string): boolean {
  if (!name || isIpLiteral(name)) return false
  return orgDomain(name) === null
}

/** The ICANN-section registrable domain (`alice.github.io` -> `github.io`). */
export function icannRegistrable(host: string): string | null {
  if (!host || isIpLiteral(host)) return null
  return getDomain(host, { allowPrivateDomains: false })
}
