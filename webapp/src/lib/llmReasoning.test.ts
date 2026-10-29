import { describe, expect, test } from 'vitest'
import { isReasoningEffort, REASONING_EFFORTS } from './llmReasoning'

describe('Ollama reasoning effort validation', () => {
  test('accepts every supported UI value', () => {
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'max'])
    for (const effort of REASONING_EFFORTS) {
      expect(isReasoningEffort(effort)).toBe(true)
    }
  })

  test('rejects disabled and unknown wire values as selectable efforts', () => {
    expect(isReasoningEffort('none')).toBe(false)
    expect(isReasoningEffort('extreme')).toBe(false)
    expect(isReasoningEffort(null)).toBe(false)
  })
})
