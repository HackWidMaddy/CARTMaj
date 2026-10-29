'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { forwardRef, type ComponentProps, type MouseEvent } from 'react'
import { useNavigationGuard } from '@/context/NavigationGuardContext'

type LinkProps = ComponentProps<typeof Link>

/**
 * Drop-in replacement for next/link that consults the NavigationGuardContext
 * before navigating. When a dirty form has registered a guard, an internal
 * client-side navigation is blocked until the user confirms discarding their
 * changes (App Router has no global route-change interception, so navigation is
 * guarded by wrapping the anchors themselves).
 *
 * Falls through to normal <Link> behaviour when: no guard is registered,
 * the click is modified (new tab/window), or the href is external - those
 * cases either don't lose in-app state or trigger a real unload that the
 * beforeunload handler already covers.
 */
export const GuardedLink = forwardRef<HTMLAnchorElement, LinkProps>(
  function GuardedLink({ href, onClick, ...rest }, ref) {
    const router = useRouter()
    const guard = useNavigationGuard()

    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e)
      if (e.defaultPrevented) return
      if (!guard || !guard.hasGuards()) return
      // Modified clicks open a new tab/window - the current form is untouched.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      // Only guard internal string hrefs; external URLs do a full unload
      // (covered by beforeunload) and non-string hrefs are rare app routes.
      const url = typeof href === 'string' ? href : null
      if (!url || /^[a-z]+:\/\//i.test(url) || url.startsWith('mailto:')) return
      e.preventDefault()
      void guard.confirmAllGuards().then((ok) => {
        if (ok) router.push(url)
      })
    }

    return <Link href={href} onClick={handleClick} ref={ref} {...rest} />
  },
)
