'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Toggle } from '@/components/ui'
import type { CatalogKind, NodeFilterCatalog } from '@/lib/nodeFilters/catalog'
import type { NodeFilterCondition, NodeFilterMode, NodeFilterRule } from '@/lib/nodeFilters/model'
import { ConditionEditor } from './ConditionEditor'
import { defaultCondition } from './draft'
import type { PreviewSample } from './usePreview'
import styles from './NodeFilters.module.css'

interface RuleCardProps {
  catalog: NodeFilterCatalog
  kind: CatalogKind
  rule: NodeFilterRule
  mode: NodeFilterMode
  matched: number | null
  partial: boolean
  samples: PreviewSample[]
  errors: string[]
  highlighted?: boolean
  onChange: (patch: Partial<NodeFilterRule>) => void
  onRemove: () => void
}

export function RuleCard({
  catalog, kind, rule, mode, matched, partial, samples, errors, highlighted, onChange, onRemove,
}: RuleCardProps) {
  const setCondition = (i: number, next: NodeFilterCondition) =>
    onChange({ all: rule.all.map((c, j) => (j === i ? next : c)) })
  const removeCondition = (i: number) => onChange({ all: rule.all.filter((_, j) => j !== i) })
  const addCondition = () => {
    const [name, field] = Object.entries(kind.fields)[0]
    onChange({ all: [...rule.all, defaultCondition(name, field, catalog.operators[field.type] ?? [])] })
  }
  const verb = mode === 'allowlist' ? 'kept' : 'muted'

  return (
    <div
      className={`${styles.ruleCard} ${rule.enabled ? '' : styles.ruleCardDisabled} ${errors.length ? styles.ruleCardInvalid : ''}`}
      id={`node-filter-rule-${rule.id}`}
      style={highlighted ? { boxShadow: '0 0 0 2px var(--accent-secondary)' } : undefined}
    >
      <div className={styles.ruleHead}>
        <input
          className={styles.ruleName}
          value={rule.name}
          maxLength={80}
          onChange={e => onChange({ name: e.target.value })}
          aria-label="Rule name"
        />
        <span className={styles.ruleMatched} title={`Nodes this rule ${verb === 'kept' ? 'keeps' : 'mutes'} on the active version`}>
          {matched === null ? '·' : `${partial ? '≥ ' : ''}${matched.toLocaleString()}`}
        </span>
        <Toggle
          checked={rule.enabled}
          onChange={enabled => onChange({ enabled })}
          size="small"
          aria-label={`Enable ${rule.name}`}
        />
        <button type="button" className={styles.iconButton} onClick={onRemove} aria-label="Delete rule" title="Delete rule">
          <Trash2 size={12} />
        </button>
      </div>
      <div className={styles.ruleBody}>
        {rule.match_all ? (
          <span className={styles.conditionText}>Every node of this kind</span>
        ) : (
          rule.all.map((cond, i) => (
            <div key={i}>
              {i > 0 && <span className={styles.and}>AND</span>}
              <ConditionEditor
                catalog={catalog}
                kind={kind}
                condition={cond}
                onChange={next => setCondition(i, next)}
                onRemove={() => removeCondition(i)}
              />
            </div>
          ))
        )}
        {!rule.match_all && rule.all.length < catalog.limits.conditions_per_rule && (
          <div>
            <button type="button" className={styles.linkButton} onClick={addCondition}>
              <Plus size={10} /> condition
            </button>
          </div>
        )}
        {errors.map(e => <p key={e} className={styles.ruleError}>{e}</p>)}
      </div>
      {samples.length > 0 && (
        <ul className={styles.samples} aria-label="Examples">
          {samples.map(s => (
            <li key={s.key}>
              <span className={styles.sampleName}>{s.name || s.key}</span>
              {s.host ? ` · ${s.host}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
