import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveScopeGroups } from './scopeGroups'

// The fixture recon, the orchestrator and the agent also read: this side proves
// its scopeGroups is what the webapp really derives from the project's fields.
const FIXTURE = join(process.cwd(), '..', 'tests', 'fixtures', 'scope_groups_contract.json')

describe.skipIf(!existsSync(FIXTURE))('scope groups: cross-service contract', () => {
  type Case = { name: string; project: Parameters<typeof resolveScopeGroups>[0]; scopeGroups: unknown }
  const cases: Case[] = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')).cases : []
  test.each(cases.map(c => [c.name, c] as [string, Case]))('%s', (_name, c) => {
    const { groups, invalid } = resolveScopeGroups(c.project)
    expect(invalid).toEqual([])
    expect(groups.map(g => ({
      scanRoot: g.scanRoot, orgDomain: g.orgDomain, mode: g.mode, includeRoot: g.includeRoot,
      exactHosts: g.exactHosts, entries: g.entries,
    }))).toEqual(c.scopeGroups)
  })
})
