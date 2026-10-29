// S2/E2: constant-time string comparison for secret/key checks.
//
// Runtime-agnostic on purpose: this is imported by BOTH the Edge-runtime
// middleware (where Node's `crypto.timingSafeEqual` is unavailable) and Node
// API routes. A pure-JS XOR-accumulate avoids a byte-by-byte short-circuit
// (which `===` on strings can expose to timing analysis) and is length-guarded.
// The length check returns early, which reveals only the length of a 64-hex
// secret (not its bytes) - an accepted, standard trade-off.
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
