// SPDX-License-Identifier: GPL-3.0-or-later
//
// The shared conformance vectors of CONTRACT section 14. These exact files are
// copied into the app's TestVectors/ (DESIGN 9.1), so a divergence between the two
// verifiers shows up as a failing unit test on both sides instead of as a phone
// that quietly stops updating.
//
// Every vector here runs through the code the pipeline itself uses: nothing is
// asserted against a second implementation written for the test.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { bucketIdentifier, flavourForIOSMajor, isUpdate } from "../src/lib/contract.mjs";
import {
  KEY_ID,
  MAX_AGE_DAYS,
  MAX_SKEW_HOURS,
  checkFreshness,
  keyIdFromRawPublicKey,
  verifyManifestBytes,
} from "../src/stages/verify.mjs";

const DIR = path.join(import.meta.dirname, "fixtures", "contract");
const load = async (name) => JSON.parse(await readFile(path.join(DIR, name), "utf8"));

test("14.1 keyId derivation", async () => {
  const doc = await load("keyid.json");
  for (const vector of doc.vectors) {
    const raw = Buffer.from(vector.publicKeyBase64, "base64");
    assert.equal(raw.length, 32, vector.publicKeyBase64);
    assert.equal(keyIdFromRawPublicKey(raw), vector.keyId);
    if (vector.pinned) assert.equal(vector.keyId, KEY_ID);
  }
});

test("14.2 signature round trip, and a single flipped byte is rejected", async () => {
  const doc = await load("signature.json");
  const bytes = Buffer.from(doc.manifest, "utf8");
  const sig = doc.signatureBase64;
  const manifest = verifyManifestBytes(bytes, sig, { keyBase64: doc.publicKeyBase64 });
  assert.equal(manifest.keyId, doc.keyId);
  assert.equal(manifest.contractVersion, 1);

  for (const rejection of doc.mustReject) {
    if (rejection.manifestPatch) {
      const tampered = Buffer.from(bytes);
      tampered[rejection.manifestPatch.atByte] = rejection.manifestPatch.toByte;
      assert.notDeepEqual(tampered, bytes, rejection.why);
      assert.throws(
        () => verifyManifestBytes(tampered, sig, { keyBase64: doc.publicKeyBase64 }),
        /signature does not verify|keyId/,
        rejection.why,
      );
    }
    if (rejection.signaturePatch) {
      const raw = Buffer.from(sig, "base64");
      raw[rejection.signaturePatch.atByte] ^= 0x01;
      assert.throws(
        () => verifyManifestBytes(bytes, raw.toString("base64"), { keyBase64: doc.publicKeyBase64 }),
        /signature does not verify/,
        rejection.why,
      );
    }
  }
});

test("14.3 identifier derivation", async () => {
  const doc = await load("identifier.json");
  for (const vector of doc.vectors) {
    assert.equal(bucketIdentifier(vector.bucketId, vector.sha256), vector.identifier);
  }
});

test("14.4 flavour selection", async () => {
  const doc = await load("flavour.json");
  for (const vector of doc.vectors) {
    assert.equal(flavourForIOSMajor(vector.iosMajor), vector.flavour);
  }
  for (const major of doc.mustThrow) assert.throws(() => flavourForIOSMajor(major));
});

test("14.5 version comparison", async () => {
  const doc = await load("version.json");
  for (const vector of doc.vectors) {
    assert.equal(isUpdate(vector.candidate, vector.installed), vector.isUpdate, vector.why ?? "");
  }
});

test("14.6 age arithmetic, boundary included", async () => {
  const doc = await load("age.json");
  assert.equal(doc.maxAgeDays, MAX_AGE_DAYS);
  assert.equal(doc.maxSkewHours, MAX_SKEW_HOURS);
  for (const vector of doc.vectors) {
    const issued = Date.parse(vector.issuedAt);
    const manifest = {
      issuedAt: vector.issuedAt,
      expiresAt: new Date(issued + MAX_AGE_DAYS * 86400000).toISOString().replace(/\.\d\d\dZ$/, "Z"),
    };
    const now = Date.parse(vector.now);
    if (vector.accept) checkFreshness(manifest, now);
    else assert.throws(() => checkFreshness(manifest, now), vector.why);
  }
});
