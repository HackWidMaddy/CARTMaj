/**
 * "Apply node filters to the current graph" as a tracked graph writer.
 *
 * An apply mutes and unmutes findings across the whole live graph, page by page,
 * in an agent thread. Nothing else could see that, so a version activation could
 * freeze a half-applied graph and then restore over it. `NodeFilterRun` makes
 * the apply a row, on the `TriageRun` pattern:
 *
 * 1. **One live run per project**, created in a serializable transaction, and
 *    refused while anything else writes the graph (lib/graphWriters.ts reports
 *    a live run back to activation, Recon Delta, scan start, Save Version and
 *    partial recon start, so they refuse in turn).
 * 2. **The agent applies the run row, not a request body.** The rules are
 *    snapshotted into the row at start; the agent fetches them by run id over
 *    the master-key internal route.
 * 3. **A stale heartbeat stops blocking.** A crashed agent must not hold the
 *    project, so a run that has not checked in within the TTL is marked failed
 *    the next time anyone asks.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'

export const NODE_FILTER_RUN_STATUSES = ['running', 'completed', 'failed', 'stopped'] as const
export type NodeFilterRunStatus = (typeof NODE_FILTER_RUN_STATUSES)[number]

/** Five minutes by default: the agent heartbeats every 30 seconds, per page. */
export function nodeFilterHeartbeatTtlMs(): number {
  const configured = Number(process.env.NODE_FILTER_HEARTBEAT_TTL_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : 5 * 60 * 1000
}

export function nodeFilterHeartbeatIsStale(heartbeatAt: Date | null, now = Date.now()): boolean {
  if (!heartbeatAt) return true
  return now - heartbeatAt.getTime() > nodeFilterHeartbeatTtlMs()
}

export interface LiveNodeFilterRun {
  id: string
  startedAt: Date
  target: string
  revision: number
}

/**
 * The run applying filters to this project right now, or null.
 *
 * Stale runs are marked failed here rather than returned, so one call both
 * answers and cleans up after a crashed agent. The sweep is best-effort: failing
 * to mark a dead run must not make the caller believe a live one exists.
 */
export async function findLiveNodeFilterRun(projectId: string): Promise<LiveNodeFilterRun | null> {
  const candidates = await prisma.nodeFilterRun.findMany({
    where: { projectId, status: 'running' },
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true, heartbeatAt: true, target: true, revision: true },
  })
  const now = Date.now()
  const dead = candidates.filter(r => nodeFilterHeartbeatIsStale(r.heartbeatAt, now))
  const live = candidates.filter(r => !nodeFilterHeartbeatIsStale(r.heartbeatAt, now))
  if (dead.length > 0) {
    try {
      await prisma.nodeFilterRun.updateMany({
        where: { id: { in: dead.map(r => r.id) }, status: 'running' },
        data: { status: 'failed', error: 'agent_lost', finishedAt: new Date() },
      })
    } catch (e) {
      console.error('[nodeFilterRun] could not mark a lost run failed:', e)
    }
  }
  if (live.length === 0) return null
  const [run] = live
  return { id: run.id, startedAt: run.startedAt, target: run.target, revision: run.revision }
}

/**
 * The phrase graphWriters reports while an apply runs, or null. FAIL CLOSED:
 * a state that cannot be read is "busy", never "idle".
 */
export async function describeNodeFilterWriter(projectId: string): Promise<string | null> {
  try {
    return (await findLiveNodeFilterRun(projectId)) ? 'mute rules are being applied to the graph' : null
  } catch (err) {
    console.error('[graphWriters] node-filter run check failed (treating as busy):', err)
    return 'the mute-rule apply state could not be verified'
  }
}

export class RunAlreadyLiveError extends Error {
  constructor(public runId: string) {
    super('mute rules are already being applied to this project')
  }
}

export interface NewNodeFilterRun {
  projectId: string
  actorUserId: string
  realActorUserId: string | null
  target: 'current' | 'both'
  versionId: string
  revision: number
  mode: string
  rules: unknown
}

const SERIALIZATION_RETRIES = 3

/**
 * Create the run, refusing when one is already live, in ONE serializable
 * transaction so two concurrent Apply clicks cannot both start one.
 *
 * Postgres resolves such a race by aborting one of the two transactions with
 * a serialization failure (P2034), not by letting it see the other's run. The
 * retry does see it, so the loser gets RunAlreadyLiveError (a 409) instead of
 * a raw database error (a 500).
 */
export async function createNodeFilterRun(input: NewNodeFilterRun): Promise<{ id: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createRunOnce(input)
    } catch (e) {
      const serialization = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034'
      if (!serialization || attempt >= SERIALIZATION_RETRIES) throw e
    }
  }
}

function createRunOnce(input: NewNodeFilterRun): Promise<{ id: string }> {
  return prisma.$transaction(async tx => {
    const now = Date.now()
    const running = await tx.nodeFilterRun.findMany({
      where: { projectId: input.projectId, status: 'running' },
      select: { id: true, heartbeatAt: true },
    })
    const live = running.find(r => !nodeFilterHeartbeatIsStale(r.heartbeatAt, now))
    if (live) throw new RunAlreadyLiveError(live.id)
    // Past the check, every running row is a stale one a crashed agent left.
    if (running.length > 0) {
      await tx.nodeFilterRun.updateMany({
        where: { id: { in: running.map(r => r.id) } },
        data: { status: 'failed', error: 'agent_lost', finishedAt: new Date() },
      })
    }
    return tx.nodeFilterRun.create({
      data: {
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        realActorUserId: input.realActorUserId,
        target: input.target,
        versionId: input.versionId,
        revision: input.revision,
        mode: input.mode,
        rules: input.rules as never,
        status: 'running',
      },
      select: { id: true },
    })
  }, { isolationLevel: 'Serializable' })
}
