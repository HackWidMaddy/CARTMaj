import { NextResponse } from 'next/server'
import { orchestratorFetch } from '@/lib/orchestrator'

const RECON_ORCHESTRATOR_URL = process.env.RECON_ORCHESTRATOR_URL || 'http://localhost:8010'

// Memory governor (Part 5): proxy the orchestrator's live memory/CPU stats for the
// top-bar RAM chip and bottom-bar htop meters. Read-only, no secrets.
export async function GET() {
  try {
    const response = await orchestratorFetch(`${RECON_ORCHESTRATOR_URL}/system/stats`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch system stats' }, { status: 503 })
    }
    return NextResponse.json(await response.json())
  } catch (error) {
    console.error('Failed to fetch system stats:', error)
    return NextResponse.json({ error: 'Failed to connect to backend services' }, { status: 503 })
  }
}
