import { NextRequest, NextResponse } from 'next/server'
import { assertOwnerStrict, requireEffectiveUser } from '@/lib/access'
import { crossOriginResponse, sameOrigin } from '@/lib/plugins/sameOrigin'
import type { EffectiveUser } from '@/lib/session'

/**
 * The guard of the user-skill routes only the upload dialog calls: a same-origin browser
 * request whose effective user owns `id`. No internal key and no admin bypass: these routes
 * create skills the agent runs, or spend the owner's model keys, and the act-as cookie is
 * site-wide, so a stale tab must not act as another user.
 */
export async function requireOwnBrowserRequest(request: NextRequest, id: string): Promise<NextResponse | EffectiveUser> {
  if (!sameOrigin(request)) return crossOriginResponse()
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const denied = assertOwnerStrict(eff, id)
  if (denied) return denied
  return eff
}
