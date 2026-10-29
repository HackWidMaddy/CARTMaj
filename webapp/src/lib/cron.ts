/**
 * Minimal 5-field cron parser + "next run" evaluator, for the Scan Scheduler.
 *
 * Deliberately dependency-free: the webapp image is built in Docker, so adding an
 * npm package for this would mean a rebuild everywhere, and we only need standard
 * `minute hour day-of-month month day-of-week` with `*`, `a`, `a-b`, `a-b/n`,
 * `*​/n` and comma lists. Seconds are NOT supported - a scan is not a per-second
 * job, and refusing that syntax is part of the DoS guard (Section 8.3).
 *
 * All evaluation is UTC: schedules are stored as absolute instants, so a server
 * timezone change can never silently move a scan.
 */

export interface CronFields {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  /** True when day-of-month or day-of-week is restricted (they OR together). */
  domRestricted: boolean
  dowRestricted: boolean
}

const RANGES: Array<[number, number]> = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week (0 = Sunday)
]

export class CronParseError extends Error {}

function parseField(spec: string, min: number, max: number, fieldName: string): number[] {
  const values = new Set<number>()

  for (const part of spec.split(',')) {
    const chunk = part.trim()
    if (!chunk) throw new CronParseError(`empty ${fieldName} field`)

    const [rangePart, stepPart] = chunk.split('/')
    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isInteger(step) || step < 1) {
        throw new CronParseError(`invalid step "${stepPart}" in ${fieldName}`)
      }
    }

    let start: number
    let end: number
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [a, b, ...rest] = rangePart.split('-')
      // Both sides must be present. `Number('')` is 0, so an open-ended range like
      // "-5" would otherwise be silently reinterpreted as "0-5" - a typo becoming
      // a schedule that fires at times the user never asked for.
      if (a === '' || b === undefined || b === '' || rest.length > 0) {
        throw new CronParseError(`invalid ${fieldName} range "${rangePart}"`)
      }
      start = Number(a)
      end = Number(b)
    } else {
      if (rangePart === '') {
        throw new CronParseError(`empty ${fieldName} value`)
      }
      start = Number(rangePart)
      end = stepPart !== undefined ? max : start
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new CronParseError(`invalid ${fieldName} value "${rangePart}"`)
    }
    if (start < min || end > max || start > end) {
      throw new CronParseError(`${fieldName} value "${rangePart}" is out of range ${min}-${max}`)
    }

    for (let v = start; v <= end; v += step) values.add(v)
  }

  if (values.size === 0) throw new CronParseError(`${fieldName} matches nothing`)
  return [...values].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronFields {
  if (typeof expr !== 'string') throw new CronParseError('cron expression must be a string')
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new CronParseError(
      `cron expression must have exactly 5 fields (minute hour day month weekday), got ${fields.length}`
    )
  }

  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']
  const parsed = fields.map((f, i) => parseField(f, RANGES[i][0], RANGES[i][1], names[i]))

  return {
    minutes: parsed[0],
    hours: parsed[1],
    daysOfMonth: parsed[2],
    months: parsed[3],
    daysOfWeek: parsed[4],
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
}

/**
 * The next instant at or after `from` (exclusive) matching the expression, in UTC.
 * Returns null if nothing matches within the search horizon (e.g. `0 0 30 2 *`).
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const f = parseCron(expr)

  const cursor = new Date(from.getTime())
  cursor.setUTCSeconds(0, 0)
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)

  // 4 years covers every reachable combination, including leap-day schedules.
  const horizon = new Date(cursor.getTime() + 4 * 366 * 24 * 60 * 60 * 1000)

  while (cursor <= horizon) {
    if (!f.months.includes(cursor.getUTCMonth() + 1)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1)
      cursor.setUTCHours(0, 0, 0, 0)
      continue
    }
    // Standard cron: when BOTH day fields are restricted they are OR'd.
    const domOk = f.daysOfMonth.includes(cursor.getUTCDate())
    const dowOk = f.daysOfWeek.includes(cursor.getUTCDay())
    const dayOk = f.domRestricted && f.dowRestricted ? domOk || dowOk
      : f.domRestricted ? domOk
      : f.dowRestricted ? dowOk
      : true
    if (!dayOk) {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      cursor.setUTCHours(0, 0, 0, 0)
      continue
    }
    if (!f.hours.includes(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (!f.minutes.includes(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0)
      continue
    }
    return cursor
  }
  return null
}

/**
 * Smallest gap the expression can produce, in minutes - the DoS guard.
 * A scan takes many minutes, so anything that can fire more often than
 * SCAN_SCHEDULE_MIN_INTERVAL_MINUTES is rejected at creation.
 */
export function minCronIntervalMinutes(expr: string): number {
  const f = parseCron(expr)
  if (f.minutes.length > 1) {
    let smallest = Infinity
    for (let i = 1; i < f.minutes.length; i++) {
      smallest = Math.min(smallest, f.minutes[i] - f.minutes[i - 1])
    }
    // Wrap-around within the same hour set (…, 59) -> (0) of the next hour.
    if (f.hours.length > 1 || f.hours.length === 24) {
      smallest = Math.min(smallest, 60 - f.minutes[f.minutes.length - 1] + f.minutes[0])
    }
    return smallest
  }
  if (f.hours.length > 1) {
    let smallest = Infinity
    for (let i = 1; i < f.hours.length; i++) {
      smallest = Math.min(smallest, (f.hours[i] - f.hours[i - 1]) * 60)
    }
    return Math.min(smallest, (24 - f.hours[f.hours.length - 1] + f.hours[0]) * 60)
  }
  return 24 * 60
}

/** Describe a cron expression for the UI, best-effort. */
export function describeCron(expr: string): string {
  try {
    parseCron(expr)
    return `cron: ${expr.trim()} (UTC)`
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid cron expression'
  }
}
