/**
 * The rows of the skill upload dialog, as plain data: built from the picked files, edited by
 * the person, filled by Generate with AI, marked by the name check and by a refused upload,
 * and turned into the batch request.
 *
 * Pure and client-safe: it imports only the shared limits and the metadata reader, never
 * userSkillNames or userSkillWrites, which load the Prisma runtime.
 */
import { cleanSkillText, fileNameAsSkillName, readSkillMetadata } from './skillMetadata'
import {
  MAX_CONTENT_SIZE, MAX_SKILLS_PER_BATCH, MAX_SKILLS_PER_USER,
  type BatchItemRefusal, type NameCheckResult,
} from './userSkills'

export type RowProblem = 'not_markdown' | 'empty' | 'not_text' | 'too_large' | 'over_skill_limit'
export type FieldSource = 'frontmatter' | 'heading' | 'file' | 'ai' | 'typed'
export type NameCheckState = 'idle' | 'checking' | 'available' | 'taken' | 'duplicate' | 'invalid' | 'error'
export type BlockingReason = 'name_missing' | 'name_checking' | 'name_taken' | 'name_duplicate' | 'name_invalid'

export interface DraftRow {
  /** Stable id for React and the AI request: a counter, never the file name. */
  key: string
  fileName: string
  chars: number
  /** '' when the row has a problem. */
  content: string
  problem: RowProblem | null
  include: boolean
  name: string
  nameSource: FieldSource | null
  nameShortened: boolean
  description: string
  descriptionSource: FieldSource | null
  descriptionShortened: boolean
  nameCheck: { state: NameCheckState; suggestion: string | null; reason: string | null }
  serverError: { code: string; error: string; suggestion?: string } | null
  aiError: string | null
  /** The model that wrote a field still marked `ai`; declared in the audit, never stored on the skill. */
  aiModel: string | null
  /** Edited or AI-filled: closing the dialog asks first. */
  touched: boolean
}

export interface PickedFile {
  name: string
  text: string
  /** The browser could not read it. */
  unreadable?: boolean
}

/** An AI answer for one row (the generate-metadata route). */
export interface GeneratedItem { key: string; name?: string; description?: string; error?: string }

export const CREDENTIALS_ERROR = 'skill_contains_credentials'

const MARKDOWN_FILE = /\.(?:md|markdown)$/i

function fileProblem(file: PickedFile): RowProblem | null {
  if (!MARKDOWN_FILE.test(file.name)) return 'not_markdown'
  if (file.unreadable || file.text.includes('\u0000')) return 'not_text'
  if (!file.text.trim()) return 'empty'
  if (file.text.length > MAX_CONTENT_SIZE) return 'too_large'
  return null
}

const IDLE = { state: 'idle' as const, suggestion: null, reason: null }
const CHECKING = { state: 'checking' as const, suggestion: null, reason: null }

const hasAiField = (r: Pick<DraftRow, 'nameSource' | 'descriptionSource'>) => r.nameSource === 'ai' || r.descriptionSource === 'ai'
const usable = (r: DraftRow) => r.include && !r.problem

/**
 * One row per file, in order. `room` is how many more skills may be created: the valid rows
 * past it are marked over the limit. The caller has already cut the selection to the batch size.
 */
export function buildRows(files: PickedFile[], opts: { room: number; nextKey: () => string }): DraftRow[] {
  let valid = 0
  return files.map((file) => {
    let problem = fileProblem(file)
    if (!problem && valid++ >= opts.room) problem = 'over_skill_limit'
    const meta = problem ? null : readSkillMetadata(file.text)
    return {
      key: opts.nextKey(),
      fileName: file.name,
      chars: file.text.length,
      content: problem ? '' : file.text,
      problem,
      include: !problem,
      name: meta?.name ?? '',
      nameSource: meta?.nameFrom ?? null,
      nameShortened: meta?.nameShortened ?? false,
      description: meta?.description ?? '',
      descriptionSource: meta?.descriptionFrom ?? null,
      descriptionShortened: meta?.descriptionShortened ?? false,
      nameCheck: meta?.name ? CHECKING : IDLE,
      serverError: null,
      aiError: null,
      aiModel: null,
      touched: false,
    }
  })
}

/** How many of the picked files may become skills: the batch size, and the user's cap. */
export function initialRoom(existingCount: number): number {
  return Math.max(0, Math.min(MAX_SKILLS_PER_BATCH, MAX_SKILLS_PER_USER - existingCount))
}

/**
 * Rows for files added to an open batch: at most up to the batch size, a file with the same
 * name and text as a row already there skipped, the cap counted with the rows already held.
 */
export function appendFiles(
  rows: DraftRow[],
  files: PickedFile[],
  opts: { existingCount: number; nextKey: () => string },
): { rows: DraftRow[]; skipped: number; cut: boolean } {
  const same = (name: string, text: string) => JSON.stringify([name, text])
  const known = new Set(rows.map((r) => same(r.fileName, r.problem ? String(r.chars) : r.content)))
  const fresh = files.filter((f) => !known.has(same(f.name, fileProblem(f) ? String(f.text.length) : f.text)))
  const free = Math.max(0, MAX_SKILLS_PER_BATCH - rows.length)
  const taken = fresh.slice(0, free)
  const held = rows.filter((r) => !r.problem).length
  const room = Math.max(0, MAX_SKILLS_PER_USER - opts.existingCount - held)
  return {
    rows: [...rows, ...buildRows(taken, { room, nextKey: opts.nextKey })],
    skipped: files.length - fresh.length,
    cut: fresh.length > free,
  }
}

/** Why this row stops the upload, or null. Excluded rows never block. */
export function blockingReason(row: DraftRow): BlockingReason | null {
  if (!usable(row)) return null
  if (!row.name.trim()) return 'name_missing'
  switch (row.nameCheck.state) {
    case 'checking': return 'name_checking'
    case 'taken': return 'name_taken'
    case 'duplicate': return 'name_duplicate'
    case 'invalid': return 'name_invalid'
    default: return null
  }
}

export function summarize(rows: DraftRow[]) {
  const included = rows.filter(usable)
  return {
    total: rows.length,
    included: included.length,
    ready: included.filter((r) => !blockingReason(r)).length,
    needName: included.filter((r) => !r.name.trim()).length,
    noDescription: included.filter((r) => !r.description.trim()).length,
    problems: rows.filter((r) => r.problem).length,
  }
}

/** The name a person typed or picked: checked again, earlier refusals cleared. */
export function setName(row: DraftRow, name: string, source: FieldSource = 'typed'): DraftRow {
  // An unchanged name keeps its answer: the check runs only when the list of names changes.
  const nameCheck = name === row.name ? row.nameCheck : name.trim() ? CHECKING : IDLE
  const next = {
    ...row, name, nameSource: source, nameShortened: false, serverError: null, aiError: null, touched: true, nameCheck,
  }
  return { ...next, aiModel: hasAiField(next) ? row.aiModel : null }
}

export function setDescription(row: DraftRow, description: string): DraftRow {
  const next = { ...row, description, descriptionSource: 'typed' as const, descriptionShortened: false, touched: true }
  return { ...next, aiModel: hasAiField(next) ? row.aiModel : null }
}

const CHECK_STATE: Record<string, NameCheckState> = {
  name_taken: 'taken', name_duplicate: 'duplicate', name_invalid: 'invalid', name_too_long: 'invalid',
}

/** The name check's answer for the rows posted as `keys`, in that order. */
export function applyNameChecks(rows: DraftRow[], keys: string[], results: NameCheckResult[]): DraftRow[] {
  const byKey = new Map(keys.map((k, i) => [k, results[i]]))
  return rows.map((row) => {
    const r = byKey.get(row.key)
    if (!r) return row
    const state = r.available ? 'available' : CHECK_STATE[r.reason ?? ''] ?? 'invalid'
    return { ...row, nameCheck: { state, suggestion: r.suggestion ?? null, reason: r.reason ?? null } }
  })
}

/** A failed name check: the rows still waiting show it, and the upload checks again under the lock. */
export function failNameChecks(rows: DraftRow[], keys: string[]): DraftRow[] {
  const sent = new Set(keys)
  return rows.map((row) => (sent.has(row.key) && row.nameCheck.state === 'checking'
    ? { ...row, nameCheck: { state: 'error', suggestion: null, reason: null } }
    : row))
}

/**
 * The AI's answers, applied only to fields that are still empty: a value the person typed
 * while the request ran is never overwritten. `modelUsed` is null when every item of the
 * request was refused before the model.
 */
export function applyGenerated(rows: DraftRow[], items: GeneratedItem[], modelUsed: string | null): DraftRow[] {
  const byKey = new Map(items.map((i) => [i.key, i]))
  return rows.map((row) => {
    const item = byKey.get(row.key)
    if (!item) return row
    let next: DraftRow = { ...row, aiError: item.error ?? null }
    if (typeof item.name === 'string' && item.name && !row.name.trim()) {
      next = { ...next, name: item.name, nameSource: 'ai', nameShortened: false, nameCheck: CHECKING, touched: true, aiModel: modelUsed }
    }
    if (typeof item.description === 'string' && item.description && !row.description.trim()) {
      next = { ...next, description: item.description, descriptionSource: 'ai', descriptionShortened: false, touched: true, aiModel: modelUsed }
    }
    return next
  })
}

/** A refused upload: each refusal names the position it was posted at. */
export function applyRefusal(rows: DraftRow[], postedKeys: string[], items: BatchItemRefusal[]): DraftRow[] {
  const byKey = new Map<string, BatchItemRefusal>()
  for (const item of items) {
    const key = postedKeys[item.index]
    if (key !== undefined) byKey.set(key, item)
  }
  return rows.map((row) => {
    const r = byKey.get(row.key)
    return {
      ...row,
      serverError: r ? { code: r.code, error: r.error, ...(r.suggestion ? { suggestion: r.suggestion } : {}) } : null,
    }
  })
}

/** The batch request for the included rows, in display order, and the row key of each item. */
export function uploadPayload(rows: DraftRow[]) {
  const sent = rows.filter(usable)
  return {
    keys: sent.map((r) => r.key),
    items: sent.map((r) => ({
      name: r.name,
      description: cleanSkillText(r.description) || null,
      content: r.content,
      nameSource: r.nameSource,
      descriptionSource: r.descriptionSource,
      aiModel: hasAiField(r) ? r.aiModel : null,
    })),
  }
}

/** The included rows Generate with AI may fill: an empty name and/or description, and not refused for a key or token. */
export function generationTargets(rows: DraftRow[]): { key: string; fields: ('name' | 'description')[] }[] {
  return rows.flatMap((r) => {
    if (!usable(r) || r.aiError === CREDENTIALS_ERROR) return []
    const fields: ('name' | 'description')[] = []
    if (!r.name.trim()) fields.push('name')
    if (!r.description.trim()) fields.push('description')
    return fields.length ? [{ key: r.key, fields }] : []
  })
}

/** "Use file name": the old single-upload default, one click away. */
export const withFileName = (row: DraftRow): DraftRow => setName(row, fileNameAsSkillName(row.fileName), 'file')
