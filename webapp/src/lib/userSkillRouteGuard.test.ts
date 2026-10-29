/**
 * requireOwnBrowserRequest: the routes only the upload dialog calls accept a same-origin
 * request whose EFFECTIVE user owns the id. An admin must be simulating the owner, and the
 * internal key, which requireUserAccess lets through, is no login here.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  session: null as { userId: string; role: string } | null,
  actAs: null as string | null,
}))
vi.mock('@/lib/prisma', () => ({ default: {} }))
// The real effective-user rule (session.ts getEffectiveUser), over a session the test sets.
vi.mock('@/lib/session', () => ({
  getEffectiveUser: async () => {
    if (!h.session) return null
    if (h.session.role === 'admin' && h.actAs) return { userId: h.actAs }
    return { userId: h.session.userId }
  },
}))

import { requireOwnBrowserRequest } from './userSkillRouteGuard'

const request = (headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost:3000/api/users/alice/attack-skills/batch', {
    method: 'POST', headers: { host: 'localhost:3000', ...headers },
  })

async function status(req: NextRequest, id = 'alice') {
  const out = await requireOwnBrowserRequest(req, id)
  return out instanceof NextResponse ? { status: out.status, body: await out.json() } : { status: 0, eff: out }
}

beforeEach(() => {
  h.session = { userId: 'alice', role: 'standard' }
  h.actAs = null
  vi.stubEnv('PLUGINS_ALLOWED_ORIGIN', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('requireOwnBrowserRequest', () => {
  test('the owner from the same origin passes with the effective user', async () => {
    expect(await status(request({ origin: 'http://localhost:3000' }))).toEqual({ status: 0, eff: { userId: 'alice' } })
  })

  test('a foreign Origin is 403 cross_origin, before the session is read', async () => {
    h.session = null
    const out = await status(request({ origin: 'https://evil.example.com' }))
    expect(out).toMatchObject({ status: 403, body: { code: 'cross_origin' } })
  })

  test('no session is 401', async () => {
    h.session = null
    expect((await status(request())).status).toBe(401)
  })

  test("another user's id is 403", async () => {
    expect((await status(request(), 'bob')).status).toBe(403)
  })

  test('an admin simulating the owner passes; an admin not simulating is 403', async () => {
    h.session = { userId: 'root', role: 'admin' }
    h.actAs = 'alice'
    expect(await status(request())).toEqual({ status: 0, eff: { userId: 'alice' } })
    h.actAs = null
    expect((await status(request())).status).toBe(403)
  })

  test('a stale tab whose act-as user changed cannot act for the previous one', async () => {
    h.session = { userId: 'root', role: 'admin' }
    h.actAs = 'carol'
    expect((await status(request())).status).toBe(403)
  })

  test('a request carrying only x-internal-key is 401', async () => {
    h.session = null
    vi.stubEnv('INTERNAL_API_KEY', 'k'.repeat(32))
    expect((await status(request({ 'x-internal-key': 'k'.repeat(32) }))).status).toBe(401)
  })
})
