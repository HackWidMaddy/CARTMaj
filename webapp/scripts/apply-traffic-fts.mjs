/**
 * Apply (or drop) the captured-traffic full-text-search objects — the Phase 3
 * Postgres enrichment (plan §6.3).
 *
 * Prisma can't express tsvector / GIN / extensions, and `prisma db push` would
 * DROP anything not in schema.prisma, so this idempotent script runs from the
 * webapp entrypoint IMMEDIATELY AFTER `db push` (order matters).
 *
 * Gated by CAPTURE_PROXY_FTS: a GIN-over-bodies index is sizable against the 1g
 * Postgres cap, so it exists only when the operator opts in. When the flag is
 * off we DROP the objects to reclaim the space (toggle is bidirectional).
 *
 * The webapp's DATABASE_URL role is the DB superuser, so CREATE EXTENSION works.
 */
import { PrismaClient } from '@prisma/client'

const ENABLED = String(process.env.CAPTURE_PROXY_FTS || '').toLowerCase() === 'true'

// pg_trgm GIN indexes make substring `ILIKE '%…%'` fast on host / path / body.
// Chosen over a tsvector column because the real queries are SUBSTRINGS —
// secrets ("AKIA…"), code identifiers ("NullPointerException"), reflected
// payloads — which a stemmed english tsvector misses. Trigram ILIKE covers
// words AND identifiers AND secrets, and it makes the existing `respBody
// contains` filter index-backed with no query rewrite.
const CREATE = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE INDEX IF NOT EXISTS idx_cht_host_trgm ON captured_http_transactions USING GIN (host gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_cht_path_trgm ON captured_http_transactions USING GIN (path gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_cht_body_trgm ON captured_http_transactions USING GIN (resp_body gin_trgm_ops)`,
]

const DROP = [
  `DROP INDEX IF EXISTS idx_cht_host_trgm`,
  `DROP INDEX IF EXISTS idx_cht_path_trgm`,
  `DROP INDEX IF EXISTS idx_cht_body_trgm`,
]

async function main() {
  const prisma = new PrismaClient()
  const stmts = ENABLED ? CREATE : DROP
  console.log(`[traffic-fts] ${ENABLED ? 'applying' : 'dropping'} body FTS objects...`)
  try {
    for (const sql of stmts) {
      await prisma.$executeRawUnsafe(sql)
    }
    console.log(`[traffic-fts] done (${ENABLED ? 'enabled' : 'disabled'}).`)
  } catch (e) {
    // Never block webapp startup on this — log and continue (FTS just won't work).
    console.warn('[traffic-fts] failed (continuing without FTS):', e?.message || e)
  } finally {
    await prisma.$disconnect()
  }
}

main()
