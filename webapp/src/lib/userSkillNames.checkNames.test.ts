/**
 * checkNames, the batch name rule the upload dialog asks early and the batch writer applies
 * under the lock: each name against the stored ones and the names before it in the batch,
 * suggestions that never collide with anything, and a fixed number of queries.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { checkNames, suggestVersionName } from './userSkillNames'

let db: FakePrisma
// The fake as the client type the module takes (it implements the subset used).
let pg: Prisma.TransactionClient

const seed = (...names: string[]) =>
  db.seed('userAttackSkill', names.map((name) => ({ userId: 'alice', name, content: 'x' })))

beforeEach(() => {
  db = createFakePrisma()
  pg = db as unknown as Prisma.TransactionClient
  seed('Recon basics', 'SQLi flow', 'SQLi flow v2')
  db.seed('userAttackSkill', [{ userId: 'bob', name: 'Bob only', content: 'x' }])
})

describe('checkNames', () => {
  test('keeps the order of the names and normalizes each', async () => {
    const results = await checkNames(pg, 'alice', ['  Zeta  ', 'Alpha', 'Bob only'])
    expect(results).toEqual([
      { normalized: 'Zeta', available: true, suggestion: null },
      { normalized: 'Alpha', available: true, suggestion: null },
      { normalized: 'Bob only', available: true, suggestion: null },
    ])
  })

  test('an empty name, a control character and an overlong name are refused without a suggestion', async () => {
    const results = await checkNames(pg, 'alice', ['   ', 'Bad\u200Bname', 'x'.repeat(101)])
    expect(results.map((r) => [r.available, r.reason, r.suggestion])).toEqual([
      [false, 'name_invalid', null],
      [false, 'name_invalid', null],
      [false, 'name_too_long', null],
    ])
  })

  test('a taken name (by case and spacing) is name_taken with a free suggestion', async () => {
    const [r] = await checkNames(pg, 'alice', ['recon   BASICS'])
    expect(r).toEqual({ normalized: 'recon BASICS', available: false, reason: 'name_taken', suggestion: 'recon BASICS v2' })
  })

  test('the later of two equal names in the batch is name_duplicate; the first stays available', async () => {
    const results = await checkNames(pg, 'alice', ['New Flow', 'other', 'new  FLOW'])
    expect(results[0]).toMatchObject({ available: true })
    expect(results[2]).toMatchObject({ available: false, reason: 'name_duplicate', suggestion: 'new FLOW v2' })
  })

  test('two duplicates of one name, and two rows taken by one stored name, get different suggestions', async () => {
    const dup = await checkNames(pg, 'alice', ['Twin', 'twin', 'TWIN'])
    expect(dup[1].suggestion).toBe('twin v2')
    expect(dup[2].suggestion).toBe('TWIN v3')

    const taken = await checkNames(pg, 'alice', ['Recon basics', 'recon basics'])
    expect(taken.map((r) => r.reason)).toEqual(['name_taken', 'name_duplicate'])
    expect(new Set(taken.map((r) => r.suggestion?.toLowerCase())).size).toBe(2)
  })

  test('a suggestion never equals another name of the batch or a stored name', async () => {
    const results = await checkNames(pg, 'alice', ['Recon basics', 'Recon basics v2', 'Recon basics v3'])
    expect(results[0].suggestion).toBe('Recon basics v4')
    seed('Alpha v2', 'Alpha v3')
    const [a] = await checkNames(pg, 'alice', ['Alpha', 'alpha'])
    expect(a.available).toBe(true)
    const second = (await checkNames(pg, 'alice', ['Alpha', 'alpha']))[1]
    expect(second.suggestion).toBe('alpha v4')
  })

  test('the family numbering is the one suggestVersionName gives a new upload', async () => {
    seed('X', 'X v2')
    const [r] = await checkNames(pg, 'alice', ['x'])
    expect(r.suggestion).toBe('x v3')
    expect((await suggestVersionName(pg, 'alice', { id: '', name: 'x', lineageRootId: null })).name).toBe('x v3')
  })

  test('with 1,000 stored skills and 50 taken names: one findMany and at most 4 raw queries', async () => {
    db = createFakePrisma()
    pg = db as unknown as Prisma.TransactionClient
    seed(...Array.from({ length: 1000 }, (_, i) => `Stored skill ${i}`))
    let reads = 0
    const skills = db.userAttackSkill as unknown as Record<string, (a: unknown) => Promise<unknown>>
    const findMany = skills.findMany
    skills.findMany = (a) => { reads++; return findMany(a) }
    const before = db.rawCalls.length

    const results = await checkNames(pg, 'alice', Array.from({ length: 50 }, (_, i) => `stored SKILL ${i}`))

    expect(results.every((r) => r.reason === 'name_taken' && r.suggestion)).toBe(true)
    expect(reads).toBe(1)
    expect(db.rawCalls.length - before).toBeLessThanOrEqual(4)
  })
})
