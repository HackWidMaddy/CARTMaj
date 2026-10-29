'use client'

import { useEffect, useRef, useState } from 'react'
import { Bookmark, ChevronDown, FolderOpen, Settings2 } from 'lucide-react'
import styles from './NodeFilters.module.css'

interface PresetMenuProps {
  disabled?: boolean
  /** Why Save as preset is off (the rules on screen are invalid), or null when it is on. */
  saveBlockedReason: string | null
  onSave: () => void
  onLoad: () => void
  onManage: () => void
}

export function PresetMenu({ disabled, saveBlockedReason, onSave, onLoad, onManage }: PresetMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const pick = (action: () => void) => () => {
    setOpen(false)
    action()
  }

  return (
    <div className={styles.menuWrap} ref={ref}>
      <button
        type="button"
        className={styles.button}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bookmark size={12} /> Presets <ChevronDown size={12} />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.presetMenuItem}`}
            onClick={pick(onSave)}
            disabled={saveBlockedReason !== null}
            title={saveBlockedReason ?? undefined}
          >
            <Bookmark size={12} /> Save as preset…
          </button>
          <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.presetMenuItem}`} onClick={pick(onLoad)}>
            <FolderOpen size={12} /> Load preset…
          </button>
          <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.presetMenuItem}`} onClick={pick(onManage)}>
            <Settings2 size={12} /> Manage presets…
          </button>
        </div>
      )}
    </div>
  )
}
