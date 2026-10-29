'use client'

import { createContext, useCallback, useContext, useRef, ReactNode } from 'react'
import { useRouter } from 'next/navigation'

/** A registered discard-confirmation callback. Resolves true if it is safe to
 *  proceed with navigation (form not dirty, or user confirmed discarding). */
type ConfirmDiscard = () => Promise<boolean>

interface NavigationGuardContextValue {
  /** Register a dirty form's confirm-discard callback. Forms register while
   *  dirty and unregister on cleanup / when they go clean. */
  registerGuard: (id: string, confirm: ConfirmDiscard) => void
  unregisterGuard: (id: string) => void
  /** Consulted by in-app navigators (e.g. the sidebar) BEFORE navigating.
   *  Runs each registered guard; returns false as soon as one is cancelled. */
  confirmAllGuards: () => Promise<boolean>
  /** True when at least one guard is currently registered (i.e. some form is
   *  dirty). Lets navigators cheaply skip the guard machinery when clean. */
  hasGuards: () => boolean
}

const NavigationGuardContext = createContext<NavigationGuardContextValue | null>(null)

/**
 * Bridges dirty forms to in-app navigators that App Router cannot intercept
 * globally (there is no `router.events` in next/navigation). Dirty forms
 * register a confirm-discard callback here via useUnsavedChangesGuard; the
 * sidebar (NavigationBar) calls confirmAllGuards() before following a link.
 */
export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guardsRef = useRef<Map<string, ConfirmDiscard>>(new Map())

  const registerGuard = useCallback((id: string, confirm: ConfirmDiscard) => {
    guardsRef.current.set(id, confirm)
  }, [])

  const unregisterGuard = useCallback((id: string) => {
    guardsRef.current.delete(id)
  }, [])

  const confirmAllGuards = useCallback(async () => {
    // Snapshot before awaiting: a guard's confirm() opens a modal, which
    // re-renders providers and can unregister+re-register the same guard key
    // mid-await. Iterating the live Map would then re-visit the re-added entry
    // and prompt twice. The snapshot pins exactly the guards present at call time.
    const guards = Array.from(guardsRef.current.values())
    for (const confirm of guards) {
      if (!(await confirm())) return false
    }
    return true
  }, [])

  const hasGuards = useCallback(() => guardsRef.current.size > 0, [])

  return (
    <NavigationGuardContext.Provider
      value={{ registerGuard, unregisterGuard, confirmAllGuards, hasGuards }}
    >
      {children}
    </NavigationGuardContext.Provider>
  )
}

/** Returns the guard context, or null when rendered outside the provider (e.g.
 *  in isolated unit tests). Callers must handle the null case. */
export function useNavigationGuard(): NavigationGuardContextValue | null {
  return useContext(NavigationGuardContext)
}

/**
 * A router whose `push` first consults any registered unsaved-changes guards.
 * Use for PROGRAMMATIC navigation (router.push in click handlers, e.g. the
 * project/user selectors) so it prompts before discarding a dirty form. Falls
 * through to a normal push when nothing is dirty. Link-based navigation should
 * use GuardedLink instead.
 */
export function useGuardedRouter(): {
  push: (href: string) => Promise<void>
  /** Navigate without consulting guards - use only after already confirming. */
  pushUnguarded: (href: string) => void
} {
  const router = useRouter()
  const guard = useNavigationGuard()
  const push = useCallback(
    async (href: string) => {
      if (guard && guard.hasGuards() && !(await guard.confirmAllGuards())) return
      router.push(href)
    },
    [router, guard],
  )
  const pushUnguarded = useCallback((href: string) => router.push(href), [router])
  return { push, pushUnguarded }
}
