/**
 * The name and description a skill file declares for itself, read when it is uploaded.
 *
 * The convention is the YAML-style frontmatter block skill files already use elsewhere (the
 * repository's own `skills/` rulesets): `name:` and `description:` between `---` lines at the top. The
 * name falls back to the file's first level-1 heading, and is otherwise empty: never the
 * file name, so "Generate with AI" can fill it and the person sees that nothing was found.
 * The description comes from the frontmatter only. With none, the Intent Router already
 * reads the first 500 characters of the skill, so copying a first paragraph would add
 * nothing and would stop the AI from writing a real one.
 *
 * The block stays in the stored text: the agent runs the bytes the person uploaded, and
 * after the upload the database's name and description are the truth.
 *
 * A small reader, not a YAML parser (the webapp carries no YAML dependency): it reads only
 * the two top-level scalars, in the forms skill authors write them. Client-safe, and also
 * the server's description rule (cleanSkillText), so it uses no browser API.
 */
import { DESCRIPTION_MAX_CHARS, NAME_MAX_CHARS } from './userSkills'

export type NameSource = 'frontmatter' | 'heading'

export interface SkillFileMetadata {
  name: string
  nameFrom: NameSource | null
  description: string
  descriptionFrom: 'frontmatter' | null
  nameShortened: boolean
  descriptionShortened: boolean
}

// A block that does not close this early is an ordinary `---` rule, not frontmatter.
const FRONTMATTER_MAX_LINES = 60
const FRONTMATTER_MAX_CHARS = 8000
const HEADING_SEARCH_LINES = 200

const OPENER = /^\uFEFF?---[ \t]*$/
const CLOSER = /^(?:---|\.\.\.)[ \t]*$/
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):(.*)$/
const BLOCK_INDICATOR = /^([|>])[+-]?[1-9]?[+-]?[ \t]*(?:#.*)?$/
const INDENTED = /^[ \t]/

const splitLines = (text: string) => text.split(/\r?\n/)

function cutComment(plain: string): string {
  if (plain.startsWith('#')) return ''
  const m = /[ \t]#/.exec(plain)
  return (m ? plain.slice(0, m.index) : plain).trim()
}

/** Indented continuation lines folded the YAML way: a blank line is a break, others a space. */
function fold(lines: string[]): string {
  let out = ''
  let pendingBreak = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      pendingBreak = true
      continue
    }
    out += out ? (pendingBreak ? '\n' : ' ') + line : line
    pendingBreak = false
  }
  return out
}

function blockScalar(style: string, lines: string[]): string {
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  const body = lines.slice(0, end)
  if (style === '>') return fold(body)
  const first = body.find((l) => l.trim())
  if (first === undefined) return ''
  const indent = /^[ \t]*/.exec(first)![0].length
  return body.map((l) => (l.trim() ? l.slice(Math.min(indent, /^[ \t]*/.exec(l)![0].length)) : '')).join('\n')
}

function quoted(text: string, quote: '"' | "'"): string {
  let out = ''
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'"
          i++
          continue
        }
        break
      }
      out += ch
      continue
    }
    if (ch === '"') break
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[++i]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === '"' || next === '\\' ? next : `\\${next}`
      continue
    }
    out += ch
  }
  return out
}

function scalar(rest: string, continuation: string[]): string {
  const head = rest.trim()
  const block = BLOCK_INDICATOR.exec(head)
  if (block) return blockScalar(block[1], continuation)
  if (head.startsWith('"') || head.startsWith("'")) {
    return quoted(fold([head, ...continuation]), head[0] as '"' | "'")
  }
  const first = cutComment(head)
  // An explicit YAML null is "no value", not the word.
  if (continuation.every((l) => !l.trim()) && /^(?:~|null)$/i.test(first)) return ''
  return fold([first, ...continuation.map((l) => cutComment(l.trim()))])
}

/** The `name` / `description` scalars of a leading frontmatter block, and the line after it; null when there is none. */
export function readFrontmatter(
  content: string,
): { fields: Partial<Record<'name' | 'description', string>>; bodyStart: number } | null {
  const lines = splitLines(content.slice(0, FRONTMATTER_MAX_CHARS + 1))
  if (!OPENER.test(lines[0] ?? '')) return null
  let close = -1
  let chars = lines[0].length + 1
  for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
    chars += lines[i].length
    if (chars > FRONTMATTER_MAX_CHARS) break
    if (CLOSER.test(lines[i])) {
      close = i
      break
    }
    chars += 1
  }
  if (close < 0) return null

  const fields: Partial<Record<'name' | 'description', string>> = {}
  for (let i = 1; i < close; ) {
    const key = TOP_LEVEL_KEY.exec(lines[i])
    let j = i + 1
    while (j < close && (INDENTED.test(lines[j]) || !lines[j].trim())) j++
    if (key && (key[1] === 'name' || key[1] === 'description')) {
      fields[key[1]] = scalar(key[2], lines.slice(i + 1, j))
    }
    i = j
  }
  return { fields, bodyStart: close + 1 }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ATX_ANY = /^ {0,3}#{1,6}(?:[ \t]|$)/
// Greedy, with the closing sequence removed by atxText: a lazy capture followed by optional
// trailing groups backtracks quadratically, seconds on one 50 KB line of spaces.
const ATX_H1 = /^ {0,3}#(?!#)[ \t]+(.*)$/
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/

/** An ATX heading's text without trailing spaces and its closing `#` run (which needs a space before it, so "C#" stays). */
function atxText(rest: string): string {
  let end = rest.length
  while (end > 0 && (rest[end - 1] === ' ' || rest[end - 1] === '\t')) end--
  let hashes = end
  while (hashes > 0 && rest[hashes - 1] === '#') hashes--
  if (hashes < end && hashes > 0 && (rest[hashes - 1] === ' ' || rest[hashes - 1] === '\t')) end = hashes
  return rest.slice(0, end)
}

function stripInline(text: string): string {
  return text
    // `[^[\]]`, not `[^\]]`: each attempt then stops at the next "[" instead of rescanning a
    // long run of them to the end of the line.
    .replace(/\[([^[\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
}

/** The text of the first level-1 heading from line `start`, outside fenced code. */
function firstHeading(lines: string[], start: number): string {
  let fence: { char: string; len: number } | null = null
  const end = Math.min(lines.length, start + HEADING_SEARCH_LINES)
  for (let i = start; i < end; i++) {
    const line = i === 0 ? lines[i].replace(/^\uFEFF/, '') : lines[i]
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && !line.slice(f[0].length).trim()) fence = null
      continue
    }
    if (f) {
      fence = { char: f[1][0], len: f[1].length }
      continue
    }
    const atx = ATX_H1.exec(line)
    if (atx) {
      const text = stripInline(atxText(atx[1])).trim()
      if (text) return text
      continue
    }
    if (line.trim() && !ATX_ANY.test(line) && !/^ {4}/.test(line) && i + 1 < end && SETEXT_H1.test(lines[i + 1])) {
      return stripInline(line.trim())
    }
  }
  return ''
}

/** NFC; line breaks to spaces; `\p{Cc}\p{Cf}\p{Co}\p{Cs}` removed; whitespace collapsed; trimmed. No length cut. */
export function cleanSkillText(raw: string): string {
  return raw
    .normalize('NFC')
    // Breaks and tabs become spaces BEFORE the control characters go, so words never glue.
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** At most `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
function cutAtCodePoint(text: string, max: number): string {
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

export function tidySkillName(raw: string): { value: string; shortened: boolean } {
  const value = cleanSkillText(raw)
  if (value.length <= NAME_MAX_CHARS) return { value, shortened: false }
  return { value: cutAtCodePoint(value, NAME_MAX_CHARS).trimEnd(), shortened: true }
}

export function tidySkillDescription(raw: string): { value: string; shortened: boolean } {
  const value = cleanSkillText(raw)
  if (value.length <= DESCRIPTION_MAX_CHARS) return { value, shortened: false }
  const space = value.lastIndexOf(' ', DESCRIPTION_MAX_CHARS)
  const cut = space > 0 ? value.slice(0, space) : cutAtCodePoint(value, DESCRIPTION_MAX_CHARS)
  return { value: cut.trimEnd(), shortened: true }
}

/** The old single-upload default: the file name without `.md` / `.markdown`, tidied. */
export function fileNameAsSkillName(fileName: string): string {
  return tidySkillName(fileName.replace(/\.(?:md|markdown)$/i, '')).value
}

export function readSkillMetadata(content: string): SkillFileMetadata {
  const fm = readFrontmatter(content)
  const declaredName = tidySkillName(fm?.fields.name ?? '')
  const description = tidySkillDescription(fm?.fields.description ?? '')
  const heading = declaredName.value ? null : tidySkillName(firstHeading(splitLines(content), fm?.bodyStart ?? 0))
  const name = heading ?? declaredName
  return {
    name: name.value,
    nameFrom: declaredName.value ? 'frontmatter' : heading?.value ? 'heading' : null,
    description: description.value,
    descriptionFrom: description.value ? 'frontmatter' : null,
    nameShortened: name.shortened,
    descriptionShortened: description.shortened,
  }
}
