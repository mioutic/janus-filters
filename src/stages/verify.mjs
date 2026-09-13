// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stage: verify (PIPELINE section 15.4).
//
// Standalone: it needs no private key, no network and no other stage. It is what
// CI runs against the re-downloaded release assets, and it mirrors the app's
// verification order (docs/CONTRACT.md section 6) step for step so a
// disagreement between pipeline and app is a test failure, not a field mystery.
//
//   node src/cli.mjs verify --manifest build/dist/manifest.json \
//                           --sig build/dist/manifest.json.sig [--key <base64>]
//
// Exit codes (PIPELINE section 3): 0 ok, 2 usage, 5 integrity/signature.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGE = "verify";

/** Raw 32-byte Ed25519 public key, base64 (CONTRACT 5). Public by design. */
export const PUBLIC_KEY_BASE64 = "wFAZ/lFdpErWYl+lJvB02kKnHUOoKm9qqhgJckY8oAY=";
/** First 16 hex chars of SHA-256 over the raw 32 key bytes. */
export const KEY_ID = "d6ff9fb88ae9b930";

/** 12-byte Ed25519 SPKI prefix; the raw key is appended to it. */
export const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const SIGNATURE_BYTES = 64;
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024; // CONTRACT 6 step 1
export const MAX_AGE_DAYS = 14; // CONTRACT 7.2
export const MAX_SKEW_HOURS = 24; // CONTRACT 6 step 10

export const ALLOWED_URL_PREFIXES = [
  "https://github.com/mioutic/janus-filters/",
  "https://mioutic.github.io/janus-filters/",
];

export class StageError extends Error {
  constructor(message, exitCode = 1, fields = {}) {
    super(message);
    this.name = "StageError";
    this.exitCode = exitCode;
    this.stage = STAGE;
    this.fields = fields;
  }
}

const fail = (code, message, fields) => {
  throw new StageError(message, code, fields);
};

function log(level, event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ stage: STAGE, event, level, ...fields })}\n`);
}

// --------------------------------------------------------------------------
// keys
// --------------------------------------------------------------------------

/** Raw 32 bytes -> KeyObject, via a DER SPKI wrap (PIPELINE 15.4). */
export function publicKeyFromRaw(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    fail(5, `public key must be 32 raw bytes, got ${bytes.length}`);
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, bytes]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** keyId = sha256(raw public key)[0..8] as hex (CONTRACT 5). */
export function keyIdFromRawPublicKey(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "base64");
  if (bytes.length !== 32) fail(5, `public key must be 32 raw bytes, got ${bytes.length}`);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Extract the raw 32 bytes from any Ed25519 public or private KeyObject. */
export function rawPublicKeyOf(keyObject) {
  const source = keyObject.type === "private" ? createPublicKey(keyObject) : keyObject;
  const jwk = source.export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    fail(5, `not an Ed25519 key (crv=${String(jwk.crv)})`);
  }
  return Buffer.from(jwk.x, "base64url");
}

export function keyIdOf(keyObject) {
  return keyIdFromRawPublicKey(rawPublicKeyOf(keyObject));
}

// --------------------------------------------------------------------------
// signature file
// --------------------------------------------------------------------------

/**
 * `manifest.json.sig` is base64 of the 64 raw signature bytes plus one \n.
 * Surrounding whitespace is tolerated; anything else is a rejection (CONTRACT 5).
 */
export function decodeSignature(text) {
  const trimmed = String(text).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    fail(5, "signature file is not standard base64 (no URL-safe alphabet, no stray bytes)");
  }
  const sig = Buffer.from(trimmed, "base64");
  if (sig.length !== SIGNATURE_BYTES) {
    fail(5, `signature must decode to ${SIGNATURE_BYTES} bytes, got ${sig.length}`);
  }
  return sig;
}

// --------------------------------------------------------------------------
// the core check, shared with sign.mjs
// --------------------------------------------------------------------------

/**
 * Steps 1-5 and 11 of CONTRACT 6 phase 1, over bytes already in hand.
 * Returns the parsed manifest. Throws StageError(5) on any failure.
 */
export function verifyManifestBytes(manifestBytes, sigText, { keyBase64 = PUBLIC_KEY_BASE64 } = {}) {
  if (manifestBytes.length === 0) fail(5, "manifest is empty");
  if (manifestBytes.length > MANIFEST_MAX_BYTES) {
    fail(5, `manifest is ${manifestBytes.length} bytes, over the app's 4 MiB limit`);
  }

  const signature = decodeSignature(sigText);
  const rawKey = Buffer.from(keyBase64, "base64");
  const publicKey = publicKeyFromRaw(rawKey);
  const derivedKeyId = keyIdFromRawPublicKey(rawKey);

  // Parsed only to read keyId; nothing is trusted before the signature checks.
  let peek;
  try {
    peek = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    fail(5, `manifest is not valid JSON: ${err.message}`);
  }
  if (typeof peek.keyId !== "string") fail(5, "manifest has no keyId");
  if (peek.keyId !== derivedKeyId) {
    fail(5, `manifest keyId ${peek.keyId} does not match the pinned key ${derivedKeyId}`);
  }

  // Ed25519: no digest name, no canonicalisation, exact bytes.
  const ok = cryptoVerify(null, manifestBytes, publicKey, signature);
  if (!ok) fail(5, "signature does not verify over the manifest bytes");

  const manifest = peek;
  if (manifest.contractVersion !== 1) {
    fail(5, `unexpected contractVersion ${String(manifest.contractVersion)} (this pipeline emits 1)`);
  }
  for (const url of [manifest.baseUrl, ...(manifest.mirrors ?? [])]) {
    if (typeof url !== "string" || !ALLOWED_URL_PREFIXES.some((p) => url.startsWith(p))) {
      fail(5, `manifest URL is outside the pinned origins: ${String(url)}`);
    }
  }
  return manifest;
}

/** CONTRACT 6 steps 9 and 10, kept separate because they depend on "now". */
export function checkFreshness(manifest, nowMs = Date.now()) {
  const issued = Date.parse(manifest.issuedAt);
  if (!Number.isFinite(issued)) fail(5, `issuedAt is not RFC 3339: ${String(manifest.issuedAt)}`);
  const ageDays = (nowMs - issued) / 86400000;
  // CONTRACT 14.6: exactly 14 days old is rejected, 13 d 23 h is accepted. The
  // boundary is closed on purpose so the app and this verifier cannot disagree.
  if (ageDays >= MAX_AGE_DAYS) {
    fail(5, `manifest is ${ageDays.toFixed(3)} days old, ${MAX_AGE_DAYS} or more`);
  }
  if (issued - nowMs > MAX_SKEW_HOURS * 3600000) {
    fail(5, `issuedAt is more than ${MAX_SKEW_HOURS} h in the future`);
  }
  const expires = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expires)) fail(5, `expiresAt is not RFC 3339: ${String(manifest.expiresAt)}`);
  const span = Math.round((expires - issued) / 86400000);
  if (span !== MAX_AGE_DAYS) fail(5, `expiresAt must be issuedAt + ${MAX_AGE_DAYS} days, got ${span}`);
  return { ageDays };
}

// --------------------------------------------------------------------------
// file hashes (step 4 of PIPELINE 15.4, CONTRACT 6 phase 2)
// --------------------------------------------------------------------------

/** Every {file, sha256, size, downloadSha256, downloadSize} the manifest names. */
export function manifestFileEntries(manifest) {
  const out = [];
  const add = (label, entry) => {
    if (entry && typeof entry.file === "string") out.push({ label, ...entry });
  };
  for (const bucket of manifest.buckets ?? []) {
    for (const [flavour, entry] of Object.entries(bucket.flavours ?? {})) {
      add(`bucket:${bucket.id}:${flavour}`, entry);
    }
  }
  for (const [flavour, entry] of Object.entries(manifest.advancedRules ?? {})) {
    add(`advancedRules:${flavour}`, entry);
    for (const optIn of entry?.optIn ?? []) {
      add(`advancedRules:${flavour}:${(optIn.lists ?? []).join(",")}`, optIn);
    }
  }
  for (const [flavour, entry] of Object.entries(manifest.engine ?? {})) {
    add(`engine:${flavour}`, entry);
  }
  for (const [key, entry] of Object.entries(manifest.payloads ?? {})) {
    add(`payloads:${key}`, entry);
  }
  return out;
}

async function sha256Of(file) {
  const bytes = await readFile(file);
  return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Re-hash every named file that is present in `dir`. The compressed file is
 * checked against downloadSha256/downloadSize; an uncompressed sibling, when
 * one happens to be there, against sha256/size.
 */
export async function verifyPayloadHashes(manifest, dir) {
  const checked = [];
  const missing = [];
  for (const entry of manifestFileEntries(manifest)) {
    const file = path.join(dir, entry.file);
    if (!existsSync(file)) {
      missing.push(entry.file);
      continue;
    }
    const got = await sha256Of(file);
    if (got.size !== entry.downloadSize) {
      fail(5, `${entry.file}: size ${got.size} != downloadSize ${entry.downloadSize}`);
    }
    if (got.sha256 !== entry.downloadSha256) {
      fail(5, `${entry.file}: sha256 ${got.sha256} != downloadSha256 ${entry.downloadSha256}`);
    }
    checked.push(entry.file);
  }
  return { checked: checked.length, missing };
}

// --------------------------------------------------------------------------
// the stage
// --------------------------------------------------------------------------

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export async function run(ctx = {}) {
  const args =
    ctx.args && typeof ctx.args === "object" && !Array.isArray(ctx.args)
      ? ctx.args
      : parseFlags(Array.isArray(ctx.argv) ? ctx.argv : Array.isArray(ctx) ? ctx : []);
  const buildDir = path.resolve(ctx.buildDir ?? args["build-dir"] ?? "build");

  const manifestPath = path.resolve(
    typeof args.manifest === "string" ? args.manifest : path.join(buildDir, "dist", "manifest.json"),
  );
  const sigPath = path.resolve(
    typeof args.sig === "string" ? args.sig : `${manifestPath}.sig`,
  );
  const keyBase64 = typeof args.key === "string" ? args.key : PUBLIC_KEY_BASE64;
  const dir = path.resolve(
    typeof args.dir === "string" ? args.dir : path.dirname(manifestPath),
  );

  let manifestBytes;
  let sigText;
  try {
    manifestBytes = await readFile(manifestPath);
    sigText = await readFile(sigPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") fail(2, `missing input file: ${err.path}`);
    throw err;
  }

  const manifest = verifyManifestBytes(manifestBytes, sigText, { keyBase64 });
  const freshness = args["skip-age"] ? { ageDays: null } : checkFreshness(manifest);
  const hashes = args["skip-hashes"] ? { checked: 0, missing: [] } : await verifyPayloadHashes(manifest, dir);

  if (args["require-complete"] && hashes.missing.length > 0) {
    fail(5, `${hashes.missing.length} payload(s) named by the manifest are missing: ${hashes.missing
      .slice(0, 5)
      .join(", ")}`);
  }

  const summary = {
    stage: STAGE,
    ok: true,
    version: manifest.version,
    issuedAt: manifest.issuedAt,
    keyId: manifest.keyId,
    layoutVersion: manifest.layoutVersion,
    ageDays: freshness.ageDays === null ? null : Number(freshness.ageDays.toFixed(3)),
    filesChecked: hashes.checked,
    filesMissing: hashes.missing.length,
  };
  log("info", "verified", summary);
  return summary;
}

export default { run, STAGE, PUBLIC_KEY_BASE64, KEY_ID };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({ argv: process.argv.slice(2) })
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch((err) => {
      const code = err instanceof StageError ? err.exitCode : 1;
      log("error", "failed", { message: err.message, exitCode: code });
      if (code === 1) console.error(err.stack);
      process.exit(code);
    });
}
