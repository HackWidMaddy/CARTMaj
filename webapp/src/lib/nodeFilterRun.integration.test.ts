/** @vitest-environment node */
/**
 * One live node-filter apply per project, against real Postgres.
 *
 * `createNodeFilterRun` reads "is a run live?" and inserts in ONE serializable
 * transaction. A mocked Prisma cannot tell whether two concurrent Apply clicks
 * really end with one run and one clean "already applying", because only real
 * Postgres decides which transaction loses and how it reports that.
 *
 * Auto-skips unless DATABASE_URL is set. To run it:
 *   docker run --rm --network CART-network -v "$PWD/webapp:/app" -w /app \
 *     -e DATABASE_URL='postgresql://CART:<pw>@postgres:5432/CART' \
 *     --entrypoint sh CART-webapp -c \
 *     'node_modules/.bin/vitest run src/lib/nodeFilterRun.integration.test.ts'
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'

import prisma from './prisma'
import { RunAlreadyLiveError, createNodeFilterRun } from './nodeFilterRun'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `nf-run-${Date.now()}`

let userId: string
let projectId: string

beforeAll(async () => {
  if (!HAS_DB) return
  userId = (await prisma.user.create({ data: { email: `${SUFFIX}@test.invalid`, name: 'nf-run' } })).id
  projectId = (await prisma.project.create({
    data: { name: SUFFIX, userId, targetDomain: 'example.invalid' },
  })).id
})

afterAll(async () => {
  if (!HAS_DB) return
  await prisma.project.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
  await prisma.$disconnect()
})

const input = () => ({
  projectId, actorUserId: userId, realActorUserId: null, target: 'current' as const,
  versionId: '', revision: 1, mode: 'denylist', rules: { version: 1, kinds: {} },
})

describe.skipIf(!HAS_DB)('createNodeFilterRun under real concurrency', () => {
  test('two Apply clicks at once: one run starts, the other is told one is already live', async () => {
    // Several rounds, because a single pair can serialise by luck.
    for (let round = 0; round < 8; round++) {
      const results = await Promise.allSettled([createNodeFilterRun(input()), createNodeFilterRun(input())])
      const started = results.filter(r => r.status === 'fulfilled')
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(started).toHaveLength(1)
      expect(refused).toHaveLength(1)
      expect(refused[0].reason).toBeInstanceOf(RunAlreadyLiveError)
      expect(await prisma.nodeFilterRun.count({ where: { projectId, status: 'running' } })).toBe(1)
      await prisma.nodeFilterRun.updateMany({ where: { projectId }, data: { status: 'completed' } })
    }
  })
})
