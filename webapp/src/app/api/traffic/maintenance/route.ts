import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'
import { gcOrphanBodies } from '@/lib/captureBodies'

export const runtime = 'nodejs'

// POST /api/traffic/maintenance - internal-only periodic housekeeping (plan §6.4,
// §15.8). Called by a cron/orchestrator. Runs, in order:
//   1. retention purge - delete rows older than each OWNER's captureProxyRetentionDays
//   2. per-project quota - evict the oldest rows beyond CAPTURE_PROXY_MAX_ROWS_PER_PROJECT
//   3. orphan body sweep - ref-counted GC of blobs no row references
const DEFAULT_RETENTION_DAYS = 14
const DAY_MS = 86400000

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const now = Date.now()

    // --- 1. Retention (per owner) ---
    const settingsRows = await prisma.userSettings.findMany({
      select: { userId: true, captureProxyRetentionDays: true },
    })
    const retMap = new Map(settingsRows.map(s => [s.userId, s.captureProxyRetentionDays ?? DEFAULT_RETENTION_DAYS]))
    const distinctUsers = await prisma.capturedHttpTransaction.findMany({
      distinct: ['userId'], select: { userId: true },
    })
    let retentionDeleted = 0
    for (const { userId } of distinctUsers) {
      const days = retMap.get(userId) ?? DEFAULT_RETENTION_DAYS
      // Defensive: <= 0 means "keep forever" (never delete everything), even if a
      // bad value slipped past the settings-write clamp.
      if (!Number.isFinite(days) || days <= 0) continue
      const cutoff = new Date(now - days * DAY_MS)
      const r = await prisma.capturedHttpTransaction.deleteMany({
        where: { userId, startedAt: { lt: cutoff } },
      })
      retentionDeleted += r.count
    }

    // --- 2. Per-project quota (evict oldest beyond the cap) ---
    const MAX_ROWS = parseInt(process.env.CAPTURE_PROXY_MAX_ROWS_PER_PROJECT || '200000', 10) || 200000
    const grouped = await prisma.capturedHttpTransaction.groupBy({
      by: ['projectId'], _count: { _all: true },
    })
    let quotaDeleted = 0
    for (const g of grouped) {
      const over = g._count._all - MAX_ROWS
      if (over > 0) {
        const oldest = await prisma.capturedHttpTransaction.findMany({
          where: { projectId: g.projectId }, orderBy: { startedAt: 'asc' }, take: over,
          select: { id: true, reqBodyRef: true, respBodyRef: true },
        })
        const r = await prisma.capturedHttpTransaction.deleteMany({
          where: { id: { in: oldest.map(o => o.id) } },
        })
        quotaDeleted += r.count
        await gcOrphanBodies(oldest.flatMap(o => [o.reqBodyRef, o.respBodyRef]))
      }
    }

    // --- 3. Orphan body sweep (full scan) ---
    const gc = await gcOrphanBodies()

    return NextResponse.json({ retentionDeleted, quotaDeleted, blobsDeleted: gc.deleted })
  } catch (error) {
    console.error('Traffic maintenance failed:', error)
    return NextResponse.json({ error: 'Maintenance failed' }, { status: 500 })
  }
}
