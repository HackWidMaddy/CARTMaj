'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { NO_VALUE_OPS, type CatalogKind, type NodeFilterCatalog } from '@/lib/nodeFilters/catalog'
import type { NodeFilterCondition } from '@/lib/nodeFilters/model'
import { LIST_OPS, fieldLabel, opLabel } from './describeCondition'
import { defaultCondition, defaultValue } from './draft'
import styles from './NodeFilters.module.css'

interface ConditionEditorProps {
  catalog: NodeFilterCatalog
  kind: CatalogKind
  condition: NodeFilterCondition
  onChange: (next: NodeFilterCondition) => void
  onRemove: () => void
}

function splitList(text: string): string[] {
  return text.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
}

/** A comma-separated list, kept as typed until it is parsed, so a trailing comma survives. */
function ListInput({ value, onChange, placeholder }: {
  value: unknown; onChange: (v: string[]) => void; placeholder: string
}) {
  const list = Array.isArray(value) ? value.map(String) : []
  const [text, setText] = useState(list.join(', '))
  useEffect(() => {
    if (splitList(text).join('\u0000') !== list.join('\u0000')) setText(list.join(', '))
    // Only an EXTERNAL change should rewrite what the operator is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.join('\u0000')])
  return (
    <input
      className={styles.input}
      value={text}
      placeholder={placeholder}
      onChange={e => { setText(e.target.value); onChange(splitList(e.target.value)) }}
      aria-label="Values, comma separated"
    />
  )
}

export function ConditionEditor({ catalog, kind, condition, onChange, onRemove }: ConditionEditorProps) {
  const field = kind.fields[condition.field]
  const type = field?.type ?? 'text'
  const operators = catalog.operators[type] ?? []
  const op = condition.op
  const scale = field?.scale ? catalog.ordinals[field.scale] ?? [] : []
  const choices = type === 'ordinal' ? scale : field?.values ?? []

  const setField = (name: string) => {
    const next = kind.fields[name]
    if (next) onChange(defaultCondition(name, next, catalog.operators[next.type] ?? []))
  }
  const setOp = (nextOp: string) => {
    if (!field) return
    const keepsValue = (LIST_OPS.has(nextOp) === LIST_OPS.has(op)) && !NO_VALUE_OPS.has(nextOp) &&
      nextOp !== 'between' && op !== 'between' && !(type === 'ordinal' && LIST_OPS.has(nextOp) !== LIST_OPS.has(op))
    const value = keepsValue ? condition.value : defaultValue(nextOp, field)
    onChange({ field: condition.field, op: nextOp, ...(value === undefined ? {} : { value }) })
  }
  const setValue = (value: unknown) => onChange({ ...condition, value })

  const selected = new Set(Array.isArray(condition.value) ? condition.value.map(v => String(v).toLowerCase()) : [])
  const toggleChoice = (choice: string) => {
    const current = Array.isArray(condition.value) ? condition.value.map(String) : []
    const has = current.some(v => v.toLowerCase() === choice.toLowerCase())
    setValue(has ? current.filter(v => v.toLowerCase() !== choice.toLowerCase()) : [...current, choice])
  }
  const addGroup = (group: string[]) => {
    const current = Array.isArray(condition.value) ? condition.value.map(String) : []
    const lower = new Set(current.map(v => v.toLowerCase()))
    setValue([...current, ...group.filter(g => !lower.has(g.toLowerCase()))])
  }

  let valueInput: React.ReactNode = null
  if (NO_VALUE_OPS.has(op)) {
    valueInput = null
  } else if (LIST_OPS.has(op) && choices.length > 0) {
    valueInput = (
      <div className={styles.chips}>
        {Object.entries(field?.value_groups ?? {}).map(([name, group]) => (
          <button key={name} type="button" className={`${styles.chip} ${styles.groupChip}`} onClick={() => addGroup(group)}>
            + {name}
          </button>
        ))}
        {choices.map(choice => (
          <button
            key={choice}
            type="button"
            className={`${styles.chip} ${selected.has(choice.toLowerCase()) ? styles.chipOn : ''}`}
            onClick={() => toggleChoice(choice)}
            aria-pressed={selected.has(choice.toLowerCase())}
          >
            {choice}
          </button>
        ))}
      </div>
    )
  } else if (LIST_OPS.has(op)) {
    valueInput = (
      <ListInput
        value={condition.value}
        onChange={setValue}
        placeholder={type === 'ip' ? '192.0.2.0/24, 2001:db8::/32' : 'value, value'}
      />
    )
  } else if (type === 'ordinal') {
    valueInput = (
      <select className={styles.select} value={String(condition.value ?? '')} onChange={e => setValue(e.target.value)} aria-label="Value">
        <option value="" disabled>choose</option>
        {scale.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    )
  } else if (op === 'between') {
    const pair = Array.isArray(condition.value) ? condition.value : [0, 0]
    valueInput = (
      <>
        <input type="number" className={`${styles.input} ${styles.numberInput}`} value={String(pair[0] ?? '')}
          onChange={e => setValue([Number(e.target.value), pair[1]])} aria-label="From" />
        <span className={styles.and}>AND</span>
        <input type="number" className={`${styles.input} ${styles.numberInput}`} value={String(pair[1] ?? '')}
          onChange={e => setValue([pair[0], Number(e.target.value)])} aria-label="To" />
      </>
    )
  } else if (type === 'number' || op === 'older_than_days' || op === 'newer_than_days') {
    valueInput = (
      <input type="number" className={`${styles.input} ${styles.numberInput}`}
        value={typeof condition.value === 'number' ? String(condition.value) : ''}
        onChange={e => setValue(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Value" />
    )
  } else if (type === 'date') {
    valueInput = (
      <input type="date" className={styles.input} value={String(condition.value ?? '')}
        onChange={e => setValue(e.target.value)} aria-label="Date" />
    )
  } else {
    valueInput = (
      <input className={styles.input} value={String(condition.value ?? '')}
        placeholder={op === 'glob' || op === 'not_glob' ? '*.example.com' : 'value'}
        onChange={e => setValue(e.target.value)} aria-label="Value" />
    )
  }

  return (
    <div className={styles.conditionRow}>
      <select className={styles.select} value={condition.field} onChange={e => setField(e.target.value)} aria-label="Field">
        {!field && <option value={condition.field}>{condition.field} (unknown)</option>}
        {Object.entries(kind.fields).map(([name, f]) => (
          <option key={name} value={name}>{fieldLabel(name, f)}</option>
        ))}
      </select>
      <select className={styles.select} value={op} onChange={e => setOp(e.target.value)} aria-label="Operator">
        {!operators.includes(op) && <option value={op}>{op}</option>}
        {operators.map(o => <option key={o} value={o}>{opLabel(o, type)}</option>)}
      </select>
      {valueInput}
      <button type="button" className={styles.iconButton} onClick={onRemove} aria-label="Remove condition" title="Remove condition">
        <X size={12} />
      </button>
    </div>
  )
}
