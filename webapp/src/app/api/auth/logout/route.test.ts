/**
 * logout clears BOTH the auth cookie and the admin impersonation (act-as) cookie,
 * so impersonation cannot silently resume when the same admin logs back in.
 *
 * @vitest-environment node
 */
import { describe, test, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn().mockResolvedValue(undefined) }))

import { POST } from './route'

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/logout', { method: 'POST' })
}

describe('POST /api/auth/logout', () => {
  test('expires CART-auth and CART-act-as (Max-Age=0)', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    const setCookie = res.headers.getSetCookie().join('\n')
    expect(setCookie).toMatch(/CART-auth=/)
    expect(setCookie).toMatch(/CART-act-as=/)
    // both expired
    const matches = setCookie.split('\n').filter(c => /Max-Age=0/i.test(c))
    expect(matches.some(c => c.includes('CART-auth'))).toBe(true)
    expect(matches.some(c => c.includes('CART-act-as'))).toBe(true)
  })
})
