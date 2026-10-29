/**
 * Server-side fetch wrapper for all calls to the recon orchestrator.
 *
 * The orchestrator requires `X-Orchestrator-Key` on every route except `/health`
 * (V1-auth). This helper injects that header so the webapp's server-side API
 * routes are accepted, while a compromised recon container (which does not hold
 * ORCHESTRATOR_API_KEY) cannot drive the orchestration API even though it can
 * reach 127.0.0.1:8010 over host networking.
 *
 * Pass the full URL (callers keep their existing `${RECON_ORCHESTRATOR_URL}/...`
 * templates); only the function name changes from `fetch` to `orchestratorFetch`.
 * Server-side only - never import this into client components.
 *
 * TIMEOUT: every request gets a default abort timeout so a hung/slow orchestrator
 * can never make a route hang indefinitely. Without it, when the orchestrator's
 * event loop was starved (parallel-scan freeze), the webapp route would wait
 * forever; nginx cut the browser request at 60s and the page threw an unhandled
 * client-side exception. A short timeout returns a clean error instead, which the
 * client hooks already handle gracefully.
 *
 * Streaming (SSE) routes pass their own `signal` (request.signal, aborts on client
 * disconnect); those keep their long-lived connection because an explicit
 * `init.signal` takes precedence over the default timeout signal below. Callers
 * that need a different budget pass `{ timeoutMs }`; `timeoutMs <= 0` disables it.
 */

const DEFAULT_ORCHESTRATOR_TIMEOUT_MS = 30_000

export interface OrchestratorFetchOptions {
  /** Abort the request after this many ms. Default 30s; <= 0 disables. Ignored
   *  when the caller supplies its own `init.signal` (e.g. SSE streams). */
  timeoutMs?: number
}

export function orchestratorFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: OrchestratorFetchOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ORCHESTRATOR_TIMEOUT_MS

  // An explicit caller signal (SSE routes pass request.signal) always wins, so
  // long-lived streams are never force-aborted by the default timeout.
  const signal =
    init.signal ??
    (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined)

  return fetch(url, {
    ...init,
    signal,
    headers: {
      ...(init.headers || {}),
      'X-Orchestrator-Key': process.env.ORCHESTRATOR_API_KEY || 'changeme',
    },
  })
}
