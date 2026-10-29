'use client'

/**
 * Root error boundary (replaces the ROOT LAYOUT when it or something above the
 * per-segment error.tsx throws, e.g. a render error during hydration/layout).
 *
 * Without this file, such an error falls through to Next.js's built-in fallback,
 * which shows the bare "Application error: a client-side exception has occurred"
 * white screen. That is exactly what surfaced when a starved orchestrator fed the
 * page unexpected/hung data. global-error.tsx must render its own <html>/<body>
 * because it stands in for the root layout, and it only runs in production.
 *
 * It carries no dependency on the app's global stylesheet (that lives in the
 * layout it is replacing), so all styling is inline and self-contained.
 */

import { useEffect } from 'react'

const isChunkLoadError = (error: Error) =>
  error.name === 'ChunkLoadError' ||
  /Loading chunk [\w/.-]+ failed/i.test(error.message) ||
  /Failed to load chunk/i.test(error.message)

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // A stale/rotated build chunk after a redeploy: a hard reload recovers it.
    if (isChunkLoadError(error)) {
      window.location.reload()
      return
    }
    console.error('Global error boundary:', error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          textAlign: 'center',
          fontFamily:
            'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          background: '#0b0f17',
          color: '#e6edf3',
        }}
      >
        <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>
          Something went wrong
        </h2>
        <p style={{ color: '#9aa7b4', maxWidth: 480, margin: 0, lineHeight: 1.5 }}>
          The application hit an unexpected error. The backend may be busy
          (for example while large scans are running). Please try again in a
          few seconds.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            padding: '12px 24px',
            borderRadius: 8,
            fontSize: 16,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  )
}
