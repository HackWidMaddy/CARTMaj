/**
 * CSV formula-injection guard for exports that carry scanner-controlled text.
 *
 * A finding name or host comes from the target. A cell starting with =, +, -,
 * @, a tab or a CR is evaluated by Excel and LibreOffice when the CSV opens, so
 * a target could plant `=HYPERLINK(...)` in an operator's export.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { escapeCsvCellGuarded, guardFormula, toGuardedCsv } from './exportHelpers'

describe('guardFormula', () => {
  test.each(['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx'])('%j is neutralised', v => {
    expect(guardFormula(v)).toBe(`'${v}`)
  })

  test.each(['normal', 'api.example.com', '1-2', 'a=b', ''])('%j is left alone', v => {
    expect(guardFormula(v)).toBe(v)
  })
})

describe('the guarded CSV', () => {
  test('guards every cell, headers included, and still quotes', () => {
    const csv = toGuardedCsv(['name', '=evil'], [{ name: '=HYPERLINK("http://x","a,b")', '=evil': 'ok' }])
    const [header, row] = csv.replace('﻿', '').trim().split('\r\n')
    expect(header).toBe(`name,'=evil`)
    expect(row).toBe(`"'=HYPERLINK(""http://x"",""a,b"")",ok`)
  })

  test('non-string values are flattened first', () => {
    expect(escapeCsvCellGuarded(['-a', 'b'])).toBe(`"'-a, b"`)
    expect(escapeCsvCellGuarded(null)).toBe('')
  })
})
