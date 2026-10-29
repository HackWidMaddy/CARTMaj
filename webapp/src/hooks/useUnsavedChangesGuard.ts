import { useCallback, useEffect, useId, useRef } from 'react'
import { useAlertModal } from '@/components/ui'
import { useNavigationGuard } from '@/context/NavigationGuardContext'

const DEFAULT_MESSAGE = 'You have unsaved changes. Discard them and leave?'
const DEFAULT_TITLE = 'Discard changes?'

export interface UnsavedChangesGuard {
  /** Resolves true if it is safe to proceed: the form is not dirty, OR the user
   *  confirmed discarding. Resolves false if the user cancelled. */
  confirmDiscard: () => Promise<boolean>
  /** Convenience: run `fn` only if confirmDiscard() resolves true. */
  guardedNavigate: (fn: () => void | Promise<void>) => Promise<void>
}

/**
 * Guards against losing unsaved edits. Generalizes TrafficMind's `requestClose`.
 *
 * While `isDirty`:
 *  - registers a `beforeunload` listener so browser refresh/close/tab-close
 *    prompts (native dialog only - a browser constraint; the custom modal cannot
 *    be shown for real unloads);
 *  - registers `confirmDiscard` with the NavigationGuardContext so the sidebar
 *    (and any in-app navigator that consults it) prompts before navigating.
 *
 * Callers wrap their own explicit exit call sites (Cancel buttons, modal
 * onClose, tab switches, router.push) with `guardedNavigate`/`confirmDiscard`,
 * since App Router has no global route-change interception.
 */
export function useUnsavedChangesGuard(
  isDirty: boolean,
  options?: { message?: string; title?: string; trackGlobal?: boolean },
): UnsavedChangesGuard {
  const alerts = useAlertModal()
  const nav = useNavigationGuard()
  const id = useId()
  const message = options?.message ?? DEFAULT_MESSAGE
  const title = options?.title ?? DEFAULT_TITLE
  // When false, this instance only provides confirmDiscard/guardedNavigate for
  // wrapping local call sites (Cancel/close). It does NOT register the
  // beforeunload listener or the NavigationGuardContext guard -- used by child
  // forms whose dirtiness is aggregated by a parent that registers globally,
  // avoiding a duplicate confirm on the same navigation.
  const trackGlobal = options?.trackGlobal ?? true

  // Read mutable inputs through refs so confirmDiscard can be a STABLE callback.
  // useAlertModal() returns a fresh context object every provider render, so
  // depending on it directly would change confirmDiscard's identity whenever a
  // modal opens/closes, thrashing the guard registration effect (unregister +
  // re-register) mid-navigation. A stable confirmDiscard keeps the registry
  // steady. isDirty is also read live so a late decision sees current state.
  const isDirtyRef = useRef(isDirty)
  isDirtyRef.current = isDirty
  const alertsRef = useRef(alerts)
  alertsRef.current = alerts
  const msgRef = useRef({ message, title })
  msgRef.current = { message, title }
  // Dedupe concurrent confirms (e.g. Escape + Cancel firing together).
  const pendingRef = useRef<Promise<boolean> | null>(null)

  const confirmDiscard = useCallback(async () => {
    if (!isDirtyRef.current) return true
    if (pendingRef.current) return pendingRef.current
    const p = alertsRef.current.confirm(msgRef.current.message, msgRef.current.title)
    pendingRef.current = p
    try {
      return await p
    } finally {
      pendingRef.current = null
    }
  }, [])

  const guardedNavigate = useCallback(
    async (fn: () => void | Promise<void>) => {
      if (await confirmDiscard()) await fn()
    },
    [confirmDiscard],
  )

  // Browser refresh / close / tab-close.
  useEffect(() => {
    if (!trackGlobal || !isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [trackGlobal, isDirty])

  // In-app navigation (sidebar etc.) via the shared guard registry.
  useEffect(() => {
    if (!trackGlobal || !nav || !isDirty) return
    nav.registerGuard(id, confirmDiscard)
    return () => nav.unregisterGuard(id)
  }, [trackGlobal, nav, isDirty, id, confirmDiscard])

  return { confirmDiscard, guardedNavigate }
}
