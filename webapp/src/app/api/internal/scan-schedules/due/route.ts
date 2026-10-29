/**
 * Scan Timeline - due-schedule feed for the orchestrator's scheduler worker
 * (Section 7.2). Internal-key only.
 *
 * The worker owns the tick and the admission pre-check; the WEBAPP owns the
 * version freeze and the ScanJob history, so the split is: this endpoint says
 * WHAT is due (plus whether the project's graph is currently locked by an
 * activation), and `/run` actually starts it through the same path a manual scan
 * takes.
 */
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'
import { activationStates } from '@/lib/activationLock'

export const runtime = 'nodejs'

const MAX_DUE = 25

export async function GET(request: NextRequest) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const now = new Date()
    const due = await prisma.scanSchedule.findMany({
      where: { enabled: true, nextRunAt: { not: null, lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: MAX_DUE,
      select: {
        id: true,
        projectId: true,
        userId: true,
        mode: true,
        scanMode: true,
        nextRunAt: true,
        estimatedEnvelopeBytes: true,
      },
    })

    // F3: the worker must not spawn into an in-flight graph swap. Batched - this
    // endpoint is polled every tick, so one query per due project would scale the
    // round-trips with the number of schedules.
    const activating = await activationStates([...new Set(due.map(d => d.projectId))])

    return NextResponse.json({
      now: now.toISOString(),
      schedules: due.map(d => ({
        id: d.id,
        projectId: d.projectId,
        userId: d.userId,
        mode: d.mode,
        scanMode: d.scanMode,
        nextRunAt: d.nextRunAt,
        estimatedEnvelopeBytes: d.estimatedEnvelopeBytes === null ? null : Number(d.estimatedEnvelopeBytes),
        activationInProgress: activating.get(d.projectId) ?? false,
      })),
    })
  } catch (error) {
    console.error('[scanScheduler] due lookup failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read due schedules' },
      { status: 500 }
    )
  }
}
