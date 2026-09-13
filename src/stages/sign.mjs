// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stage: sign (PIPELINE section 15.3).
//
// Reads the Ed25519 private key from JANUS_FILTER_SIGNING_KEY (PKCS#8 PEM) at
// run time, signs the exact bytes of manifest.json, and writes
// manifest.json.sig as base64 + "\n".
//
// The key material never leaves this process: it is never written to disk, never
// logged, never interpolated into a command line, never put in an artifact and
// never part of an error message. On any failure this stage prints the key's
// **id**, which is public, and nothing else about it.
//
//   node src/cli.mjs sign --manifest build/dist/manifest.json
//
// Exit codes (PIPELINE section 3): 0 ok, 2 usage/missing key, 5 integrity.

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KEY_ID,
  PUBLIC_KEY_BASE64,
  SIGNATURE_BYTES,
  checkFreshness,
  keyIdOf,
  rawPublicKeyOf,
  verifyManifestBytes,
} from "./verify.mjs";

export const STAGE = "sign";
export const KEY_ENV = "JANUS_FILTER_SIGNING_KEY";

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

/**
 * Build the private KeyObject from the environment. The PEM string is used once
 * here and is not returned, stored or echoed. A malformed value produces a
 * message that says only that it failed to parse.
 */
export function privateKeyFromEnv(env = process.env, envName = KEY_ENV) {
  const pem = env[envName];
  if (typeof pem !== "string" || pem.trim() === "") {
    fail(2, `${envName} is not set; signing runs only in the filters-release environment`);
  }
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    fail(2, `${envName} did not parse as a PKCS#8 PEM private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail(2, `${envName} is a ${String(key.asymmetricKeyType)} key; Ed25519 is required`);
  }
  return key;
}

/**
 * Sign `manifestBytes` with `privateKey`. `crypto.sign(null, ...)` is the only
 * correct call for Ed25519 in Node: passing a digest name throws.
 */
export function signManifestBytes(manifestBytes, privateKey) {
  const signature = cryptoSign(null, manifestBytes, privateKey);
  if (signature.length !== SIGNATURE_BYTES) {
    fail(5, `Ed25519 signature must be ${SIGNATURE_BYTES} bytes, got ${signature.length}`);
  }
  return signature;
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
  const sigPath = path.resolve(typeof args.sig === "string" ? args.sig : `${manifestPath}.sig`);
  const envName = typeof args["key-env"] === "string" ? args["key-env"] : KEY_ENV;
  // The public key the app pins. A signature that does not verify against this
  // exact key is a release-stopping bug, so it is checked here, not on a phone.
  const expectedPublicKey =
    typeof args["public-key"] === "string" ? args["public-key"] : PUBLIC_KEY_BASE64;
  const expectedKeyId = typeof args["key-id"] === "string" ? args["key-id"] : KEY_ID;

  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (err) {
    if (err.code === "ENOENT") fail(2, `missing input file: ${manifestPath}`);
    throw err;
  }

  const privateKey = privateKeyFromEnv(process.env, envName);
  const derivedKeyId = keyIdOf(privateKey);
  const derivedPublicKey = rawPublicKeyOf(privateKey).toString("base64");

  if (derivedKeyId !== expectedKeyId) {
    fail(
      5,
      `the signing key's id is ${derivedKeyId} but the manifest and the app pin ${expectedKeyId}; ` +
        "rolling the key needs an app update (CONTRACT 5)",
    );
  }
  if (derivedPublicKey !== expectedPublicKey) {
    fail(5, `the signing key's public half does not match the pinned public key (keyId ${derivedKeyId})`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    fail(5, `manifest is not valid JSON: ${err.message}`);
  }
  if (manifest.keyId !== derivedKeyId) {
    fail(5, `manifest.keyId ${String(manifest.keyId)} does not match the signing key id ${derivedKeyId}`);
  }
  if (manifestBytes.at(-1) === 0x0a) {
    fail(5, "manifest.json ends with a newline; the signed bytes end at the final } (PIPELINE 15.2)");
  }

  const signature = signManifestBytes(manifestBytes, privateKey);
  await writeFile(sigPath, `${signature.toString("base64")}\n`, "utf8");

  // Immediately verify with the shipped *public* key, exactly as the app will.
  const sigText = await readFile(sigPath, "utf8");
  verifyManifestBytes(manifestBytes, sigText, { keyBase64: expectedPublicKey });
  const freshness = checkFreshness(manifest);

  const summary = {
    stage: STAGE,
    ok: true,
    version: manifest.version,
    issuedAt: manifest.issuedAt,
    keyId: derivedKeyId,
    manifestBytes: manifestBytes.length,
    signature: path.basename(sigPath),
    ageDays: Number(freshness.ageDays.toFixed(3)),
  };
  log("info", "signed", summary);
  return summary;
}

export default { run, STAGE, KEY_ENV };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({ argv: process.argv.slice(2) })
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch((err) => {
      const code = err instanceof StageError ? err.exitCode : 1;
      // Never include environment values in a failure message.
      log("error", "failed", { message: err.message, exitCode: code });
      if (code === 1) console.error(err.stack);
      process.exit(code);
    });
}
