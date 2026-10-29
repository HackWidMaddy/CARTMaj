/**
 * Scan Scheduler — reading the RAM envelope from the orchestrator (Section 7.3).
 *
 * This feeds only the ADVISORY, static feasibility check at schedule creation.
 * The authoritative gate is the admission ledger at execution time, so every
 * failure mode here must return null ("skip the courtesy check") rather than
 * block schedule creation or, worse, invent a number.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: (...a: unknown[]) => fetchMock(...a) }))

import { fetchScanEnvelope } from './scanEnvelope'

const MB = 1024 * 1024

beforeEach(() => vi.clearAllMocks())

describe('fetchScanEnvelope', () => {
  test('reads the envelope + pool for the requested scan type', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ envelope_bytes: 2000 * MB, scan_pool_bytes: 6000 * MB }),
    })
    expect(await fetchScanEnvelope()).toEqual({
      envelopeBytes: 2000 * MB,
      scanPoolBytes: 6000 * MB,
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('scan_type=full_recon')
  })

  test.each([
    ['an unreachable orchestrator', () => { fetchMock.mockRejectedValue(new Error('ECONNREFUSED')) }],
    ['a non-OK response', () => { fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) }) }],
    ['a governor that reports zero', () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ envelope_bytes: 0, scan_pool_bytes: 0 }) })
    }],
    ['a malformed payload', () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ envelope_bytes: 'lots' }) })
    }],
    ['an empty payload', () => { fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) }) }],
  ])('returns null for %s (the check is skipped, never guessed)', async (_d, arrange) => {
    arrange()
    expect(await fetchScanEnvelope()).toBeNull()
  })

  test('a negative pool is treated as unknown', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ envelope_bytes: 2000 * MB, scan_pool_bytes: -1 }),
    })
    expect(await fetchScanEnvelope()).toBeNull()
  })
})
