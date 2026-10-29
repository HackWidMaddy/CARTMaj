'use client'

import type { CatalogKind, NodeFilterCatalog } from '@/lib/nodeFilters/catalog'
import type { NodeFilterDoc } from '@/lib/nodeFilters/model'
import styles from './NodeFilters.module.css'

export const LOCKED_ID = '__locked__'

interface KindRailProps {
  catalog: NodeFilterCatalog
  kinds: CatalogKind[]
  doc: NodeFilterDoc
  active: string[]
  selected: string
  onSelect: (kind: string) => void
}

/** The kinds, grouped, with the locked and not-yet-filterable ones listed last. */
export function KindRail({ catalog, kinds, doc, active, selected, onSelect }: KindRailProps) {
  const activeSet = new Set(active)
  const byGroup = catalog.groups.map(g => ({ ...g, kinds: kinds.filter(k => k.group === g.id) }))
  const ruleCount = (id: string) => (doc.kinds[id]?.rules ?? []).filter(r => r.enabled !== false).length

  return (
    <>
      <select
        className={`${styles.select} ${styles.railSelect}`}
        value={selected}
        onChange={e => onSelect(e.target.value)}
        aria-label="Node kind"
      >
        {byGroup.map(g => (
          <optgroup key={g.id} label={g.label}>
            {g.kinds.map(k => (
              <option key={k.id} value={k.id}>
                {k.label}{ruleCount(k.id) ? ` (${ruleCount(k.id)})` : ''}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={LOCKED_ID}>Locked and later phases</option>
      </select>
      <nav className={styles.rail} aria-label="Node kinds">
        {byGroup.map(g => (
          <div key={g.id}>
            <div className={styles.railGroup}>{g.label}</div>
            {g.kinds.map(k => (
              <button
                key={k.id}
                type="button"
                className={`${styles.railItem} ${selected === k.id ? styles.railItemActive : ''}`}
                onClick={() => onSelect(k.id)}
                aria-current={selected === k.id ? 'true' : undefined}
              >
                <span className={activeSet.has(k.id) ? styles.railOn : styles.railOff} aria-hidden="true" />
                {k.label}
                {ruleCount(k.id) > 0 && <span className={styles.railCount}>{ruleCount(k.id)}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className={styles.railGroup}>Locked</div>
        <button
          type="button"
          className={`${styles.railItem} ${selected === LOCKED_ID ? styles.railItemActive : ''}`}
          onClick={() => onSelect(LOCKED_ID)}
        >
          Locked and later phases
          <span className={styles.railCount}>{catalog.locked.length + catalog.planned.length}</span>
        </button>
      </nav>
    </>
  )
}
