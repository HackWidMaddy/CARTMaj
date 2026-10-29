/**
 * Read a mutating request's JSON body, refusing anything that is not JSON.
 *
 * The session cookie is SameSite=lax, so a cross-site page can still POST a
 * plain HTML form at a same-site route. A form can only send urlencoded,
 * multipart or text/plain; requiring `application/json` means it cannot drive
 * the route, and a cross-origin `fetch` that sets JSON triggers a preflight the
 * app never answers. 415 for the wrong type, 400 for a body that does not parse.
 */
import { NextRequest, NextResponse } from 'next/server'

export function isJsonContentType(header: string | null): boolean {
  const media = (header ?? '').split(';')[0].trim().toLowerCase()
  return media === 'application/json'
}

export async function readJsonBody(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | NextResponse> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json(
      { error: 'Content-Type must be application/json' },
      { status: 415 },
    )
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
  }
  return { body: body as Record<string, unknown> }
}
