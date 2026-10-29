/**
 * A skill file's declared name and description (frontmatter, then the first H1 for the name,
 * else empty), and the tidying every extracted or AI-written value goes through.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  cleanSkillText, fileNameAsSkillName, readFrontmatter, readSkillMetadata, tidySkillDescription, tidySkillName,
} from './skillMetadata'

const md = (...lines: string[]) => lines.join('\n')

describe('readSkillMetadata', () => {
  test('no frontmatter: the name comes from the H1 and the description is empty', () => {
    expect(readSkillMetadata(md('# SQL Injection Flow', '', 'Body text.'))).toEqual({
      name: 'SQL Injection Flow', nameFrom: 'heading', description: '', descriptionFrom: null,
      nameShortened: false, descriptionShortened: false,
    })
  })

  test('plain name and description', () => {
    const meta = readSkillMetadata(md('---', 'name: My Flow', 'description: Tests login forms.', '---', '# Other'))
    expect(meta).toMatchObject({
      name: 'My Flow', nameFrom: 'frontmatter', description: 'Tests login forms.', descriptionFrom: 'frontmatter',
    })
  })

  test("single quotes ('' is a quote), double-quote escapes, # kept inside quotes, # comment cut after a plain value", () => {
    expect(readFrontmatter(md('---', "name: 'It''s #1'", '---'))!.fields.name).toBe("It's #1")
    expect(readFrontmatter(md('---', 'name: "Say \\"hi\\" \\\\ #2" # c', '---'))!.fields.name).toBe('Say "hi" \\ #2')
    expect(readFrontmatter(md('---', 'description: "a\\tb\\nc"', '---'))!.fields.description).toBe('a\tb\nc')
    expect(readFrontmatter(md('---', 'name: Plain value # a comment', '---'))!.fields.name).toBe('Plain value')
    expect(readFrontmatter(md('---', 'name: C#sharp', '---'))!.fields.name).toBe('C#sharp')
  })

  test('a folded description over several lines is one paragraph, and metadata children never leak', () => {
    const content = md(
      '---',
      'name: add-community-skill',
      'description: >',
      '  Adding a Community Agent Skill: a Markdown attack-workflow file that users',
      '  import from the catalog, which then competes in the Intent Router.',
      '  Trigger: adding or editing a .md workflow.',
      'license: MIT',
      'metadata:',
      '  author: CART',
      '  description: not this one',
      '  version: "1.0.0"',
      '---',
      '# Heading',
    )
    expect(readFrontmatter(content)!.fields).toEqual({
      name: 'add-community-skill',
      description: 'Adding a Community Agent Skill: a Markdown attack-workflow file that users '
        + 'import from the catalog, which then competes in the Intent Router. Trigger: adding or editing a .md workflow.',
    })
  })

  test('a | literal keeps its newlines, and tidying turns them into spaces', () => {
    const content = md('---', 'description: |-', '  Line one', '  Line two', '', 'name: N', '---')
    expect(readFrontmatter(content)!.fields.description).toBe('Line one\nLine two')
    expect(readSkillMetadata(content).description).toBe('Line one Line two')
  })

  test('a BOM before the opening line, and CRLF line endings', () => {
    const content = '\uFEFF---\r\nname: Bom Flow\r\ndescription: >\r\n  Folded\r\n  text\r\n---\r\n# H\r\n'
    expect(readSkillMetadata(content)).toMatchObject({ name: 'Bom Flow', description: 'Folded text' })
  })

  test('an unclosed block, or one longer than 60 lines, is no frontmatter: the heading is searched from line 0', () => {
    const unclosed = md('---', 'name: Never Read', '# Real Title', 'text')
    expect(readFrontmatter(unclosed)).toBeNull()
    expect(readSkillMetadata(unclosed)).toMatchObject({ name: 'Real Title', nameFrom: 'heading', description: '' })

    const long = md('---', 'name: Too Far', ...Array.from({ length: 60 }, (_, i) => `k${i}: v`), '---', '# After')
    expect(readFrontmatter(long)).toBeNull()
    expect(readSkillMetadata(long).name).toBe('After')

    const wide = md('---', `name: ${'x'.repeat(8100)}`, '---', '# Wide')
    expect(readFrontmatter(wide)).toBeNull()
  })

  test('an empty frontmatter name falls back to the heading', () => {
    expect(readSkillMetadata(md('---', 'name:', 'description: D', '---', '# From Heading'))).toMatchObject({
      name: 'From Heading', nameFrom: 'heading', description: 'D',
    })
    expect(readSkillMetadata(md('---', 'name: ~', '---', '# Null Name')).name).toBe('Null Name')
  })

  test('name: null followed by a blank line is still no name, so the heading is used', () => {
    expect(readSkillMetadata(md('---', 'name: null', '', 'description: D', '---', '# From Heading'))).toMatchObject({
      name: 'From Heading', nameFrom: 'heading', description: 'D',
    })
  })

  test('a heading line of 49,000 spaces or brackets is read in linear time, not seconds', () => {
    const started = performance.now()
    expect(readSkillMetadata(`# a${' '.repeat(49_000)}b`).name).toBe('a b')
    readSkillMetadata(`# ${'['.repeat(49_000)}`)
    expect(performance.now() - started).toBeLessThan(250)
  })

  test('an H1 in a fence is ignored, #tag and ## are not level 1, a setext ===== title is', () => {
    expect(readSkillMetadata(md('```bash', '# not a heading', '```', '#tag', '## Sub', '# Real')).name).toBe('Real')
    expect(readSkillMetadata(md('~~~', '# inside', '~~~', 'Setext Title', '=====', '# Later')).name).toBe('Setext Title')
    expect(readSkillMetadata(md('## Only Sub', '#tag only', 'text')).name).toBe('')
    expect(readSkillMetadata(md('# Closed ATX #')).name).toBe('Closed ATX')
  })

  test('inline markdown in the heading is stripped', () => {
    expect(readSkillMetadata('# **Bold** __under__ `code` and [a link](https://example.com)').name)
      .toBe('Bold under code and a link')
  })

  test('a 150-character name is shortened at a code point, never splitting an emoji, and flagged', () => {
    const name = `${'a'.repeat(99)}😀${'b'.repeat(49)}`
    const meta = readSkillMetadata(md('---', `name: ${name}`, '---'))
    expect(meta.nameShortened).toBe(true)
    expect(meta.name).toBe('a'.repeat(99))
    expect(tidySkillName('a'.repeat(98) + '😀' + 'b'.repeat(10)).value).toBe('a'.repeat(98) + '😀')
  })

  test('a 700-character description is cut at a space at or before 500, and flagged', () => {
    const words = Array.from({ length: 88 }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ')
    const meta = readSkillMetadata(md('---', `description: ${words}`, '---'))
    expect(words.length).toBeGreaterThan(700)
    expect(meta.descriptionShortened).toBe(true)
    expect(meta.description.length).toBeLessThanOrEqual(500)
    expect(words.startsWith(meta.description)).toBe(true)
    expect(words[meta.description.length]).toBe(' ')
    expect(tidySkillDescription('x'.repeat(700))).toEqual({ value: 'x'.repeat(500), shortened: true })
  })

  test('a zero-width space and a bidi control in a name are removed', () => {
    expect(readSkillMetadata('# Zero\u200Bwidth \u202EBidi').name).toBe('Zerowidth Bidi')
  })

  test('fileNameAsSkillName drops a .md or .markdown extension, any case', () => {
    expect(fileNameAsSkillName('sqli_exploitation.md')).toBe('sqli_exploitation')
    expect(fileNameAsSkillName('sqli_exploitation.MARKDOWN')).toBe('sqli_exploitation')
    expect(fileNameAsSkillName(`${'n'.repeat(120)}.md`)).toHaveLength(100)
  })

  test('cleanSkillText makes one clean line and is idempotent', () => {
    const once = cleanSkillText('a\r\nb\u200B c\u0000')
    expect(once).toBe('a b c')
    expect(cleanSkillText(once)).toBe(once)
    expect(cleanSkillText('tab\there')).toBe('tab here')
  })
})
