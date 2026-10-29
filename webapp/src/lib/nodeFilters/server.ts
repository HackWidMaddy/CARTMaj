/**
 * Server-side reads shared by the /api/projects/[id]/node-filters routes.
 *
 * A project with no `ProjectNodeFilter` row has empty rules, denylist mode, is
 * not armed, and is at revision 0; the first save creates the row.
 */
import prisma from '@/lib/prisma'
import { EMPTY_NODE_FILTER_DOC, coerceDoc, type NodeFilterDoc, type NodeFilterMode } from './model'
import { readLoadedPreset, type LoadedMuteRulesPreset } from './presets'
import { countActiveRules } from './validate'
import { findLiveNodeFilterRun } from '@/lib/nodeFilterRun'

export interface StoredNodeFilter {
  mode: NodeFilterMode
  applyToScans: boolean
  rules: NodeFilterDoc
  revision: number
  loadedPreset: LoadedMuteRulesPreset | null
  updatedBy: string | null
  updatedAt: string | null
  exists: boolean
}

export async function loadNodeFilter(projectId: string): Promise<StoredNodeFilter> {
  const row = await prisma.projectNodeFilter.findUnique({ where: { projectId } })
  if (!row) {
    return {
      mode: 'denylist', applyToScans: false, rules: EMPTY_NODE_FILTER_DOC, revision: 0,
      loadedPreset: null, updatedBy: null, updatedAt: null, exists: false,
    }
  }
  return {
    mode: row.mode === 'allowlist' ? 'allowlist' : 'denylist',
    applyToScans: row.applyToScans,
    rules: coerceDoc(row.rules),
    revision: row.revision,
    loadedPreset: readLoadedPreset(row.loadedPreset),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    exists: true,
  }
}

export interface NodeFilterStatus {
  armed: boolean
  mode: NodeFilterMode
  activeRules: number
  activeKinds: number
  runningApply: boolean
}

/** What the header tab badges: armed, and how many rules would run on the next scan. */
export async function nodeFilterStatus(projectId: string): Promise<NodeFilterStatus> {
  const stored = await loadNodeFilter(projectId)
  const { rules, kinds } = countActiveRules(stored.mode, stored.rules)
  let runningApply = false
  try {
    runningApply = !!(await findLiveNodeFilterRun(projectId))
  } catch {
    runningApply = false
  }
  return { armed: stored.applyToScans, mode: stored.mode, activeRules: rules, activeKinds: kinds, runningApply }
}

/** The version activation would treat as live; an apply may only target this one. */
export async function activeVersion(projectId: string): Promise<{ id: string; label: string } | null> {
  return prisma.scanVersion.findFirst({
    where: { projectId, isCurrent: true },
    select: { id: true, label: true },
  })
}

export async function exemptionCounts(projectId: string): Promise<Record<string, number>> {
  const rows = await prisma.nodeFilterExemption.groupBy({
    by: ['label'],
    where: { projectId },
    _count: { _all: true },
  })
  return Object.fromEntries(rows.map(r => [r.label, r._count._all]))
}

export async function exemptionPairs(projectId: string): Promise<[string, string][]> {
  const rows = await prisma.nodeFilterExemption.findMany({
    where: { projectId },
    select: { label: true, nodeKey: true },
  })
  return rows.map(r => [r.label, r.nodeKey])
}

export const RUN_SELECT = {
  id: true, status: true, target: true, versionId: true, revision: true, mode: true,
  stats: true, error: true, startedAt: true, heartbeatAt: true, finishedAt: true,
} as const

/** A short account of what a save changed, for the audit row. Counts, not rule text. */
export function diffSummary(before: NodeFilterDoc, after: NodeFilterDoc): Record<string, unknown> {
  const kinds = new Set([...Object.keys(before.kinds ?? {}), ...Object.keys(after.kinds ?? {})])
  const changed: Record<string, { rulesBefore: number; rulesAfter: number; enabledBefore: boolean; enabledAfter: boolean }> = {}
  for (const k of kinds) {
    const b = before.kinds?.[k]
    const a = after.kinds?.[k]
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue
    changed[k] = {
      rulesBefore: b?.rules?.length ?? 0, rulesAfter: a?.rules?.length ?? 0,
      enabledBefore: !!b?.enabled, enabledAfter: !!a?.enabled,
    }
  }
  return { kindsChanged: changed }
}

/** Remediations still being worked on; the rest are closed one way or another. */
const CLOSED_REMEDIATION = ['resolved', 'dismissed', 'no_fix']

/**
 * How many open CypherFix remediations share a CVE or a host with what an
 * apply would newly mute. Remediations carry no link back to their findings
 * (see api/triage/mute/route.ts), so this is "may relate", never "will orphan".
 */
export async function relatedRemediationCount(
  projectId: string,
  related: { hosts?: unknown; cves?: unknown } | undefined,
): Promise<number> {
  const hosts = new Set((Array.isArray(related?.hosts) ? related!.hosts : []).map(h => String(h).toLowerCase()))
  const cves = new Set((Array.isArray(related?.cves) ? related!.cves : []).map(c => String(c).toUpperCase()))
  if (hosts.size === 0 && cves.size === 0) return 0
  const open = await prisma.remediation.findMany({
    where: { projectId, status: { notIn: CLOSED_REMEDIATION } },
    select: { cveIds: true, affectedAssets: true },
  })
  let count = 0
  for (const r of open) {
    const cveHit = (r.cveIds ?? []).some(c => cves.has(String(c).toUpperCase()))
    const assets = Array.isArray(r.affectedAssets) ? (r.affectedAssets as Record<string, unknown>[]) : []
    const hostHit = assets.some(a => [a?.name, a?.ip, a?.url]
      .some(v => typeof v === 'string' && [...hosts].some(h => h && v.toLowerCase().includes(h))))
    if (cveHit || hostHit) count += 1
  }
  return count
}

