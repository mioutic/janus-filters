// Hashing. The FNV-1a here decides every bucket assignment, so it is pinned by a
// unit test with known vectors and must never be "improved": changing it
// reshuffles every bucket and forces the phone to re-download the whole set.
// PIPELINE section 10.3.

import { createHash } from "node:crypto";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over the UTF-8 bytes of `input`.
 * @param {string|Uint8Array} input
 * @returns {number} unsigned 32-bit
 */
export function fnv1a32(input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  let hash = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** SHA-256, lower-case hex. */
export function sha256hex(input) {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return createHash("sha256").update(data).digest("hex");
}

/** The first 8 hex characters of the SHA-256, which the app appends to a bucket id. */
export function sha8(input) {
  return sha256hex(input).slice(0, 8);
}

/** Two-digit zero-padded bucket number. */
export function pad2(n) {
  return String(n).padStart(2, "0");
}
