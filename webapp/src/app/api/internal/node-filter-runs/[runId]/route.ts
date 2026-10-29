/**
 * GET /api/internal/node-filter-runs/[runId] — what an apply run must do.
 *
 * The agent's apply endpoint takes only a run id; this is where it reads the
 * tenant, the mode and the rules, from the snapshot taken when the run was
 * created, so nothing in a request body can choose what gets muted. The
 * operator's exemptions are read now, so an unmute made meanwhile still counts.
 *
 * MASTER key only. The scanner key is refused: scan containers hold it, and a
 * run's rules and exemptions are not theirs to read.
 */
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'

interface RouteParams {
  params: Promise<{ runId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const { runId } = await params
  const run = await prisma.nodeFilterRun.findUnique({
    where: { id: runId },
    select: {
      id: true, projectId: true, status: true, mode: true, rules: true, revision: true, target: true,
      project: { select: { userId: true } },
    },
  })
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const exemptions = await prisma.nodeFilterExemption.findMany({
    where: { projectId: run.projectId },
    select: { label: true, nodeKey: true },
  })
  return NextResponse.json({
    id: run.id,
    projectId: run.projectId,
    userId: run.project.userId,
    status: run.status,
    mode: run.mode,
    rules: run.rules,
    revision: run.revision,
    target: run.target,
    exemptions: exemptions.map(e => [e.label, e.nodeKey]),
  })
}
