/**
 * Vitest global setup.
 *
 * Registers @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * so component tests can assert against DOM presence. Without this, vitest's
 * expect throws "Invalid Chai property: toBeInTheDocument".
 */
import '@testing-library/jest-dom/vitest'

// jsdom ships no ResizeObserver; components that measure their container via the
// useDimensions hook (e.g. the Recon Delta graph overlay) reference it at render.
// A no-op stub keeps them mountable — dimension math is exercised in the browser.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
