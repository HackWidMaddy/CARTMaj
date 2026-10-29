// R1: thin server-side audit helper. Emits a structured console line (the repo's
// `[tag]` bracket convention) AND an append-only DB row. Populate the actor going
// forward only. All writes are best-effort: an audit failure must NEVER break the
// underlying request, so every insert is wrapped and swallowed with a log line.
import prisma from '@/lib/prisma'

export interface AuditEntry {
  actorId?: string | null
  action: string
  targetType: string
  targetId?: string | null
  before?: unknown
  after?: unknown
  source?: string // "api" | "ui" | "admin" | "system"
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const line = `[audit] ${entry.action} actor=${entry.actorId ?? '-'} ` +
    `target=${entry.targetType}:${entry.targetId ?? '-'} source=${entry.source ?? 'api'}`
  console.info(line)
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        before: (entry.before ?? undefined) as never,
        after: (entry.after ?? undefined) as never,
        source: entry.source ?? 'api',
      },
    })
  } catch (e) {
    // Never let audit persistence failures break the request path.
    console.error(`[audit] failed to persist ${entry.action}:`, e)
  }
}

export interface ActAsAuditEntry {
  adminId: string
  targetUserId: string
  event: 'start' | 'end'
  source?: string // "api" | "self-clear"
}

export async function writeActAsAudit(entry: ActAsAuditEntry): Promise<void> {
  console.info(`[audit] act-as.${entry.event} admin=${entry.adminId} target=${entry.targetUserId}`)
  try {
    await prisma.actAsAudit.create({
      data: {
        adminId: entry.adminId,
        targetUserId: entry.targetUserId,
        event: entry.event,
        source: entry.source ?? 'api',
      },
    })
  } catch (e) {
    console.error(`[audit] failed to persist act-as.${entry.event}:`, e)
  }
}
