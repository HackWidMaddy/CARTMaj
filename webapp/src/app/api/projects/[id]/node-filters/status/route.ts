/**
 * GET /api/projects/[id]/node-filters/status — what the Mute Rules tab badges.
 *
 * { armed, mode, activeRules, activeKinds, runningApply }. Fetched on load, after
 * Save and Apply, and when the project changes.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireProjectOwner } from '@/lib/triageClient'
import { nodeFilterStatus } from '@/lib/nodeFilters/server'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const caller = await requireProjectOwner(id)
  if (caller instanceof NextResponse) return caller
  return NextResponse.json(await nodeFilterStatus(caller.projectId))
}
