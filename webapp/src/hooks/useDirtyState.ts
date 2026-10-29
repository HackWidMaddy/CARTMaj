import { useCallback, useState } from 'react'
import { deepEqual } from '@/lib/deepEqual'

export interface DirtyState<T> {
  /** true when `current` differs from `baseline` under the equality strategy. */
  isDirty: boolean
  /** The current baseline (last saved/loaded canonical value). */
  baseline: T
  /**
   * Adopt a new canonical baseline, which clears dirtiness. Call after a
   * successful save (adopt the just-saved value) OR after an async load resolves
   * the real initial value (so transient placeholder state is not treated as
   * the baseline). Accepts a value or a functional updater (like setState) so a
   * single field can be adopted without a stale-closure read of the baseline.
   */
  setBaseline: (next: T | ((prev: T) => T)) => void
}

/**
 * Generic value-based dirty tracking. Compares the caller's `current` value to a
 * baseline snapshot and derives `isDirty` on every render.
 *
 * Generalizes the TrafficMind pattern (captureSettingsForm.ts): a saved
 * snapshot + a derived `dirty` flag, minus the domain-specific diff engine. The
 * baseline lives in state (not a ref) so `setBaseline` triggers a re-render and
 * `isDirty` recomputes. `current` is the caller's own state, so an edit already
 * re-renders the consumer and re-derives `isDirty` inline.
 *
 * Reverting an edit back to the baseline clears dirtiness (value-based, not a
 * sticky boolean).
 */
export function useDirtyState<T>(
  current: T,
  options?: { isEqual?: (a: T, b: T) => boolean },
): DirtyState<T> {
  const isEqual = options?.isEqual ?? deepEqual
  const [baseline, setBaselineState] = useState<T>(current)

  const setBaseline = useCallback((next: T | ((prev: T) => T)) => {
    setBaselineState(next)
  }, [])

  return {
    isDirty: !isEqual(baseline, current),
    baseline,
    setBaseline,
  }
}
