'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Info, Plus } from 'lucide-react'
import { Toggle } from '@/components/ui'
import type { CatalogKind, NodeFilterCatalog } from '@/lib/nodeFilters/catalog'
import type { NodeFilterDoc, NodeFilterMode, NodeFilterRule } from '@/lib/nodeFilters/model'
import { RuleCard } from './RuleCard'
import { addRule, defaultCondition, kindEntry, removeRule, setKindEnabled, updateRule } from './draft'
import type { PreviewKindStats, PreviewState } from './usePreview'
import styles from './NodeFilters.module.css'

interface KindPanelProps {
  projectId: string
  catalog: NodeFilterCatalog
  kind: CatalogKind
  doc: NodeFilterDoc
  mode: NodeFilterMode
  kindErrors: string[]
  /** Switched on with at least one valid enabled rule: the only case anything is filtered. */
  active: boolean
  preview: PreviewKindStats | null
  previewState: PreviewState
  partial: boolean
  exemptions: number
  focusRuleId?: string
  disabled?: boolean
  onChange: (doc: NodeFilterDoc) => void
  onClearExemptions: (label: string) => void
}

/** "vuln.nuclei rule 2: ..." -> rule index 1. The validator names rules by position. */
function errorsForRule(kindId: string, index: number, errors: string[]): string[] {
  const prefix = `${kindId} rule ${index + 1}`
  return errors.filter(e => e.startsWith(`${prefix}:`) || e.startsWith(`${prefix} `))
}

export function KindPanel({
  projectId, catalog, kind, doc, mode, kindErrors, active, preview, previewState, partial, exemptions,
  focusRuleId, disabled, onChange, onClearExemptions,
}: KindPanelProps) {
  const entry = kindEntry(doc, kind.id)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  useEffect(() => {
    if (!focusRuleId) return
    document.getElementById(`node-filter-rule-${focusRuleId}`)?.scrollIntoView({ block: 'center' })
  }, [focusRuleId, kind.id])

  const newRule = () => {
    const [name, field] = Object.entries(kind.fields)[0]
    onChange(addRule(doc, kind.id, { all: [defaultCondition(name, field, catalog.operators[field.type] ?? [])] }).doc)
  }
  const fromExample = (ex: { name: string; all?: NodeFilterRule['all']; match_all?: boolean }) => {
    onChange(addRule(doc, kind.id, { name: ex.name, all: ex.all ?? [], match_all: ex.match_all }).doc)
    setMenuOpen(false)
  }

  const scanned = preview?.scanned ?? 0
  const would = preview?.would_mute ?? 0
  const ge = partial ? '≥ ' : ''
  const loadingCounts = previewState === 'loading' && !preview
  const verb = mode === 'allowlist' ? 'muted (kept by no rule)' : 'muted'
  const bigShare = scanned > 0 && would / scanned > 0.5
  const missing = Object.entries(preview?.missing ?? {}).filter(([, n]) => n > 0)

  return (
    <section className={styles.panel} aria-label={`${kind.label} rules`}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{kind.label}</h3>
        <span className={styles.behaviour}>MUTE</span>
        <span className={styles.spacer} />
        <Toggle
          checked={entry.enabled}
          onChange={on => onChange(setKindEnabled(doc, kind.id, on))}
          labelOn="On"
          labelOff="Off"
          disabled={disabled}
          aria-label={`Filter ${kind.label}`}
        />
      </div>

      <div className={styles.counts} aria-live="polite">
        {!active ? (
          // An inactive kind is only read for the rule mutes it still has, so
          // its counts would say "0 of 0" about a kind full of findings.
          <span>
            Nothing is filtered.
            {preview && preview.to_unmute > 0 && ` Applying unmutes ${preview.to_unmute.toLocaleString()} rule-muted findings.`}
          </span>
        ) : loadingCounts ? (
          <span>Counting…</span>
        ) : preview ? (
          <>
            <span><span className={styles.countStrong}>{ge}{would.toLocaleString()}</span> of {ge}{scanned.toLocaleString()} would be {verb}</span>
            {preview.guarded > 0 && (
              <span title="A person judged them, or the agent or a triage run confirmed them. Rules never mute these.">
                · {preview.guarded.toLocaleString()} kept by guards <Info size={10} />
              </span>
            )}
            {preview.exempt > 0 && <span>· {preview.exempt.toLocaleString()} exempt</span>}
            {preview.to_unmute > 0 && <span>· unmutes {preview.to_unmute.toLocaleString()}</span>}
            {(previewState === 'busy' || previewState === 'updating') && <span>· updating…</span>}
          </>
        ) : (
          <span>No preview yet.</span>
        )}
      </div>

      {bigShare && entry.enabled && (
        <p className={styles.warnNote}>These rules would mute more than half of this kind.</p>
      )}
      {mode === 'allowlist' && missing.length > 0 && (
        <p className={styles.warnNote}>
          {missing.map(([f, n]) => `${n.toLocaleString()} without ${kind.fields[f]?.label ?? f}`).join(', ')}: a node
          without the field is never kept in allowlist mode.
        </p>
      )}
      {kindErrors.filter(e => !/ rule \d+/.test(e)).map(e => <p key={e} className={styles.ruleError}>{e}</p>)}

      {entry.rules.map((rule, i) => {
        const stats = preview?.rules?.[rule.id]
        return (
          <RuleCard
            key={rule.id}
            catalog={catalog}
            kind={kind}
            rule={rule}
            mode={mode}
            matched={stats ? stats.matched : null}
            partial={partial}
            samples={stats?.samples ?? []}
            errors={errorsForRule(kind.id, i, kindErrors)}
            highlighted={focusRuleId === rule.id}
            onChange={patch => onChange(updateRule(doc, kind.id, rule.id, patch))}
            onRemove={() => onChange(removeRule(doc, kind.id, rule.id))}
          />
        )
      })}

      <div className={styles.panelFoot}>
        <button
          type="button"
          className={styles.button}
          onClick={newRule}
          disabled={disabled || entry.rules.length >= catalog.limits.rules_per_kind}
        >
          <Plus size={12} /> Rule
        </button>
        {kind.examples.length > 0 && (
          <div className={styles.menuWrap} ref={menuRef}>
            <button type="button" className={styles.button} onClick={() => setMenuOpen(o => !o)}
              disabled={disabled} aria-haspopup="menu" aria-expanded={menuOpen}>
              Suggested <ChevronDown size={12} />
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                {kind.examples
                  .filter(ex => mode === 'denylist' || !ex.match_all)
                  .map(ex => (
                    <button key={ex.name} type="button" role="menuitem" className={styles.menuItem} onClick={() => fromExample(ex)}>
                      {ex.name}
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
        <span className={styles.spacer} />
        {exemptions > 0 && (
          <button
            type="button"
            className={styles.button}
            onClick={() => onClearExemptions(kind.graph_label)}
            disabled={disabled}
            title={`Findings an operator unmuted are exempt from every rule. This clears the exemptions on all ${kind.graph_label} findings.`}
          >
            Clear {exemptions.toLocaleString()} exemption{exemptions === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {kind.overlaps.length > 0 && (
        <div className={styles.overlaps}>
          Cheaper at scan time:
          {kind.overlaps.map(o => (
            <a
              key={o.setting}
              className={styles.overlapLink}
              href={`/projects/${encodeURIComponent(projectId)}/settings?tab=${encodeURIComponent(o.tab)}`}
            >
              {o.setting}
            </a>
          ))}
        </div>
      )}
      {kind.notes.map(note => <p key={note} className={styles.note}>{note}</p>)}
    </section>
  )
}
