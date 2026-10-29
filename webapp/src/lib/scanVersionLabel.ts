/**
 * Version label validation (Section 8.3: untrusted input).
 *
 * A label is free text a user types and every other user of that project sees.
 * It is stored parameterized (Prisma) and rendered as text by React (never
 * dangerouslySetInnerHTML), so the job here is bounding it, not escaping it:
 * trim, cap the length, and reject control characters that would corrupt logs
 * and table layout.
 */
export const MAX_VERSION_LABEL_LENGTH = 120

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/**
 * Returns the cleaned label, `null` when absent (caller keeps the existing one),
 * or an Error describing why it was rejected.
 */
export function sanitizeVersionLabel(raw: unknown): string | null | Error {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return new Error('label must be a string')

  const trimmed = raw.trim()
  if (!trimmed) return new Error('label cannot be empty')
  if (trimmed.length > MAX_VERSION_LABEL_LENGTH) {
    return new Error(`label is too long (max ${MAX_VERSION_LABEL_LENGTH} characters)`)
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return new Error('label cannot contain control characters')
  }
  return trimmed
}
