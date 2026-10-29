/**
 * Object-level ownership for Scan Timeline version ids (anti-IDOR/BOLA).
 *
 * `requireProjectAccess` proves the caller owns the PROJECT; it says nothing
 * about a client-supplied `versionId`. Without this second check a user who owns
 * project A could read/delete/activate a snapshot belonging to project B by
 * guessing its id. Every route that accepts a version id must go through here,
 * and a version that belongs to another project is reported as 404 (the repo's
 * anti-enumeration convention), never 403.
 */
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

export interface OwnedVersion {
  id: string
  projectId: string
  seq: number
  label: string
  isCurrent: boolean
  pinned: boolean
  nodeCount: number | null
  linkCount: number | null
  createdAt: Date
  hasSnapshot: boolean
}

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

/**
 * Load a ScanVersion and verify it belongs to `projectId`.
 * Returns the row, or a 404 NextResponse the caller must return.
 */
export async function requireVersionInProject(
  projectId: string,
  versionId: string
): Promise<OwnedVersion | NextResponse> {
  if (!versionId || typeof versionId !== 'string') return NOT_FOUND()

  // ONE query. This runs on every version request, and `snapshot` is potentially
  // megabytes - so the row and the "does it have bytes?" answer come back
  // together, with Postgres reporting the SIZE rather than shipping the payload.
  // `versionId` is bound as a parameter by the tagged template, never interpolated.
  const [row] = await prisma.$queryRaw<Array<{
    id: string
    project_id: string
    seq: number
    label: string
    is_current: boolean
    pinned: boolean
    node_count: number | null
    link_count: number | null
    created_at: Date
    snapshot_bytes: number | null
  }>>`
    SELECT id, project_id, seq, label, is_current, pinned, node_count, link_count,
           created_at, octet_length(snapshot) AS snapshot_bytes
    FROM scan_versions
    WHERE id = ${versionId}
  `
  if (!row || row.project_id !== projectId) return NOT_FOUND()

  return {
    id: row.id,
    projectId: row.project_id,
    seq: row.seq,
    label: row.label,
    isCurrent: row.is_current,
    pinned: row.pinned,
    nodeCount: row.node_count,
    linkCount: row.link_count,
    createdAt: row.created_at,
    hasSnapshot: (row.snapshot_bytes ?? 0) > 0,
  }
}

/**
 * Resolve a `from`/`to`-style version selector: the literal 'current' (the live
 * graph) or a version id that must belong to the project.
 */
export async function resolveVersionSelector(
  projectId: string,
  selector: string | null
): Promise<{ current: true } | OwnedVersion | NextResponse> {
  if (!selector || selector === 'current') return { current: true }
  return requireVersionInProject(projectId, selector)
}

export function isCurrentSelector(
  v: { current: true } | OwnedVersion
): v is { current: true } {
  return (v as { current?: true }).current === true
}
