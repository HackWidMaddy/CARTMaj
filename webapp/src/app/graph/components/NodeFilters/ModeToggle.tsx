'use client'

import type { NodeFilterMode } from '@/lib/nodeFilters/model'
import styles from './NodeFilters.module.css'

const LABELS: Record<NodeFilterMode, string> = {
  denylist: 'Denylist: mute what matches',
  allowlist: 'Allowlist: keep only what matches',
}

interface ModeToggleProps {
  mode: NodeFilterMode
  onChange: (mode: NodeFilterMode) => void
  disabled?: boolean
}

export function ModeToggle({ mode, onChange, disabled }: ModeToggleProps) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Filter mode">
      {(['denylist', 'allowlist'] as const).map(m => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          className={`${styles.segment} ${mode === m ? styles.segmentActive : ''}`}
          onClick={() => mode !== m && onChange(m)}
          disabled={disabled}
        >
          {LABELS[m]}
        </button>
      ))}
    </div>
  )
}
