/**
 * Unit tests for the content-addressed body store: sha validation (path-traversal
 * guard) and ref-counted orphan GC.
 *
 * Run: npx vitest run --no-file-parallelism src/lib/captureBodies.test.ts
 * @vitest-environment node
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'

const mockReaddir = vi.fn()
const mockUnlink = vi.fn()
const mockReadFile = vi.fn()
const mockStat = vi.fn()
vi.mock('fs', () => ({
  promises: {
    readdir: (...a: unknown[]) => mockReaddir(...a),
    unlink: (...a: unknown[]) => mockUnlink(...a),
    readFile: (...a: unknown[]) => mockReadFile(...a),
    stat: (...a: unknown[]) => mockStat(...a),
  },
}))

const mockFindMany = vi.fn()
vi.mock('@/lib/prisma', () => ({
  default: { capturedHttpTransaction: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}))

import { isValidSha, gcOrphanBodies, readCapturedBody } from './captureBodies'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

beforeEach(() => {
  mockReaddir.mockReset(); mockUnlink.mockReset(); mockReadFile.mockReset(); mockFindMany.mockReset(); mockStat.mockReset()
  mockUnlink.mockResolvedValue(undefined)
  // Default: blobs are old (mtime 0) so they're outside the GC grace window.
  mockStat.mockResolvedValue({ mtimeMs: 0 })
})

describe('isValidSha (path-traversal guard)', () => {
  test('accepts a 64-char lowercase hex string', () => {
    expect(isValidSha(SHA_A)).toBe(true)
  })
  test.each(['../etc/passwd', 'ABCDEF', 'a'.repeat(63), 'a'.repeat(65), '', null, undefined, 'a/../b', SHA_A.toUpperCase()])(
    'rejects %s', (bad) => { expect(isValidSha(bad as string)).toBe(false) })
})

describe('readCapturedBody', () => {
  test('refuses an invalid sha without touching the fs', async () => {
    expect(await readCapturedBody('../../evil')).toBeNull()
    expect(mockReadFile).not.toHaveBeenCalled()
  })
  test('reads a valid blob', async () => {
    mockReadFile.mockResolvedValue('BODY')
    expect(await readCapturedBody(SHA_A)).toBe('BODY')
  })
})

describe('gcOrphanBodies (ref-counted)', () => {
  test('deletes only blobs no row references', async () => {
    // A is still referenced (as reqBodyRef), B/C are orphaned.
    mockFindMany.mockResolvedValue([{ reqBodyRef: SHA_A, respBodyRef: null }])
    const r = await gcOrphanBodies([SHA_A, SHA_B, SHA_C])
    expect(r.deleted).toBe(2)
    const unlinked = mockUnlink.mock.calls.map(c => String(c[0]))
    expect(unlinked.some(p => p.endsWith(SHA_A))).toBe(false) // referenced -> kept
    expect(unlinked.some(p => p.endsWith(SHA_B))).toBe(true)
    expect(unlinked.some(p => p.endsWith(SHA_C))).toBe(true)
  })

  test('full-scan mode reads the dir and ignores non-sha files', async () => {
    mockReaddir.mockResolvedValue([SHA_A, 'not-a-sha', '.tmp'])
    mockFindMany.mockResolvedValue([]) // nothing referenced
    const r = await gcOrphanBodies()
    expect(r.deleted).toBe(1) // only the valid orphan sha
  })

  test('no candidates -> no-op', async () => {
    const r = await gcOrphanBodies([])
    expect(r.deleted).toBe(0)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  test('filters out invalid shas from candidates (never unlinks them)', async () => {
    mockFindMany.mockResolvedValue([])
    await gcOrphanBodies(['../evil', SHA_A])
    const unlinked = mockUnlink.mock.calls.map(c => String(c[0]))
    expect(unlinked.every(p => !p.includes('evil'))).toBe(true)
  })

  test('REGRESSION: a freshly-written orphan blob is spared (grace window)', async () => {
    mockFindMany.mockResolvedValue([]) // unreferenced
    mockStat.mockResolvedValue({ mtimeMs: Date.now() }) // written just now
    const r = await gcOrphanBodies([SHA_A])
    expect(r.deleted).toBe(0)
    expect(mockUnlink).not.toHaveBeenCalled()
  })
})
