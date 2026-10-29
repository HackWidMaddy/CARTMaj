import { describe, test, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isHardBlockedDomain, firstHardBlocked } from './hard-guardrail'

// One vector file for all three copies (this one and the two Python mirrors),
// so a pattern added to one copy only fails here or there.
const VECTORS = join(process.cwd(), '..', 'recon_orchestrator', 'tests', 'fixtures', 'hard_guardrail_vectors.json')

interface Vector { name: string; blocked: boolean; why: string }

describe.skipIf(!existsSync(VECTORS))('hard guardrail: shared vectors', () => {
  const vectors: Vector[] = existsSync(VECTORS) ? JSON.parse(readFileSync(VECTORS, 'utf8')).vectors : []

  test('the vector file is not empty', () => {
    expect(vectors.length).toBeGreaterThan(20)
  })

  test.each(vectors.map(v => [v.name, v.blocked, v.why] as const))(
    '%j -> blocked=%s (%s)',
    (name, blocked) => {
      expect(isHardBlockedDomain(name).blocked).toBe(blocked)
    },
  )
})

describe('firstHardBlocked', () => {
  test('reports the first blocked name in input order, with its reason', () => {
    const hit = firstHardBlocked(['example.com', 'www.isa.org.jm', 'www.agency.gov.uk'])
    expect(hit?.name).toBe('www.isa.org.jm')
    expect(hit?.reason).toContain("'www.isa.org.jm'")
  })

  test('names the entry as typed, not its normalised form', () => {
    expect(firstHardBlocked(['ok.example.com', '*.gov.uk'])?.name).toBe('*.gov.uk')
  })

  test('is null for a clean list', () => {
    expect(firstHardBlocked(['example.com', 'acme.co.uk', 'alice.github.io', ''])).toBeNull()
  })
})

describe('the session-only guardrail proxy route stays deleted', () => {
  // /api/guardrail/check-target had no caller, checked a session but not project
  // ownership, and forwarded any projectId to the agent.
  test('no route file exists', () => {
    expect(existsSync(join(process.cwd(), 'src', 'app', 'api', 'guardrail', 'check-target', 'route.ts'))).toBe(false)
  })
})
