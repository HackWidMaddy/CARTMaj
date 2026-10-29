'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/ui'
import type { NodeFilterCatalog } from '@/lib/nodeFilters/catalog'
import type { NodeFilterDoc, NodeFilterMode } from '@/lib/nodeFilters/model'
import { fetchPreview, type PreviewResult } from './usePreview'
import type { ApplyTarget } from './useApplyRun'
import styles from './NodeFilters.module.css'

interface ApplyModalProps {
  isOpen: boolean
  onClose: () => void
  projectId: string
  catalog: NodeFilterCatalog
  mode: NodeFilterMode
  rules: NodeFilterDoc
  ruleCount: number
  dirty: boolean
  isViewingPastVersion: boolean
  viewedVersionLabel?: string
  onConfirm: (target: ApplyTarget) => Promise<void>
}

interface Readiness {
  busy: string | null
  activeVersion: { id: string; label: string } | null
}

const BUSY_RETRY_MS = 750
const BUSY_RETRIES = 30

/**
 * The modal's preview, waiting out a 429. The page's own debounced preview is
 * often still running when Apply opens, and the route allows one per project;
 * read as a failure, that would claim the agent is down.
 */
async function previewWhenFree(
  projectId: string, mode: NodeFilterMode, rules: NodeFilterDoc, isCancelled: () => boolean,
) {
  for (let attempt = 0; ; attempt++) {
    const result = await fetchPreview(projectId, mode, rules, { withRemediations: true })
    if (result.status !== 429 || attempt >= BUSY_RETRIES || isCancelled()) return result
    await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_MS))
  }
}

/** Why "current graph" is not offered right now, or null when it is. */
export function currentGraphBlocker(opts: {
  isViewingPastVersion: boolean
  viewedVersionLabel?: string
  readiness: Readiness | null
  preview: PreviewResult | null
  previewFailed: boolean
}): string | null {
  if (opts.isViewingPastVersion) {
    return `You are viewing ${opts.viewedVersionLabel ?? 'a saved snapshot'}, a saved snapshot. ` +
      'Mute rules change the live graph only; switch back to the active version, or choose New scans only.'
  }
  if (opts.readiness?.busy) {
    return `${opts.readiness.busy[0].toUpperCase()}${opts.readiness.busy.slice(1)}; ` +
      'apply to the current graph when it finishes, or choose New scans only.'
  }
  if (opts.previewFailed) return 'Cannot reach the agent, so the current graph cannot be changed now.'
  if (opts.preview && (opts.preview.totals?.scanned ?? 0) === 0) {
    return 'The current graph has none of these findings yet.'
  }
  return null
}

export function ApplyModal({
  isOpen, onClose, projectId, catalog, mode, rules, ruleCount, dirty,
  isViewingPastVersion, viewedVersionLabel, onConfirm,
}: ApplyModalProps) {
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState<ApplyTarget>('both')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    setPreview(null)
    setPreviewFailed(false)
    const base = `/api/projects/${encodeURIComponent(projectId)}/node-filters`
    Promise.all([
      fetch(`${base}/apply`).then(r => (r.ok ? r.json() : { busy: 'the graph state could not be verified', activeVersion: null })),
      previewWhenFree(projectId, mode, rules, () => cancelled).catch(() => ({ status: 0, body: null })),
    ]).then(([ready, prev]) => {
      if (cancelled) return
      setReadiness(ready)
      if (prev.status === 200 && prev.body) setPreview(prev.body as PreviewResult)
      else setPreviewFailed(true)
    }).catch(() => {
      if (!cancelled) setPreviewFailed(true)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [isOpen, projectId, mode, rules])

  const blocker = currentGraphBlocker({ isViewingPastVersion, viewedVersionLabel, readiness, preview, previewFailed })

  useEffect(() => {
    if (blocker && target !== 'scans') setTarget('scans')
  }, [blocker, target])

  const bigKinds = useMemo(() => Object.entries(preview?.kinds ?? {})
    .filter(([, k]) => k.scanned > 0 && k.would_mute / k.scanned > 0.5)
    .map(([id]) => catalog.kinds[id]?.label ?? id), [preview, catalog])

  const toMute = preview?.totals?.to_mute ?? 0
  const toUnmute = preview?.totals?.to_unmute ?? 0
  const ge = preview?.partial ? '≥ ' : ''
  const versionLabel = readiness?.activeVersion?.label ?? 'the active version'

  const submit = async () => {
    setSubmitting(true)
    try {
      await onConfirm(target)
    } finally {
      setSubmitting(false)
    }
  }

  const option = (value: ApplyTarget, title: string, detail: React.ReactNode, disabled: boolean) => (
    <label
      className={`${styles.option} ${target === value ? styles.optionOn : ''} ${disabled ? styles.optionDisabled : ''}`}
    >
      <input
        type="radio"
        name="node-filter-apply-target"
        value={value}
        checked={target === value}
        disabled={disabled}
        onChange={() => setTarget(value)}
      />
      <span>
        <span className={styles.optionTitle}>{title}</span>
        <span className={styles.optionDetail}>{detail}</span>
      </span>
    </label>
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Apply mute rules"
      size="default"
      footer={
        <div className={styles.modalFoot}>
          <button type="button" className={styles.button} onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void submit()}
            disabled={submitting || loading}>
            {submitting && <Loader2 size={12} className={styles.spin} />} Apply
          </button>
        </div>
      }
    >
      <div className={styles.modalBody}>
        <p className={styles.note}>
          {dirty ? 'Saves the rules' : 'Applies the saved rules'} ({mode}, {ruleCount} rule{ruleCount === 1 ? '' : 's'}) and then:
        </p>
        {option('current', `Current graph: ${versionLabel}`,
          blocker ?? (loading
            ? 'Counting…'
            : `Mutes ${ge}${toMute.toLocaleString()} nodes now and unmutes ${ge}${toUnmute.toLocaleString()} rule-muted nodes that no rule matches any more. New scans are not affected.`),
          !!blocker || loading)}
        {option('scans', 'New scans only: full recon and partial recon',
          'Each new scan applies the rules to what it writes. Nothing changes now.', false)}
        {option('both', 'Both', blocker ?? 'The current graph now, and every new scan.', !!blocker || loading)}
        {bigKinds.length > 0 && !blocker && (
          <p className={styles.warnNote}>More than half of {bigKinds.join(', ')} would be muted.</p>
        )}
        {typeof preview?.relatedRemediations === 'number' && preview.relatedRemediations > 0 && !blocker && (
          <p className={styles.note}>
            {preview.relatedRemediations} open CypherFix remediation{preview.relatedRemediations === 1 ? '' : 's'} may
            relate to findings this hides.
          </p>
        )}
      </div>
    </Modal>
  )
}
