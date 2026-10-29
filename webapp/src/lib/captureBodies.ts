/**
 * Content-addressed captured-body store access (plan §5, §6.2, §15.7).
 *
 * The capture proxy offloads large bodies to a shared volume as `bodies/<sha256>`
 * (deduped). This module is the ONLY way the webapp reads or garbage-collects
 * them. Bodies are served exclusively through an owned transaction row (never by
 * raw sha path, §15.7), and GC is ref-counted across ALL tenants so purging one
 * tenant never deletes a blob another still references.
 */
import { promises as fs } from 'fs'
import path from 'path'
import prisma from '@/lib/prisma'

const BODIES_DIR = process.env.CAPTURE_BODIES_DIR || '/capture-bodies'
const SHA_RE = /^[0-9a-f]{64}$/
// Never GC a blob written within this window: its ingest row may still be
// in flight (uncommitted), so the reference query would miss it (TOCTOU).
const GC_GRACE_MS = 5 * 60 * 1000

/** A sha must be a 64-char lowercase hex string - blocks path traversal. */
export function isValidSha(sha: string | null | undefined): sha is string {
  return !!sha && SHA_RE.test(sha)
}

/** Read one offloaded body by sha, or null if invalid/missing. */
export async function readCapturedBody(sha: string): Promise<string | null> {
  if (!isValidSha(sha)) return null
  try {
    return await fs.readFile(path.join(BODIES_DIR, sha), 'utf8')
  } catch {
    return null
  }
}

/**
 * Ref-counted GC. Deletes blob files that NO captured_http_transaction row
 * references. When `candidateShas` is provided, only those are considered (fast
 * path after a delete); otherwise the whole bodies dir is scanned (orphan sweep).
 */
export async function gcOrphanBodies(candidateShas?: (string | null | undefined)[]): Promise<{ deleted: number }> {
  let shas: string[]
  if (candidateShas) {
    shas = [...new Set(candidateShas.filter(isValidSha))]
  } else {
    let files: string[]
    try {
      files = await fs.readdir(BODIES_DIR)
    } catch {
      return { deleted: 0 }
    }
    shas = files.filter(isValidSha)
  }
  if (shas.length === 0) return { deleted: 0 }

  // Which candidates are still referenced by ANY row (cross-tenant, §15.7)?
  const referenced = new Set<string>()
  // Chunk the IN() to keep the query bounded.
  for (let i = 0; i < shas.length; i += 1000) {
    const chunk = shas.slice(i, i + 1000)
    const rows = await prisma.capturedHttpTransaction.findMany({
      where: { OR: [{ reqBodyRef: { in: chunk } }, { respBodyRef: { in: chunk } }] },
      select: { reqBodyRef: true, respBodyRef: true },
    })
    for (const r of rows) {
      if (r.reqBodyRef) referenced.add(r.reqBodyRef)
      if (r.respBodyRef) referenced.add(r.respBodyRef)
    }
  }

  const now = Date.now()
  let deleted = 0
  for (const sha of shas) {
    if (referenced.has(sha)) continue
    const blobPath = path.join(BODIES_DIR, sha)
    try {
      // Grace window: skip freshly-written blobs (a concurrent ingest row may not
      // be committed yet, so it wouldn't show in the reference query above).
      const st = await fs.stat(blobPath)
      if (now - st.mtimeMs < GC_GRACE_MS) continue
      await fs.unlink(blobPath)
      deleted++
    } catch {
      // already gone / not present - fine
    }
  }
  return { deleted }
}
