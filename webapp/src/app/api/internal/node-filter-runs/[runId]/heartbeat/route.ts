/**
 * POST /api/internal/node-filter-runs/[runId]/heartbeat — "still here", and "should I stop?".
 *
 * The agent calls this at most every 30 seconds while an apply runs, with how
 * many nodes it has checked. The reply's `abort` is how the run learns that it
 * was stopped, that the project was deleted, or that a version activation
 * started; the agent stops at the next page. A run whose heartbeat goes stale
 * is marked failed by the next writer check (lib/nodeFilterRun.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'
import { isActivationInProgress } from '@/lib/activationLock'

interface RouteParams {
  params: Promise<{ runId: string }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const { runId } = await params
  const body = await request.json().catch(() => ({}))
  const run = await prisma.nodeFilterRun.findUnique({
    where: { id: runId },
    select: { id: true, projectId: true, status: true, stats: true },
  })
  if (!run) {
    return NextResponse.json(
      { status: 'gone', abort: true, reason: 'the run no longer exists' },
      { status: 404 },
    )
  }
  if (run.status !== 'running') {
    return NextResponse.json({ status: run.status, abort: true, reason: `the run is ${run.status}` })
  }
  if (await isActivationInProgress(run.projectId)) {
    return NextResponse.json({ status: run.status, abort: true, reason: 'a version activation started' })
  }

  const scanned = Number(body?.progress?.scanned)
  await prisma.nodeFilterRun.update({
    where: { id: runId },
    data: {
      heartbeatAt: new Date(),
      ...(Number.isFinite(scanned) && scanned >= 0
        ? { stats: { progress: { scanned: Math.floor(scanned) } } }
        : {}),
    },
  })
  return NextResponse.json({ status: 'running', abort: false })
}
