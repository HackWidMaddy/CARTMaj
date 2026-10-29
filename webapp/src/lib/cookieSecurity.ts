// S12: decide the session cookie `secure` flag in-app from the connection,
// instead of hardcoding it off and delegating to a deploy-time patch.
//
// `secure:true` ONLY when the request arrived over HTTPS (nginx sets
// x-forwarded-proto=https in the public posture), with NODE_ENV==='production'
// as a secondary signal. We deliberately do NOT blanket `secure:true` on
// NODE_ENV alone, because the default single-host template is plain HTTP and a
// Secure cookie would never be sent (breaking local/http login). Over plain HTTP
// `secure` stays false so local login keeps working.
import type { NextRequest } from 'next/server'

export function isSecureRequest(request: NextRequest): boolean {
  const proto = request.headers.get('x-forwarded-proto')
  return proto === 'https' && process.env.NODE_ENV === 'production'
}
