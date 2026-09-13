// SPDX-License-Identifier: GPL-3.0-or-later
//
// The three derivations the app and the pipeline must agree on letter for letter
// (CONTRACT section 14 items 3, 4 and 5). They live here rather than inside a
// stage because the shared conformance vectors in test/fixtures/contract/ run
// against them, and the app's TestVectors/ copy of those files runs against its
// own implementation of exactly these rules.

/** CONTRACT 8.5: the WKContentRuleListStore identifier of a bucket payload. */
export function bucketIdentifier(bucketId, sha256) {
  if (typeof bucketId !== "string" || bucketId.length === 0) {
    throw new TypeError("bucketIdentifier: bucketId must be a non-empty string");
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError("bucketIdentifier: sha256 must be 64 lower-case hex chars");
  }
  return `${bucketId}.${sha256.slice(0, 8)}`;
}

/**
 * CONTRACT 8.1: the flavour a device installs, chosen from the **running** iOS
 * major version and never from the build SDK.
 */
export function flavourForIOSMajor(major) {
  if (!Number.isInteger(major) || major < 17) {
    throw new RangeError(`flavourForIOSMajor: unsupported iOS major ${String(major)}`);
  }
  return major >= 26 ? "ios26" : "ios17";
}

/** CONTRACT 7.1: only a strictly greater version is an update. */
export function isUpdate(candidateVersion, installedVersion) {
  if (!Number.isSafeInteger(candidateVersion) || candidateVersion <= 0) return false;
  const installed = Number.isSafeInteger(installedVersion) ? installedVersion : 0;
  return candidateVersion > installed;
}

export default { bucketIdentifier, flavourForIOSMajor, isUpdate };
