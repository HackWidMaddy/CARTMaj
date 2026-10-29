'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/providers/AuthProvider'

/**
 * Read-only per-project TrafficMind capture-routing status for the /traffic page
 * top bar. It shows whether capture routing is on for the current project, but
 * does NOT change it: enabling/disabling capture is done in Global Settings >
 * TrafficMind (admin-only), so this is display-only. When disabled it points the
 * operator there.
 */
export function TrafficCaptureStatus({
  projectId,
  projectName,
}: {
  projectId: string
  projectName?: string | null
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const { isAdmin } = useAuth()

  useEffect(() => {
    let cancelled = false
    setEnabled(null)
    if (!projectId) return
    fetch(`/api/projects/${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (!cancelled && p) setEnabled(!!p.captureProxyEnabled) })
      .catch(() => { if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [projectId])

  if (enabled === null) return null

  const on = enabled
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? 'var(--success, #30a46c)' : 'var(--danger, #e5484d)', flexShrink: 0 }} />
        Traffic capture{projectName ? <> for <strong style={{ color: 'var(--text-primary)' }}>{projectName}</strong></> : null}:{' '}
        <strong style={{ color: on ? 'var(--success, #30a46c)' : 'var(--danger, #e5484d)' }}>{on ? 'Enabled' : 'Disabled'}</strong>
      </span>
      {!on && !isAdmin && (
        <span style={{ color: 'var(--text-tertiary)' }}>
          Ask an administrator to enable it.
        </span>
      )}
    </div>
  )
}
