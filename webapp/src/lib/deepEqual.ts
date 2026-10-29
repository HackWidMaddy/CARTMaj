/**
 * Structural, key-order-independent deep equality.
 *
 * Used by the dirty-state hook (useDirtyState) to decide whether a form's
 * current value still matches its saved/loaded baseline. We deliberately do NOT
 * use `JSON.stringify(a) === JSON.stringify(b)` for this: form state objects
 * (e.g. ProjectFormData) are rebuilt via object-spreads and `Object.keys` loops
 * (applyPreset, handleLoadUserPreset), so key order drifts and stringify would
 * report false "dirty". stringify also silently mishandles `undefined` (dropped)
 * and `NaN` (-> null).
 *
 * Scope: primitives, arrays, and plain objects (Record). Handles NaN and the
 * null/undefined distinction explicitly. Not intended for Map/Set/Date/class
 * instances - the form values we compare are JSON-shaped.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true

  // NaN !== NaN, but two NaNs are "equal" for dirty-tracking purposes.
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b)
  }

  // From here both must be non-null objects of the same array-ness.
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false
  }

  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) return false

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false
    if (!deepEqual(aObj[key], bObj[key])) return false
  }
  return true
}
