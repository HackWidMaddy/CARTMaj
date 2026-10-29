'use client'

import { Info } from 'lucide-react'
import styles from './ActiveVersionOnlyNotice.module.css'

interface ActiveVersionOnlyNoticeProps {
  /** Label of the version that IS the live graph (what the panel below shows). */
  activeVersionLabel: string
  /** Label of the past version the user is currently viewing. */
  viewedVersionLabel: string
  onOpenManager?: () => void
}

/**
 * F0: the RedZone / analytics panels run rich Cypher against the LIVE graph by
 * project_id, so they always reflect the ACTIVE version and cannot be recomputed
 * from a stored snapshot. Rather than silently showing active-version numbers
 * under a past-version header, say so - and point at Activate, which is the
 * supported way to analyze an older version.
 */
export function ActiveVersionOnlyNotice({
  activeVersionLabel,
  viewedVersionLabel,
  onOpenManager,
}: ActiveVersionOnlyNoticeProps) {
  return (
    <div className={styles.notice} role="status">
      <Info size={16} className={styles.icon} />
      <div>
        <p className={styles.title}>
          This analysis reflects the active version ({activeVersionLabel})
        </p>
        <p className={styles.text}>
          You are viewing <strong>{viewedVersionLabel}</strong>, a saved snapshot. The graph map
          and node tables show that snapshot, but analytics run against the live graph.{' '}
          {onOpenManager ? (
            <button className={styles.link} onClick={onOpenManager}>
              Activate this version
            </button>
          ) : 'Activate this version'}{' '}
          to analyze it.
        </p>
      </div>
    </div>
  )
}

export default ActiveVersionOnlyNotice
