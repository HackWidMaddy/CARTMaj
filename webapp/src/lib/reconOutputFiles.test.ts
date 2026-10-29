/**
 * @vitest-environment node
 */
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { batchGroupFiles } from './reconOutputFiles'

describe('batchGroupFiles', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recon-out-'))
  for (const n of ['recon_p1.json', 'recon_p1__a_test.json', 'recon_p1__b_test.json', 'recon_p10__a_test.json',
    'recon_p1__a_test.json.tmp', 'recon_other__p1.json']) writeFileSync(path.join(dir, n), '{}')

  test("only this project's per-group files", async () => {
    expect((await batchGroupFiles(dir, 'p1')).map(p => path.basename(p))).toEqual(
      ['recon_p1__a_test.json', 'recon_p1__b_test.json'])
  })

  test('the id is a literal prefix, never a pattern', async () => {
    expect(await batchGroupFiles(dir, '*')).toEqual([])
    expect(await batchGroupFiles(dir, 'p[0-9]')).toEqual([])
  })

  test('a missing directory is no files', async () => {
    expect(await batchGroupFiles(path.join(dir, 'nope'), 'p1')).toEqual([])
  })
})
