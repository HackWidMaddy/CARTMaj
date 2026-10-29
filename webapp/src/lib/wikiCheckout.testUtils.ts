/**
 * Whether the doc-drift tests can compare against the wiki checkout.
 *
 * CART.wiki is a git submodule, so a clone made without
 * `--recurse-submodules` leaves the directory EMPTY. Skipping there made a test
 * pass while checking nothing, so an empty checkout is a failure unless
 * CART_TEST_ALLOW_MISSING names `wiki` (or `all`), the gate's named opt-out
 * for an input a working copy lacks. The Python twin is
 * tooling/scripts/wiki_checkout.py.
 */
import { existsSync } from 'fs'
import path from 'path'

export function wikiMissingAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = (env.CART_TEST_ALLOW_MISSING ?? '').split(',').map(n => n.trim())
  return names.includes('wiki') || names.includes('all')
}

/** True when the wiki is checked out; false when it is absent and that is allowed. */
export function wikiCheckoutPresent(wikiDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(wikiDir, 'Home.md'))) return true
  if (wikiMissingAllowed(env)) return false
  throw new Error(
    `No wiki checkout at ${wikiDir}: run \`git submodule update --init CART.wiki\`, ` +
    'or set CART_TEST_ALLOW_MISSING=wiki to skip the wiki checks.',
  )
}
