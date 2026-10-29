/**
 * POST /api/internal/node-filter-runs/[runId]/finish — how an apply ended.
 *
 * Body: { status: completed | failed | stopped, stats?, error? }. Called from
 * the agent's `finally`, so a run is never left holding the project. The
 * transition is conditional on the run still running: a run swept to failed
 * for a stale heartbeat keeps that verdict. The stats are counts only.
 */
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'
import { writeAudit } from '@/lib/audit'
import { invalidateCache } from '@/app/api/graph/cache'

const FINAL = new Set(['completed', 'failed', 'stopped'])

interface RouteParams {
  params: Promise<{ runId: string }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const { runId } = await params
  const body = await request.json().catch(() => ({}))
  const status = typeof body?.status === 'string' && FINAL.has(body.status) ? body.status : 'failed'
  const error = typeof body?.error === 'string' ? body.error.slice(0, 500) : null
  const stats = body?.stats && typeof body.stats === 'object' ? body.stats : null

  const run = await prisma.nodeFilterRun.findUnique({
    where: { id: runId },
    select: { id: true, projectId: true, actorUserId: true, realActorUserId: true, revision: true, target: true },
  })
  if (!run) {
    // The project was deleted mid-run; its runs went with it.
    console.warn(`[nodeFilterRun] finish for a run that no longer exists: ${runId}`)
    return NextResponse.json({ ok: false, reason: 'the run no longer exists' }, { status: 404 })
  }

  const updated = await prisma.nodeFilterRun.updateMany({
    where: { id: runId, status: 'running' },
    data: { status, error, finishedAt: new Date(), ...(stats ? { stats } : {}) },
  })
  // Whatever the verdict, the run may have muted or unmuted findings: the
  // Graph Map's cached copy of this project is stale either way.
  invalidateCache(run.projectId)

  await writeAudit({
    actorId: run.realActorUserId ?? run.actorUserId,
    action: 'node_filters.apply_finished',
    targetType: 'project',
    targetId: run.projectId,
    after: {
      runId, status, error, revision: run.revision, target: run.target,
      effectiveUser: run.actorUserId, totals: stats?.totals ?? null,
      // false when the run had already ended (swept as agent_lost): the row
      // keeps that verdict, and the audit must not read as if this one won.
      recorded: updated.count === 1,
    },
    source: 'system',
  })

  return NextResponse.json({ ok: updated.count === 1, status })
}
