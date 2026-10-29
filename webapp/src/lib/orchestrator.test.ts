import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { orchestratorFetch } from './orchestrator'

/**
 * Fix 3: orchestratorFetch must never let a hung orchestrator make a webapp
 * route wait forever. It applies a default abort timeout, exempts callers that
 * supply their own signal (SSE streams), and still injects the auth header.
 */
describe('orchestratorFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const initArg = () => fetchMock.mock.calls[0][1] as RequestInit

  it('injects the X-Orchestrator-Key auth header', async () => {
    await orchestratorFetch('http://orch/health')
    const headers = initArg().headers as Record<string, string>
    expect(headers['X-Orchestrator-Key']).toBeDefined()
  })

  it('attaches an abort signal by default (no caller signal)', async () => {
    await orchestratorFetch('http://orch/status')
    const { signal } = initArg()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })

  it('the default timeout aborts the request once the budget elapses', async () => {
    await orchestratorFetch('http://orch/status', {}, { timeoutMs: 20 })
    const { signal } = initArg()
    expect(signal!.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 45))
    expect(signal!.aborted).toBe(true)
  })

  it('preserves an explicit caller signal (SSE) and never force-times-out', async () => {
    const ac = new AbortController()
    // Even with a tiny timeout budget, an explicit signal must win: the stream
    // stays open and only aborts when the caller (client disconnect) aborts.
    await orchestratorFetch('http://orch/logs', { signal: ac.signal }, { timeoutMs: 20 })
    const { signal } = initArg()
    expect(signal).toBe(ac.signal)
    await new Promise((r) => setTimeout(r, 45))
    expect(signal!.aborted).toBe(false)
    ac.abort()
    expect(signal!.aborted).toBe(true)
  })

  it('disables the timeout when timeoutMs <= 0', async () => {
    await orchestratorFetch('http://orch/status', {}, { timeoutMs: 0 })
    expect(initArg().signal).toBeUndefined()
  })

  it('forwards method and body unchanged', async () => {
    await orchestratorFetch('http://orch/recon/p/partial', {
      method: 'POST',
      body: JSON.stringify({ tool_id: 'Naabu' }),
    })
    const init = initArg()
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ tool_id: 'Naabu' }))
  })
})
