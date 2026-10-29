import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE_NAME, ACT_AS_COOKIE_NAME } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { getClientMeta } from '@/lib/requestMeta'
import { isSecureRequest } from '@/lib/cookieSecurity'

export async function POST(request: NextRequest) {
  const meta = getClientMeta(request)
  await writeAudit({
    action: 'auth.logout', targetType: 'session',
    after: { ip: meta.ip, ipTrusted: meta.ipTrusted, userAgent: meta.userAgent },
  })
  const response = NextResponse.json({ ok: true })
  const expire = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest(request), // S12
    path: '/',
    maxAge: 0,
  }
  response.cookies.set(AUTH_COOKIE_NAME, '', expire)
  // Also clear any admin impersonation so it can't silently resume on next login.
  response.cookies.set(ACT_AS_COOKIE_NAME, '', expire)
  return response
}
