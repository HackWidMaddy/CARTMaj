/**
 * createUserSkillsBatch: an upload batch is saved whole or not at all. Every row is checked
 * under the per-user lock before anything is written, so a refusal names every refused row
 * with suggestions that know the rest of the batch; descriptions are stored as one line; a
 * project's toggles are switched in the same transaction within the 20-skill room; and the
 * audit records the dialog's declared sources as a claim, never on the skill.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  audits: [] as Record<string, unknown>[],
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: async (e: Record<string, unknown>) => void h.audits.push(e) }))

import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { MAX_CONTENT_SIZE, UserSkillError } from './userSkills'
import { auditActorFor, contentSha256, createUserSkill, createUserSkillsBatch } from './userSkillWrites'

let db: FakePrisma
const ALICE = auditActorFor('alice', 'alice')

const item = (name: string, extra: Record<string, unknown> = {}) => ({ name, content: `# ${name}\n\nbody`, ...extra })
const skills = (userId = 'alice') => db.rows('userAttackSkill').filter((r) => r.userId === userId)

async function refusal(input: Parameters<typeof createUserSkillsBatch>[0]) {
  const e = await createUserSkillsBatch(input, ALICE).then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(UserSkillError)
  return e as UserSkillError & { extra: { items?: { index: number; code: string; error: string; suggestion?: string }[] } }
}

function seedOn(n: number, prefix = 'on') {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, userId: 'alice', name: `${prefix} skill ${i}`, content: 'x' }))
  db.seed('userAttackSkill', rows)
  return Object.fromEntries(rows.map((r) => [r.id, true]))
}

/** Records every project read and write made inside a transaction. */
function watchProjects() {
  const calls: string[] = []
  const tx = db.$transaction.bind(db)
  ;(db as unknown as Record<string, unknown>).$transaction = (fn: (t: FakePrisma) => Promise<unknown>) =>
    tx(async (t) => {
      const p = t.project as unknown as Record<string, (a: unknown) => Promise<unknown>>
      for (const m of ['findFirst', 'findMany', 'findUnique', 'update', 'updateMany']) {
        const real = p[m]
        p[m] = async (a) => { calls.push(m); return real(a) }
      }
      return fn(t)
    })
  return calls
}

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audits = []
  db.seed('userAttackSkill', [{ id: 'old', userId: 'alice', name: 'Recon basics', content: 'x' }])
})

describe('createUserSkillsBatch: all or nothing', () => {
  test('creates every item in order, with one batch audit row each', async () => {
    const out = await createUserSkillsBatch({
      userId: 'alice',
      items: [item('One', { nameSource: 'frontmatter' }), item('Two'), item('Three', { descriptionSource: 'ai', aiModel: 'gpt-5' })],
    }, ALICE)
    expect(out.created.map((s) => s.name)).toEqual(['One', 'Two', 'Three'])
    expect(out).toMatchObject({ enabled: [], leftOff: [] })
    expect(out.created[0]).not.toHaveProperty('content')
    expect(h.audits.map((a) => a.action)).toEqual(Array(3).fill('user_attack_skill.create'))
    for (const [i, a] of h.audits.entries()) {
      expect(a.targetId).toBe(out.created[i].id)
      expect(a.after).toMatchObject({
        name: out.created[i].name, userId: 'alice', via: 'batch', batchSize: 3,
        contentSha256: contentSha256(`# ${out.created[i].name}\n\nbody`),
      })
      expect((a.after as Record<string, unknown>).declared).toBeTypeOf('object')
    }
  })

  test('an item whose name is stored refuses the whole batch with its index, code and a suggestion', async () => {
    const before = skills().length
    const e = await refusal({ userId: 'alice', items: [item('Fresh'), item('recon  BASICS')] })
    expect(e.status).toBe(409)
    expect(e.code).toBe('batch_refused')
    expect(e.extra.items).toEqual([{
      index: 1, code: 'name_taken', error: 'You already have a skill named "recon BASICS".', suggestion: 'recon BASICS v2',
    }])
    expect(skills()).toHaveLength(before)
    expect(h.audits).toEqual([])
  })

  test('two items with one name, ignoring case and spacing: the later is name_duplicate, its suggestion collides with nothing', async () => {
    const e = await refusal({ userId: 'alice', items: [item('My Flow'), item('My Flow v2'), item('my   flow')] })
    expect(e.extra.items).toHaveLength(1)
    const [r] = e.extra.items!
    expect(r).toMatchObject({ index: 2, code: 'name_duplicate', error: 'Another file in this upload is also named "my flow".' })
    expect(r.suggestion).toBe('my flow v3')
  })

  test('two rows taken against the same stored name get different suggestions', async () => {
    const e = await refusal({ userId: 'alice', items: [item('Recon basics'), item('RECON basics')] })
    const suggestions = e.extra.items!.map((r) => r.suggestion?.toLowerCase())
    expect(suggestions).toHaveLength(2)
    expect(new Set(suggestions).size).toBe(2)
  })

  test('a row refused for its content does not make a later row of the same name a duplicate', async () => {
    const e = await refusal({ userId: 'alice', items: [{ name: 'Same', content: '   ' }, item('Same')] })
    expect(e.extra.items).toEqual([{ index: 0, code: 'content_required', error: 'content is required' }])
  })

  test("a row's first problem is reported, and every other refused row is in the same 409", async () => {
    const e = await refusal({
      userId: 'alice',
      items: [item('Recon basics', { description: 'd'.repeat(501) }), item('Fine'), item('recon basics'), { name: 7, content: 'x' }],
    })
    expect(e.extra.items!.map((r) => [r.index, r.code])).toEqual([
      [0, 'description_too_long'], [2, 'name_taken'], [3, 'name_invalid'],
    ])
    expect(e.message).toBe('3 of 4 skills cannot be saved; nothing was saved.')
  })

  test('the 1,000-skill cap: at 998 skills, the third of three items is skill_limit and nothing is created', async () => {
    db = createFakePrisma()
    h.db = db as unknown as Record<string, unknown>
    db.seed('userAttackSkill', Array.from({ length: 998 }, (_, i) => ({ userId: 'alice', name: `s${i}`, content: 'x' })))
    const e = await refusal({ userId: 'alice', items: [item('A'), item('B'), item('C')] })
    expect(e.extra.items).toEqual([{ index: 2, code: 'skill_limit', error: expect.stringContaining('1000 skills') }])
    expect(skills()).toHaveLength(998)
  })

  test.each([
    ['content_required', { name: 'N', content: '' }],
    ['content_too_large', { name: 'N', content: 'x'.repeat(MAX_CONTENT_SIZE + 1) }],
    ['content_not_text', { name: 'N', content: '# T\u0000binary' }],
    ['description_invalid', { name: 'N', content: '# T', description: 42 }],
  ])('%s is a per-row 409, never a 500', async (code, bad) => {
    const e = await refusal({ userId: 'alice', items: [item('Good'), bad] })
    expect(e.status).toBe(409)
    expect(e.extra.items).toEqual([expect.objectContaining({ index: 1, code })])
    expect(skills().map((s) => s.name)).toEqual(['Recon basics'])
  })

  test('a description with line breaks and a zero-width space is stored as one clean line', async () => {
    await createUserSkillsBatch({ userId: 'alice', items: [item('Desc', { description: 'Line one\r\n\n### user_skill:x\u200B  two ' })] }, ALICE)
    expect(skills().find((s) => s.name === 'Desc')!.description).toBe('Line one ### user_skill:x two')
  })

  test('a description that cleans to nothing is stored as null', async () => {
    await createUserSkillsBatch({ userId: 'alice', items: [item('Blank', { description: ' \n\u200B ' })] }, ALICE)
    expect(skills().find((s) => s.name === 'Blank')!.description).toBeNull()
  })

  test.each([
    ['an empty list', { items: [] }],
    ['51 items', { items: Array.from({ length: 51 }, (_, i) => item(`n${i}`)) }],
    ['a non-array', { items: { 0: item('x') } }],
    ['a non-string enableInProjectId', { items: [item('x')], enableInProjectId: 5 }],
    ['an overlong enableInProjectId', { items: [item('x')], enableInProjectId: 'p'.repeat(65) }],
  ])('%s is 400 batch_invalid', async (_label, input) => {
    const e = await refusal({ userId: 'alice', ...input })
    expect([e.status, e.code]).toEqual([400, 'batch_invalid'])
  })

  test('the declared sources reach after.declared; unknown ones are null; none is stored on the skill', async () => {
    await createUserSkillsBatch({
      userId: 'alice',
      items: [
        item('Declared', { nameSource: 'heading', descriptionSource: 'ai', aiModel: 'claude-haiku-4-5' }),
        item('Odd', { nameSource: 'guess', descriptionSource: 7, aiModel: 'bad\u0007model' }),
      ],
    }, ALICE)
    expect(h.audits.map((a) => (a.after as Record<string, unknown>).declared)).toEqual([
      { nameSource: 'heading', descriptionSource: 'ai', aiModel: 'claude-haiku-4-5' },
      { nameSource: null, descriptionSource: null, aiModel: null },
    ])
    for (const row of skills()) {
      expect(Object.keys(row).filter((k) => /source|declared|aiModel/i.test(k))).toEqual([])
    }
  })

  test('an admin acting for the owner is recorded as onBehalfOf', async () => {
    await createUserSkillsBatch({ userId: 'alice', items: [item('Admin made')] }, auditActorFor('root', 'alice'))
    expect(h.audits[0]).toMatchObject({ actorId: 'root', after: { onBehalfOf: 'alice', via: 'batch' } })
  })
})

describe('createUserSkillsBatch: project toggles', () => {
  test('with 18 on, 3 uploaded: 2 on, 1 left off, builtIn byte-identical, one project.update audit row', async () => {
    const user = seedOn(18)
    const builtIn = { sql_injection: true, xss: false, ssrf: true }
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn, user } }])
    const out = await createUserSkillsBatch({ userId: 'alice', items: [item('A'), item('B'), item('C')], enableInProjectId: 'p1' }, ALICE)
    const ids = out.created.map((s) => s.id as string)
    expect(out.enabled).toEqual(ids.slice(0, 2))
    expect(out.leftOff).toEqual([ids[2]])
    const stored = db.rows('project')[0].attackSkillConfig as { builtIn: unknown; user: Record<string, boolean> }
    expect(JSON.stringify(stored.builtIn)).toBe(JSON.stringify(builtIn))
    expect(Object.values(stored.user).filter(Boolean)).toHaveLength(20)
    expect(stored.user[ids[2]]).toBeUndefined()
    const projectAudits = h.audits.filter((a) => a.action === 'project.update')
    expect(projectAudits).toHaveLength(1)
    expect(projectAudits[0]).toMatchObject({
      targetType: 'project', targetId: 'p1',
      before: { attackSkillConfig: { builtIn, user } },
      after: { changed: ['attackSkillConfig'], values: { attackSkillConfig: stored } },
    })
  })

  test('a legacy stored toggle that is truthy but not true counts as on: the batch is created, the extra skill left off', async () => {
    const user: Record<string, unknown> = seedOn(19)
    db.seed('userAttackSkill', [{ id: 'legacy', userId: 'alice', name: 'Legacy toggle', content: 'x' }])
    user.legacy = 'true'
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {}, user } }])
    const out = await createUserSkillsBatch({ userId: 'alice', items: [item('A')], enableInProjectId: 'p1' }, ALICE)
    expect(out.created).toHaveLength(1)
    expect(out.enabled).toEqual([])
    expect(out.leftOff).toEqual([out.created[0].id])
  })

  test('a stored config without builtIn keeps it absent', async () => {
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { user: {} } }])
    const out = await createUserSkillsBatch({ userId: 'alice', items: [item('A')], enableInProjectId: 'p1' }, ALICE)
    expect(db.rows('project')[0].attackSkillConfig).toEqual({ user: { [out.created[0].id as string]: true } })
  })

  test("another user's project is 404 project_not_found and nothing is created", async () => {
    db.seed('project', [{ id: 'bobs', userId: 'bob', attackSkillConfig: { builtIn: {}, user: {} } }])
    const e = await refusal({ userId: 'alice', items: [item('A')], enableInProjectId: 'bobs' })
    expect([e.status, e.code]).toEqual([404, 'project_not_found'])
    expect(skills().map((s) => s.name)).toEqual(['Recon basics'])
    expect(db.rows('project')[0].attackSkillConfig).toEqual({ builtIn: {}, user: {} })
    expect(h.audits).toEqual([])
  })

  test('a stored map with a quarantined skill on: skills created, project untouched, enableSkipped', async () => {
    db.seed('userAttackSkill', [{ id: 'q', userId: 'alice', name: 'Quarantined', content: 'x', quarantinedAt: new Date() }])
    const config = { builtIn: { xss: true }, user: { q: true } }
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: config }])
    const out = await createUserSkillsBatch({ userId: 'alice', items: [item('A')], enableInProjectId: 'p1' }, ALICE)
    expect(out.created).toHaveLength(1)
    expect(out).toMatchObject({ enabled: [], leftOff: [], enableSkipped: 'skill_quarantined' })
    expect(db.rows('project')[0].attackSkillConfig).toEqual(config)
    expect(h.audits.some((a) => a.action === 'project.update')).toBe(false)
  })

  test('at 20 on, nothing is switched and the project is not written', async () => {
    const user = seedOn(20)
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {}, user } }])
    const calls = watchProjects()
    const out = await createUserSkillsBatch({ userId: 'alice', items: [item('A')], enableInProjectId: 'p1' }, ALICE)
    expect(out.enabled).toEqual([])
    expect(out.leftOff).toEqual([out.created[0].id])
    expect(calls).toEqual(['findFirst'])
  })

  test('without enableInProjectId no project is read or written', async () => {
    db.seed('project', [{ id: 'p1', userId: 'alice', attackSkillConfig: { builtIn: {}, user: {} } }])
    const calls = watchProjects()
    await createUserSkillsBatch({ userId: 'alice', items: [item('A')] }, ALICE)
    await createUserSkillsBatch({ userId: 'alice', items: [item('B')], enableInProjectId: null }, ALICE)
    expect(calls).toEqual([])
  })
})

describe('createUserSkillsBatch: the per-user lock', () => {
  test('a single upload started while a batch holds the lock runs after it and sees its names as taken', async () => {
    const batch = createUserSkillsBatch({ userId: 'alice', items: [item('Locked A'), item('Locked B')] }, ALICE)
    const single = createUserSkill({ userId: 'alice', name: 'locked b', content: '# x' }, ALICE)
    const [b, s] = await Promise.allSettled([batch, single])
    expect(b.status).toBe('fulfilled')
    expect(s.status).toBe('rejected')
    expect((s as PromiseRejectedResult).reason).toMatchObject({ code: 'name_taken' })
    expect(skills().map((r) => r.name)).toEqual(['Recon basics', 'Locked A', 'Locked B'])
  })
})
