import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time token comparison. A plain `===` on a secret leaks information
 * through timing (it returns faster on an early-mismatching byte), which over
 * many attempts can reveal the token. timingSafeEqual compares in time
 * independent of where the first difference is. We hash-pad to equal length so
 * the length itself isn't a side channel and timingSafeEqual's equal-length
 * requirement is always met.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths; compare against a same-length
  // copy of `a` first so we still run the constant-time check either way.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
