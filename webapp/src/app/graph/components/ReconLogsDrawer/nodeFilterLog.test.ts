/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { nodeFilterLineKind } from './nodeFilterLog'

describe('nodeFilterLineKind', () => {
  test('a sweep summary line', () => {
    expect(nodeFilterLineKind(
      '[NODE-FILTER] vuln.nuclei mode=denylist muted=398 unmuted=0 restamped=0 guarded=14 exempt=3',
    )).toBe('summary')
    expect(nodeFilterLineKind('[NODE-FILTER] vuln.nuclei mode=denylist rule="Info" matched=398')).toBe('summary')
  })

  test('a failed or partial sweep', () => {
    expect(nodeFilterLineKind('[!][NODE-FILTER] sweep failed: neo4j down')).toBe('problem')
    expect(nodeFilterLineKind('[!][NODE-FILTER] sweep stopped early; the remaining nodes are unchanged')).toBe('problem')
  })

  test('anything else', () => {
    expect(nodeFilterLineKind('[*][Targets] Merged 50 URLs')).toBeNull()
    expect(nodeFilterLineKind('')).toBeNull()
  })
})
