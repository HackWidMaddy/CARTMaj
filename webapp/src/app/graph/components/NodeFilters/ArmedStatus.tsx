'use client'

import styles from './NodeFilters.module.css'

interface ArmedStatusProps {
  armed: boolean
  rules: number
  kinds: number
  mode: string
  onTurnOff: () => void
  busy?: boolean
}

/** Whether new scans apply the saved rules, and the one-click way to stop that. */
export function ArmedStatus({ armed, rules, kinds, mode, onTurnOff, busy }: ArmedStatusProps) {
  if (!armed) {
    return <span className={styles.notArmed}>Not applied to new scans</span>
  }
  return (
    <>
      <span className={styles.armed} title="Every new full or partial recon applies the saved rules to what it writes">
        <span className={styles.armedDot} aria-hidden="true" />
        Active on new scans · {rules} rule{rules === 1 ? '' : 's'} in {kinds} kind{kinds === 1 ? '' : 's'} · {mode}
      </span>
      <button type="button" className={styles.button} onClick={onTurnOff} disabled={busy}>
        Turn off
      </button>
    </>
  )
}
