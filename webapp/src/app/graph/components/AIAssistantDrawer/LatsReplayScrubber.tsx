/**
 * LATS replay scrubber (Layer 3, §17.3). A slider over the per-wave snapshot
 * history so the operator can replay how the search unfolded. Depends on
 * latsChatState pushing one snapshot to history[] per LATS_TREE_UPDATE.
 */

'use client'

import styles from './LatsTree.module.css'

interface LatsReplayScrubberProps {
  count: number        // number of snapshots in history
  index: number        // currently displayed snapshot index
  onChange: (index: number) => void
}

export function LatsReplayScrubber({ count, index, onChange }: LatsReplayScrubberProps) {
  const isLatest = index >= count - 1
  return (
    <div className={styles.scrubber} data-testid="lats-scrubber">
      <span className={styles.scrubberLabel}>replay</span>
      <input
        type="range"
        min={0}
        max={count - 1}
        step={1}
        value={index}
        aria-label="Replay search rollouts"
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
      />
      <span className={styles.scrubberLabel}>
        {index + 1}/{count}{isLatest ? ' (live)' : ''}
      </span>
    </div>
  )
}
