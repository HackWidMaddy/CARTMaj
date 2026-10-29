/**
 * Ask the orchestrator what a full recon costs in RAM (Section 7.3).
 *
 * The admission ledger lives in the orchestrator (it owns the spawn), so the
 * webapp cannot compute an envelope itself. This is used ONLY for the advisory,
 * static feasibility check when a schedule is created - the authoritative gate is
 * still `try_admit` at execution time, so a null here (governor disabled, or the
 * orchestrator unreachable) simply skips the courtesy check rather than blocking
 * schedule creation.
 */
import { orchestratorFetch } from '@/lib/orchestrator'
import type { EnvelopeInfo } from '@/lib/scanSchedule'

const RECON_ORCHESTRATOR_URL = process.env.RECON_ORCHESTRATOR_URL || 'http://localhost:8010'

export async function fetchScanEnvelope(scanType = 'full_recon'): Promise<EnvelopeInfo | null> {
  try {
    const res = await orchestratorFetch(
      `${RECON_ORCHESTRATOR_URL}/system/scan-envelope?scan_type=${encodeURIComponent(scanType)}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } }
    )
    if (!res.ok) return null
    const body = await res.json()
    const envelopeBytes = Number(body?.envelope_bytes ?? 0)
    const scanPoolBytes = Number(body?.scan_pool_bytes ?? 0)
    if (!Number.isFinite(envelopeBytes) || !Number.isFinite(scanPoolBytes)) return null
    if (envelopeBytes <= 0 || scanPoolBytes <= 0) return null
    return { envelopeBytes, scanPoolBytes }
  } catch (err) {
    console.warn('[scanTimeline] could not read the scan envelope (skipping the static RAM check):', err)
    return null
  }
}
