// SPDX-License-Identifier: GPL-3.0-or-later
//
// ContractVerifier.swift - CONTRACT section 6, steps 1 to 15, in order, fail-closed.
//
// Every step is recorded with its outcome and its cost, because run.json's `contract`
// block is the artifact that proves the published bundle verified on a machine that has
// nothing but the contract document and the pinned public key. A failure anywhere here
// is exit 65: the bundle is broken, nothing downstream could be measured, and the
// runner is told not to retry, because a bad signature is not a transport problem.
//
// The public key below is published in CONTRACT section 5. It is a *public* key: this
// repository holds no key material, and the signing key exists only as an environment
// secret the release workflow uses.

import CryptoKit
import Foundation

struct StepRecord {
    let step: Int
    let name: String
    var ok: Bool
    var ms: Int
    var detail: String?
}

final class ContractVerifier {
    /// CONTRACT section 5: a compiled-in map of keyId to raw public key, with a reserved
    /// rollover slot that is empty in M2a. An unknown keyId is a rejection - never a
    /// prompt, never "try every key", never a fetch.
    static let pinnedKeys: [String: String] = [
        "d6ff9fb88ae9b930": "wFAZ/lFdpErWYl+lJvB02kKnHUOoKm9qqhgJckY8oAY=",
    ]

    /// The contract version this program implements (CONTRACT 6 step 6).
    static let implementedContractVersion = 1

    /// CONTRACT 6 step 11. A signed manifest could otherwise point the downloader
    /// anywhere, so the allowlist is on the host and path prefix, not on the host alone.
    static let allowedUrlPrefixes = [
        "https://github.com/mioutic/janus-filters/",
        "https://mioutic.github.io/janus-filters/",
    ]

    static let maximumManifestBytes = 4 * 1024 * 1024
    static let maximumAgeSeconds: TimeInterval = 14 * 24 * 60 * 60
    static let maximumFutureSkewSeconds: TimeInterval = 24 * 60 * 60

    private(set) var steps: [StepRecord] = []
    private(set) var ok = true
    private(set) var failedStep: Int?
    private(set) var failureReason: String?

    private let clock: ProbeClock
    private let log: Log

    // Steps 12-15 are per payload and are reported as one aggregate entry each, with a
    // count in the detail, exactly as the schema example shows.
    private var payloadMs: [Int: Int] = [12: 0, 13: 0, 14: 0, 15: 0]
    private var payloadCount = 0

    init(clock: ProbeClock, log: Log) {
        self.clock = clock
        self.log = log
    }

    // MARK: - Recording

    private func pass(_ step: Int, _ name: String, ms: Int, detail: String? = nil) {
        steps.append(StepRecord(step: step, name: name, ok: true, ms: ms, detail: detail))
        log.detail("contract step \(step) \(name): ok\(detail.map { " (\($0))" } ?? "")")
    }

    private func fail(_ step: Int, _ name: String, _ code: String, _ reason: String) -> ProbeFailure {
        steps.append(StepRecord(step: step, name: name, ok: false, ms: 0, detail: reason))
        if ok {
            ok = false
            failedStep = step
            failureReason = reason
        }
        log.error("contract step \(step) \(name) failed: \(reason)")
        return ProbeFailure(.bundle, code, "contract step \(step) (\(name)): \(reason)")
    }

    // MARK: - Phase 1, the manifest

    /// Step 1 is performed by BundleLoader (it owns the transport); this records it.
    func recordManifestDownload(bytes: Int, ms: Int, origin: String) throws {
        guard bytes > 0 else {
            throw fail(1, "download-manifest", "empty-manifest", "the manifest was empty")
        }
        guard bytes <= ContractVerifier.maximumManifestBytes else {
            throw fail(
                1, "download-manifest", "manifest-too-large",
                "\(bytes) bytes exceeds the \(ContractVerifier.maximumManifestBytes) byte limit"
            )
        }
        pass(1, "download-manifest", ms: ms, detail: "\(bytes) bytes from \(origin)")
    }

    /// Steps 2 to 11. `manifestBytes` are the bytes exactly as served: they are what was
    /// signed, and they are never re-encoded.
    func verifyManifest(
        manifestBytes: Data,
        signatureBytes: Data,
        now: Date,
        appBuild: Int
    ) throws -> Manifest {
        // Step 2 - decode the signature.
        var mark = clock.ms()
        let base64 = String(decoding: signatureBytes, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let signature = Data(base64Encoded: base64), signature.count == 64 else {
            throw fail(
                2, "decode-signature", "bad-signature-encoding",
                "manifest.json.sig did not decode to exactly 64 bytes"
            )
        }
        pass(2, "decode-signature", ms: clock.since(mark))

        // Step 3 - read keyId only to select a compiled-in key.
        mark = clock.ms()
        guard let keyId = ContractVerifier.keyIdField(in: manifestBytes) else {
            throw fail(
                3, "select-pinned-key", "no-key-id",
                "the manifest carries no readable keyId field"
            )
        }
        guard let keyBase64 = ContractVerifier.pinnedKeys[keyId],
              let keyRaw = Data(base64Encoded: keyBase64),
              let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: keyRaw)
        else {
            throw fail(
                3, "select-pinned-key", "unknown-key-id",
                "keyId \(keyId) is not pinned in this build"
            )
        }
        // The keyId is the first 16 hex characters of the SHA-256 of the raw 32-byte
        // key. Re-deriving it here means a mistyped pin cannot pass unnoticed.
        let derivedKeyId = ContractVerifier.hex(SHA256.hash(data: keyRaw)).prefix(16)
        guard String(derivedKeyId) == keyId else {
            throw fail(
                3, "select-pinned-key", "pin-mismatch",
                "the pinned key does not hash to \(keyId)"
            )
        }
        pass(3, "select-pinned-key", ms: clock.since(mark), detail: keyId)

        // Step 4 - verify over the downloaded bytes.
        mark = clock.ms()
        guard publicKey.isValidSignature(signature, for: manifestBytes) else {
            throw fail(
                4, "verify-signature", "bad-signature",
                "the Ed25519 signature did not verify over the manifest bytes"
            )
        }
        pass(4, "verify-signature", ms: clock.since(mark))

        // Step 5 - parse. Only now is the content trusted.
        mark = clock.ms()
        let manifest: Manifest
        do {
            manifest = try JSONDecoder().decode(Manifest.self, from: manifestBytes)
        } catch {
            throw fail(
                5, "parse", "manifest-malformed",
                "the manifest did not decode: \(error)"
            )
        }
        pass(5, "parse", ms: clock.since(mark), detail: "\(manifest.buckets.count) buckets")

        // Step 6 - contract version.
        guard manifest.contractVersion <= ContractVerifier.implementedContractVersion else {
            throw fail(
                6, "contract-version", "contract-too-new",
                "contractVersion \(manifest.contractVersion) is newer than this build implements"
                    + " (\(ContractVerifier.implementedContractVersion))"
            )
        }
        pass(6, "contract-version", ms: 0, detail: "\(manifest.contractVersion)")

        // Step 7 - minAppBuild.
        guard manifest.minAppBuild <= appBuild else {
            throw fail(
                7, "min-app-build", "app-too-old",
                "minAppBuild \(manifest.minAppBuild) is higher than this build (\(appBuild))"
            )
        }
        pass(7, "min-app-build", ms: 0, detail: "\(manifest.minAppBuild) <= \(appBuild)")

        // Step 8 - monotonic version. ProbeHost installs nothing and keeps nothing
        // between runs, so there is no baseline to be newer than. That is recorded
        // rather than quietly skipped: a reader must see which check did not apply.
        pass(8, "version-monotonic", ms: 0, detail: "no installed baseline; version \(manifest.version)")

        // Step 9 - age. The boundary is closed: exactly 14 days old is a rejection.
        guard let issuedAt = manifest.issuedAtDate else {
            throw fail(9, "age", "bad-issued-at", "issuedAt is not RFC 3339 UTC: \(manifest.issuedAt)")
        }
        let age = now.timeIntervalSince(issuedAt)
        guard age < ContractVerifier.maximumAgeSeconds else {
            throw fail(
                9, "age", "stale-bundle",
                "issuedAt is \(Int(age / 3600))h old, the limit is 336h"
            )
        }
        pass(9, "age", ms: 0, detail: "\(max(0, Int(age / 3600)))h")

        // Step 10 - clock skew.
        guard age > -ContractVerifier.maximumFutureSkewSeconds else {
            throw fail(
                10, "clock-skew", "future-bundle",
                "issuedAt is \(Int(-age / 3600))h in the future"
            )
        }
        pass(10, "clock-skew", ms: 0)

        // Step 11 - URL allowlist, for baseUrl and every mirror.
        var checked = 0
        for url in [manifest.baseUrl] + manifest.mirrors {
            guard ContractVerifier.isAllowedUrl(url) else {
                throw fail(
                    11, "url-allowlist", "url-not-allowed",
                    "\(url) is not under an allowed prefix"
                )
            }
            checked += 1
        }
        guard manifest.baseUrl.hasSuffix("/") else {
            throw fail(11, "url-allowlist", "base-url-not-directory", "baseUrl does not end in '/'")
        }
        pass(
            11, "url-allowlist", ms: 0,
            detail: "1 base, \(max(0, checked - 1)) mirror\(checked == 2 ? "" : "s")"
        )

        return manifest
    }

    // MARK: - Phase 2, payloads

    /// Steps 12 to 15 for one payload. The compressed bytes are checked against
    /// `downloadSize`/`downloadSha256` before anything is expanded, and the expanded
    /// bytes against `size`/`sha256` before anything is compiled.
    func verifyPayload(_ compressed: Data, expected: ManifestFile, label: String) throws -> Data {
        payloadCount += 1

        var mark = clock.ms()
        guard compressed.count == expected.downloadSize else {
            throw fail(
                12, "payload-download-size", "download-size-mismatch",
                "\(label): \(compressed.count) bytes downloaded, manifest says \(expected.downloadSize)"
            )
        }
        payloadMs[12, default: 0] += clock.since(mark)

        mark = clock.ms()
        let downloadHash = ContractVerifier.hex(SHA256.hash(data: compressed))
        guard downloadHash == expected.downloadSha256.lowercased() else {
            throw fail(
                13, "payload-download-hash", "download-hash-mismatch",
                "\(label): downloaded bytes hash to \(downloadHash)"
            )
        }
        payloadMs[13, default: 0] += clock.since(mark)

        mark = clock.ms()
        let expanded: Data
        do {
            expanded = try Lzfse.decompress(compressed, expectedSize: expected.size, label: label)
        } catch let failure as ProbeFailure {
            // Lzfse owns the size guard of CONTRACT step 14; the step record is owned
            // here, so a decoder failure is folded back into the step it belongs to.
            throw fail(14, "decompress-size", failure.code, failure.message)
        }
        payloadMs[14, default: 0] += clock.since(mark)

        mark = clock.ms()
        let contentHash = ContractVerifier.hex(SHA256.hash(data: expanded))
        guard contentHash == expected.sha256.lowercased() else {
            throw fail(
                15, "decompress-hash", "content-hash-mismatch",
                "\(label): decompressed bytes hash to \(contentHash)"
            )
        }
        payloadMs[15, default: 0] += clock.since(mark)

        return expanded
    }

    /// Emits the four aggregate payload steps. Called once, after every payload the run
    /// needed has been verified, so the record has an entry per contract step even when
    /// a run selected no payloads at all.
    func finishPayloadSteps() {
        let detail = "\(payloadCount) file\(payloadCount == 1 ? "" : "s")"
        if !steps.contains(where: { $0.step == 12 }) {
            pass(12, "payload-download-size", ms: payloadMs[12] ?? 0, detail: detail)
        }
        if !steps.contains(where: { $0.step == 13 }) {
            pass(13, "payload-download-hash", ms: payloadMs[13] ?? 0)
        }
        if !steps.contains(where: { $0.step == 14 }) {
            pass(14, "decompress-size", ms: payloadMs[14] ?? 0)
        }
        if !steps.contains(where: { $0.step == 15 }) {
            pass(15, "decompress-hash", ms: payloadMs[15] ?? 0)
        }
    }

    // MARK: - Helpers

    static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }

    static func sha256Hex(_ data: Data) -> String {
        hex(SHA256.hash(data: data))
    }

    static func isAllowedUrl(_ url: String) -> Bool {
        allowedUrlPrefixes.contains { url.hasPrefix($0) }
    }

    /// Reads `keyId` out of the manifest bytes without parsing the document, because
    /// step 3 happens before step 5: at that point the manifest is untrusted input and
    /// must not influence anything except the choice of pinned key. A 16-hex-character
    /// lookup key is the whole of that influence.
    static func keyIdField(in bytes: Data) -> String? {
        guard let text = String(data: bytes, encoding: .utf8) else { return nil }
        guard let range = text.range(of: "\"keyId\"") else { return nil }
        let rest = text[range.upperBound...]
        guard let colon = rest.firstIndex(of: ":") else { return nil }
        let afterColon = rest[rest.index(after: colon)...]
        guard let open = afterColon.firstIndex(of: "\"") else { return nil }
        let valueStart = afterColon.index(after: open)
        guard let close = afterColon[valueStart...].firstIndex(of: "\"") else { return nil }
        let value = String(afterColon[valueStart..<close])
        let hexDigits = CharacterSet(charactersIn: "0123456789abcdef")
        guard value.count == 16, value.unicodeScalars.allSatisfy({ hexDigits.contains($0) }) else {
            return nil
        }
        return value
    }
}
