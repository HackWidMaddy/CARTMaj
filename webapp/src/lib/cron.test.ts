/**
 * Scan Scheduler — cron parsing + next-run evaluation (Section 7).
 *
 * All evaluation is UTC, so schedules do not move when the host timezone does.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { parseCron, nextCronRun, minCronIntervalMinutes, CronParseError } from './cron'

const at = (iso: string) => new Date(iso)

describe('parseCron', () => {
  test('accepts the standard 5 fields', () => {
    const f = parseCron('0 3 * * *')
    expect(f.minutes).toEqual([0])
    expect(f.hours).toEqual([3])
    expect(f.daysOfMonth).toHaveLength(31)
    expect(f.months).toHaveLength(12)
    expect(f.daysOfWeek).toHaveLength(7)
  })

  test('supports lists, ranges and steps', () => {
    expect(parseCron('0,30 * * * *').minutes).toEqual([0, 30])
    expect(parseCron('0 9-17 * * *').hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parseCron('0 0-23/6 * * *').hours).toEqual([0, 6, 12, 18])
    expect(parseCron('0 3 * * 1-5').daysOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  test.each([
    ['too few fields', '0 3 * *'],
    ['too many fields (seconds are not supported)', '*/5 0 3 * * *'],
    ['out of range minute', '60 * * * *'],
    ['out of range hour', '0 24 * * *'],
    ['inverted range', '0 17-9 * * *'],
    ['zero step', '*/0 * * * *'],
    ['garbage', 'every minute'],
    ['empty', ''],
    // Number('') is 0, so an open-ended range used to be silently reinterpreted:
    // "-5" became "0-5", i.e. a schedule firing at times the user never asked for.
    ['a range with no lower bound', '-5 * * * *'],
    ['a range with no upper bound', '5- * * * *'],
    ['an hour range with no lower bound', '0 -5 * * *'],
    ['a bare dash', '- * * * *'],
    ['a step with no value', '*/ * * * *'],
  ])('rejects %s', (_desc, expr) => {
    expect(() => parseCron(expr)).toThrow(CronParseError)
  })
})

describe('nextCronRun', () => {
  test('daily at 03:00 UTC', () => {
    expect(nextCronRun('0 3 * * *', at('2026-07-30T01:00:00Z'))!.toISOString())
      .toBe('2026-07-30T03:00:00.000Z')
    // After today's run it rolls to tomorrow.
    expect(nextCronRun('0 3 * * *', at('2026-07-30T03:00:00Z'))!.toISOString())
      .toBe('2026-07-31T03:00:00.000Z')
  })

  test('never returns the instant it was asked from (no double-fire)', () => {
    const from = at('2026-07-30T03:00:00Z')
    expect(nextCronRun('0 3 * * *', from)!.getTime()).toBeGreaterThan(from.getTime())
  })

  test('weekday-only schedules skip the weekend', () => {
    // 2026-08-01 is a Saturday.
    expect(nextCronRun('0 6 * * 1-5', at('2026-07-31T07:00:00Z'))!.toISOString())
      .toBe('2026-08-03T06:00:00.000Z')
  })

  test('day-of-month and day-of-week are OR-ed, as standard cron does', () => {
    // "the 1st OR any Monday"
    const next = nextCronRun('0 0 1 * 1', at('2026-08-02T00:00:00Z'))!
    expect(next.toISOString()).toBe('2026-08-03T00:00:00.000Z') // the Monday
  })

  test('month restrictions roll over the year', () => {
    expect(nextCronRun('0 0 1 1 *', at('2026-07-30T00:00:00Z'))!.toISOString())
      .toBe('2027-01-01T00:00:00.000Z')
  })

  test('an impossible date returns null instead of looping forever', () => {
    expect(nextCronRun('0 0 30 2 *', at('2026-01-01T00:00:00Z'))).toBeNull()
  })

  test('a leap-day schedule still resolves within the horizon', () => {
    expect(nextCronRun('0 0 29 2 *', at('2026-03-01T00:00:00Z'))!.toISOString())
      .toBe('2028-02-29T00:00:00.000Z')
  })
})

describe('minCronIntervalMinutes (DoS guard)', () => {
  test('every-minute is 1', () => {
    expect(minCronIntervalMinutes('* * * * *')).toBe(1)
  })

  test('*/15 is 15', () => {
    expect(minCronIntervalMinutes('*/15 * * * *')).toBe(15)
  })

  test('twice a day is 12 hours', () => {
    expect(minCronIntervalMinutes('0 0,12 * * *')).toBe(12 * 60)
  })

  test('a single daily run is a day', () => {
    expect(minCronIntervalMinutes('0 3 * * *')).toBe(24 * 60)
  })

  test('minute wrap-around across hours is counted', () => {
    // 0 and 59 every hour = a 1-minute gap between :59 and the next :00.
    expect(minCronIntervalMinutes('0,59 * * * *')).toBe(1)
  })
})
