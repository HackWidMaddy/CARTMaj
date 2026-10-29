/**
 * Scan Timeline - Scan Scheduler validation + RAM feasibility (Section 7).
 *
 * Two independent guards, because they fail differently:
 *
 *  - VALIDATION (here, at creation): shape, enum, cron parse, and a minimum
 *    interval so a `* * * * *` cannot spawn scans faster than they finish
 *    (Section 8.3 scheduler DoS).
 *  - RAM FEASIBILITY (here, static, advisory): reject a schedule that could never
 *    be admitted (its envelope alone exceeds the whole scan pool), or that
 *    time-overlaps other schedules such that the summed envelopes exceed the pool.
 *    Overlap is computed across ALL projects, because the memory pool is global.
 *    This is a courtesy check - the AUTHORITATIVE gate is the admission ledger at
 *    execution time (Section 7.3), which is why over-admitting here is survivable.
 */
import { nextCronRun, minCronIntervalMinutes, parseCron, CronParseError } from '@/lib/cron'

export type ScheduleMode = 'once' | 'interval' | 'cron'
export type ScheduleScanMode = 'new' | 'overwrite'

export interface ScheduleInput {
  mode: ScheduleMode
  runAt?: string | Date | null
  intervalMinutes?: number | null
  cronExpr?: string | null
  scanMode?: ScheduleScanMode
  label?: string
  enabled?: boolean
}

export interface ValidatedSchedule {
  mode: ScheduleMode
  runAt: Date | null
  intervalMinutes: number | null
  cronExpr: string | null
  scanMode: ScheduleScanMode
  label: string
  enabled: boolean
  nextRunAt: Date | null
}

export class ScheduleValidationError extends Error {}

/** A full recon takes many minutes; anything tighter is a self-inflicted DoS. */
export function minIntervalMinutes(): number {
  const raw = parseInt(process.env.SCAN_SCHEDULE_MIN_INTERVAL_MINUTES || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 15
}

export const MAX_SCHEDULE_LABEL_LENGTH = 120

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/**
 * Shared label check (Section 8.3). Returns the trimmed label, null when absent,
 * or an Error describing why it was rejected.
 */
export function sanitizeScheduleLabel(raw: unknown): string | null | Error {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return new Error('label must be a string')
  const trimmed = raw.trim()
  if (trimmed.length > MAX_SCHEDULE_LABEL_LENGTH) {
    return new Error(`label is too long (max ${MAX_SCHEDULE_LABEL_LENGTH} characters)`)
  }
  if (CONTROL_CHARS.test(trimmed)) return new Error('label cannot contain control characters')
  return trimmed
}

export function validateSchedule(input: unknown, now: Date = new Date()): ValidatedSchedule {
  if (!input || typeof input !== 'object') throw new ScheduleValidationError('invalid request body')
  const body = input as ScheduleInput

  const mode = body.mode
  if (mode !== 'once' && mode !== 'interval' && mode !== 'cron') {
    throw new ScheduleValidationError("mode must be 'once', 'interval' or 'cron'")
  }

  const scanMode = body.scanMode ?? 'new'
  if (scanMode !== 'new' && scanMode !== 'overwrite') {
    throw new ScheduleValidationError("scanMode must be 'new' or 'overwrite'")
  }

  const cleanedLabel = sanitizeScheduleLabel(body.label)
  if (cleanedLabel instanceof Error) throw new ScheduleValidationError(cleanedLabel.message)
  const label = cleanedLabel ?? ''

  const enabled = body.enabled === undefined ? true : Boolean(body.enabled)
  const min = minIntervalMinutes()

  let runAt: Date | null = null
  let intervalMinutes: number | null = null
  let cronExpr: string | null = null
  let nextRunAt: Date | null = null

  if (mode === 'once') {
    if (!body.runAt) throw new ScheduleValidationError('runAt is required for a one-off schedule')
    runAt = new Date(body.runAt as string)
    if (Number.isNaN(runAt.getTime())) throw new ScheduleValidationError('runAt is not a valid date')
    if (runAt.getTime() <= now.getTime()) {
      throw new ScheduleValidationError('runAt must be in the future')
    }
    nextRunAt = runAt
  } else if (mode === 'interval') {
    const value = Number(body.intervalMinutes)
    if (!Number.isInteger(value) || value <= 0) {
      throw new ScheduleValidationError('intervalMinutes must be a positive whole number of minutes')
    }
    if (value < min) {
      throw new ScheduleValidationError(
        `intervalMinutes must be at least ${min} (a full scan takes longer than that to finish)`
      )
    }
    intervalMinutes = value
    // An interval schedule starts one interval from now unless a first run is given.
    if (body.runAt) {
      const first = new Date(body.runAt as string)
      if (Number.isNaN(first.getTime())) throw new ScheduleValidationError('runAt is not a valid date')
      runAt = first
      nextRunAt = first.getTime() > now.getTime() ? first : new Date(now.getTime() + value * 60_000)
    } else {
      nextRunAt = new Date(now.getTime() + value * 60_000)
    }
  } else {
    const expr = typeof body.cronExpr === 'string' ? body.cronExpr.trim() : ''
    if (!expr) throw new ScheduleValidationError('cronExpr is required for a cron schedule')
    try {
      parseCron(expr)
    } catch (err) {
      throw new ScheduleValidationError(
        err instanceof CronParseError ? `invalid cron expression: ${err.message}` : 'invalid cron expression'
      )
    }
    const smallest = minCronIntervalMinutes(expr)
    if (smallest < min) {
      throw new ScheduleValidationError(
        `this cron expression can fire every ${smallest} minute(s); the minimum is ${min}`
      )
    }
    cronExpr = expr
    nextRunAt = nextCronRun(expr, now)
    if (!nextRunAt) throw new ScheduleValidationError('this cron expression never matches a real date')
  }

  return { mode, runAt, intervalMinutes, cronExpr, scanMode, label, enabled, nextRunAt }
}

/** Recompute the next fire time after a run. Null disables the schedule (`once`). */
export function computeNextRun(
  schedule: { mode: string; intervalMinutes: number | null; cronExpr: string | null },
  after: Date = new Date()
): Date | null {
  if (schedule.mode === 'interval' && schedule.intervalMinutes) {
    return new Date(after.getTime() + schedule.intervalMinutes * 60_000)
  }
  if (schedule.mode === 'cron' && schedule.cronExpr) {
    return nextCronRun(schedule.cronExpr, after)
  }
  return null
}

// ---------------------------------------------------------------- RAM ------

export interface EnvelopeInfo {
  /** Bytes a single full recon reserves. */
  envelopeBytes: number
  /** Bytes available to scans in total. */
  scanPoolBytes: number
}

export interface ExistingSchedule {
  id: string
  nextRunAt: Date | null
  estimatedEnvelopeBytes: bigint | number | null
}

export interface FeasibilityResult {
  feasible: boolean
  reason?: string
  limitType?: 'hard' | 'ram'
  detail?: string
  conflictingScheduleIds?: string[]
}

/** How long a scheduled scan is assumed to occupy its envelope. */
export function assumedRunMinutes(): number {
  const raw = parseInt(process.env.SCAN_SCHEDULE_ASSUMED_RUN_MINUTES || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 60
}

/**
 * Static feasibility (Section 7.3). `others` are the enabled schedules of ALL
 * projects, since the memory pool is global.
 */
export function checkScheduleFeasibility(
  nextRunAt: Date | null,
  env: EnvelopeInfo,
  others: ExistingSchedule[]
): FeasibilityResult {
  if (!env.scanPoolBytes || !env.envelopeBytes) {
    // The governor is disabled or unknown - admission stays fail-open by design.
    return { feasible: true }
  }

  if (env.envelopeBytes > env.scanPoolBytes) {
    return {
      feasible: false,
      limitType: 'ram',
      reason: 'never-admittable',
      detail:
        `A full scan needs ${mb(env.envelopeBytes)} MB but this host only has ` +
        `${mb(env.scanPoolBytes)} MB available for scans, so this schedule could never run.`,
    }
  }

  if (!nextRunAt) return { feasible: true }

  const windowMs = assumedRunMinutes() * 60_000
  const start = nextRunAt.getTime()
  const end = start + windowMs

  const overlapping = others.filter(o => {
    if (!o.nextRunAt) return false
    const oStart = new Date(o.nextRunAt).getTime()
    return oStart < end && oStart + windowMs > start
  })

  const summed = overlapping.reduce(
    (acc, o) => acc + Number(o.estimatedEnvelopeBytes ?? env.envelopeBytes),
    env.envelopeBytes
  )

  if (summed > env.scanPoolBytes) {
    return {
      feasible: false,
      limitType: 'ram',
      reason: 'overlap',
      detail:
        `This run would overlap ${overlapping.length} other scheduled scan(s) in the same window; ` +
        `together they need ${mb(summed)} MB but only ${mb(env.scanPoolBytes)} MB is available for scans. ` +
        'Move it to a different time or stagger the other schedules.',
      conflictingScheduleIds: overlapping.map(o => o.id),
    }
  }

  return { feasible: true }
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}
