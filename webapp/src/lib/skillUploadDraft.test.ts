/**
 * The upload dialog's rows as plain data: every file problem, the metadata and its sources,
 * what blocks the upload, Generate with AI filling only empty fields (D7), a refusal mapped
 * back by the posted position, and the request built from the included rows only.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  CREDENTIALS_ERROR, appendFiles, applyGenerated, applyNameChecks, applyRefusal, blockingReason, buildRows,
  failNameChecks, generationTargets, initialRoom, setDescription, setName, summarize, uploadPayload, withFileName,
  type DraftRow, type PickedFile,
} from './skillUploadDraft'
import { MAX_CONTENT_SIZE } from './userSkills'

const keys = () => { let n = 0; return () => `r${++n}` }
const build = (files: PickedFile[], room = 50) => buildRows(files, { room, nextKey: keys() })
const md = (name: string, text: string): PickedFile => ({ name, text })

const FRONTMATTER = md('f01.md', '---\nname: SQLi Flow\ndescription: >\n  Tests SQL\n  injection.\n---\n# Other title\n')
const HEADING = md('f02.md', '# Heading Only\n\nBody.')
const PLAIN = md('f03_plain.md', '## Phase 1\n\nBody.')

function checked(rows: DraftRow[], state: 'available' = 'available') {
  return rows.map((r) => (r.nameCheck.state === 'checking' ? { ...r, nameCheck: { state, suggestion: null, reason: null } } : r))
}

describe('buildRows', () => {
  test.each([
    ['not_markdown', md('notes.txt', 'text')],
    ['empty', md('blank.md', '  \n\t ')],
    ['not_text', md('bin.md', '# T\u0000bytes')],
    ['not_text', { name: 'locked.md', text: '', unreadable: true }],
    ['too_large', md('huge.md', 'x'.repeat(MAX_CONTENT_SIZE + 1))],
  ])('%s: excluded, no content kept, cannot be included', (problem, file) => {
    const [row] = build([file])
    expect(row).toMatchObject({ problem, include: false, content: '', name: '', nameCheck: { state: 'idle' } })
    expect(uploadPayload([{ ...row, include: true }]).items).toEqual([])
  })

  test('valid rows past the room are over_skill_limit; problem rows do not use the room', () => {
    const rows = build([md('a.md', '# A'), md('bad.txt', 'x'), md('b.md', '# B'), md('c.md', '# C')], 2)
    expect(rows.map((r) => r.problem)).toEqual([null, 'not_markdown', null, 'over_skill_limit'])
    expect(initialRoom(990)).toBe(10)
    expect(initialRoom(0)).toBe(50)
    expect(initialRoom(1000)).toBe(0)
  })

  test('the metadata is wired in with its sources; nothing comes from the file name', () => {
    const [f, h, p] = build([FRONTMATTER, HEADING, PLAIN])
    expect(f).toMatchObject({
      name: 'SQLi Flow', nameSource: 'frontmatter', description: 'Tests SQL injection.', descriptionSource: 'frontmatter',
      nameCheck: { state: 'checking' }, include: true, touched: false, chars: FRONTMATTER.text.length,
    })
    expect(h).toMatchObject({ name: 'Heading Only', nameSource: 'heading', description: '', descriptionSource: null })
    expect(p).toMatchObject({ name: '', nameSource: null, nameCheck: { state: 'idle' } })
    expect(new Set([f.key, h.key, p.key]).size).toBe(3)
  })

  test('Use file name gives the stem, tagged file', () => {
    const [p] = build([PLAIN])
    expect(withFileName(p)).toMatchObject({ name: 'f03_plain', nameSource: 'file', nameCheck: { state: 'checking' }, touched: true })
  })
})

describe('appendFiles', () => {
  test('skips a file with the same name and text, keeps a same-named file with other text, stops at 50 rows', () => {
    const rows = build([HEADING])
    const next = appendFiles(rows, [HEADING, md('f02.md', '# Changed')], { existingCount: 0, nextKey: () => 'n1' })
    expect(next.skipped).toBe(1)
    expect(next.rows.map((r) => r.name)).toEqual(['Heading Only', 'Changed'])

    const full = build(Array.from({ length: 49 }, (_, i) => md(`x${i}.md`, `# X${i}`)))
    const cut = appendFiles(full, [md('y1.md', '# Y1'), md('y2.md', '# Y2')], { existingCount: 0, nextKey: keys() })
    expect(cut.rows).toHaveLength(50)
    expect(cut.cut).toBe(true)
  })

  test('the 1,000-skill cap counts the rows already in the dialog', () => {
    const rows = build([md('a.md', '# A'), md('b.md', '# B')])
    const next = appendFiles(rows, [md('c.md', '# C'), md('d.md', '# D')], { existingCount: 997, nextKey: keys() })
    expect(next.rows.map((r) => r.problem)).toEqual([null, null, null, 'over_skill_limit'])
  })
})

describe('blockingReason and summarize', () => {
  test('each reason, and none for an excluded or a checked row', () => {
    const [row] = checked(build([HEADING]))
    expect(blockingReason(row)).toBeNull()
    expect(blockingReason({ ...row, name: '  ' })).toBe('name_missing')
    expect(blockingReason({ ...row, nameCheck: { state: 'checking', suggestion: null, reason: null } })).toBe('name_checking')
    expect(blockingReason({ ...row, nameCheck: { state: 'taken', suggestion: 'x', reason: 'name_taken' } })).toBe('name_taken')
    expect(blockingReason({ ...row, nameCheck: { state: 'duplicate', suggestion: 'x', reason: 'name_duplicate' } })).toBe('name_duplicate')
    expect(blockingReason({ ...row, nameCheck: { state: 'invalid', suggestion: null, reason: 'name_invalid' } })).toBe('name_invalid')
    expect(blockingReason({ ...row, nameCheck: { state: 'error', suggestion: null, reason: null } })).toBeNull()
    expect(blockingReason({ ...row, name: '', include: false })).toBeNull()
  })

  test('counts files, included, ready, missing names and descriptions, problems', () => {
    const rows = checked(build([FRONTMATTER, HEADING, PLAIN, md('n.txt', 'x')]))
    expect(summarize(rows)).toEqual({ total: 4, included: 3, ready: 2, needName: 1, noDescription: 2, problems: 1 })
    expect(summarize([{ ...rows[0], include: false }, ...rows.slice(1)]).included).toBe(2)
  })
})

describe('edits', () => {
  test('a typed name is typed, rechecked, and clears the refusals', () => {
    const [row] = build([HEADING])
    const marked = { ...row, serverError: { code: 'name_taken', error: 'x' }, aiError: 'timeout' }
    expect(setName(marked, 'New')).toMatchObject({
      name: 'New', nameSource: 'typed', serverError: null, aiError: null, nameCheck: { state: 'checking' }, touched: true,
    })
    expect(setName(row, '').nameCheck.state).toBe('idle')
  })
})

describe('applyNameChecks', () => {
  test('maps the reasons to states by row key, with the suggestion', () => {
    const rows = build([HEADING, FRONTMATTER, md('c.md', '# C'), md('d.md', '# D')])
    const out = applyNameChecks(rows, [rows[0].key, rows[1].key, rows[2].key, rows[3].key], [
      { normalized: 'Heading Only', available: true, suggestion: null },
      { normalized: 'SQLi Flow', available: false, reason: 'name_taken', suggestion: 'SQLi Flow v2' },
      { normalized: 'C', available: false, reason: 'name_duplicate', suggestion: 'C v2' },
      { normalized: 'D', available: false, reason: 'name_too_long', suggestion: null },
    ])
    expect(out.map((r) => r.nameCheck.state)).toEqual(['available', 'taken', 'duplicate', 'invalid'])
    expect(out[1].nameCheck.suggestion).toBe('SQLi Flow v2')
  })

  test('a failed check marks the rows still waiting as error, which does not block', () => {
    const rows = build([HEADING, PLAIN])
    const out = failNameChecks(rows, [rows[0].key])
    expect(out[0].nameCheck.state).toBe('error')
    expect(blockingReason(out[0])).toBeNull()
    expect(out[1].nameCheck.state).toBe('idle')
  })
})

describe('applyGenerated (D7)', () => {
  test('fills only empty fields, tags them ai with the model, and never overwrites', () => {
    const [f, h, p] = build([FRONTMATTER, HEADING, PLAIN])
    const out = applyGenerated([f, h, p], [
      { key: f.key, name: 'AI name', description: 'AI desc' },
      { key: h.key, name: 'AI name 2', description: 'AI desc 2' },
      { key: p.key, name: 'AI name 3', description: 'AI desc 3' },
    ], 'claude-haiku-4-5')
    expect(out[0]).toEqual(f)
    expect(out[1]).toMatchObject({ name: 'Heading Only', nameSource: 'heading', description: 'AI desc 2', descriptionSource: 'ai', aiModel: 'claude-haiku-4-5', touched: true })
    expect(out[2]).toMatchObject({ name: 'AI name 3', nameSource: 'ai', description: 'AI desc 3', nameCheck: { state: 'checking' } })
  })

  test('a name the person typed while the request ran keeps its value', () => {
    const [p] = build([PLAIN])
    const typed = setName(p, 'Mine')
    const [out] = applyGenerated([typed], [{ key: p.key, name: 'AI name', description: 'AI desc' }], 'm')
    expect(out).toMatchObject({ name: 'Mine', nameSource: 'typed', description: 'AI desc', descriptionSource: 'ai' })
  })

  test('an item error is kept on the row; a credentials refusal is never a target again', () => {
    const [h, p] = build([HEADING, PLAIN])
    const out = applyGenerated([h, p], [{ key: h.key, error: 'timeout' }, { key: p.key, error: CREDENTIALS_ERROR }], null)
    expect(out.map((r) => r.aiError)).toEqual(['timeout', CREDENTIALS_ERROR])
    expect(out[1]).toMatchObject({ name: '', description: '', aiModel: null })
    expect(generationTargets(out).map((t) => t.key)).toEqual([h.key])
  })
})

describe('applyRefusal', () => {
  test('maps each refusal by its posted index, even when some rows were excluded', () => {
    const rows = checked(build([HEADING, md('x.txt', 'x'), FRONTMATTER, md('c.md', '# C')]))
    const excluded = rows.map((r, i) => (i === 2 ? { ...r, include: false } : r))
    const { keys: posted } = uploadPayload(excluded)
    expect(posted).toEqual([rows[0].key, rows[3].key])
    const out = applyRefusal(excluded, posted, [{ index: 1, code: 'name_taken', error: 'taken', suggestion: 'C v2' }])
    expect(out[3].serverError).toEqual({ code: 'name_taken', error: 'taken', suggestion: 'C v2' })
    expect(out.filter((r) => r.serverError)).toHaveLength(1)
  })
})

describe('uploadPayload', () => {
  test('only included rows without problems, a cleaned one-line description or null, the name as typed', () => {
    const rows = checked(build([HEADING, PLAIN, md('x.txt', 'x'), FRONTMATTER]))
    const edited = [setDescription(rows[0], ' Line one\n\nLine\u200B two '), setName(rows[1], '  spaced  '), rows[2], { ...rows[3], include: false }]
    expect(uploadPayload(edited).items).toEqual([
      { name: 'Heading Only', description: 'Line one Line two', content: HEADING.text, nameSource: 'heading', descriptionSource: 'typed', aiModel: null },
      { name: '  spaced  ', description: null, content: PLAIN.text, nameSource: 'typed', descriptionSource: null, aiModel: null },
    ])
  })

  test('carries the sources; aiModel only while a field is still ai', () => {
    const [p] = build([PLAIN])
    const [ai] = applyGenerated([p], [{ key: p.key, name: 'AI name', description: 'AI desc' }], 'gpt-5')
    expect(uploadPayload([ai]).items[0]).toMatchObject({ nameSource: 'ai', descriptionSource: 'ai', aiModel: 'gpt-5' })
    const nameTyped = setName(ai, 'Mine')
    expect(uploadPayload([nameTyped]).items[0]).toMatchObject({ nameSource: 'typed', descriptionSource: 'ai', aiModel: 'gpt-5' })
    const bothTyped = setDescription(nameTyped, 'Mine too')
    expect(uploadPayload([bothTyped]).items[0]).toMatchObject({ nameSource: 'typed', descriptionSource: 'typed', aiModel: null })
  })
})

describe('generationTargets', () => {
  test('included rows with an empty name and/or description, with the fields to write', () => {
    const [f, h, p, bad] = build([FRONTMATTER, HEADING, PLAIN, md('x.txt', 'x')])
    expect(generationTargets([f, h, p, bad, { ...p, key: 'off', include: false }])).toEqual([
      { key: h.key, fields: ['description'] },
      { key: p.key, fields: ['name', 'description'] },
    ])
  })
})
