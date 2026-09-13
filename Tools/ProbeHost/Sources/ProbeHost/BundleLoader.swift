// SPDX-License-Identifier: GPL-3.0-or-later
//
// BundleLoader.swift - CONTRACT sections 3 and 8: where the bytes come from.
//
// Two sources, never mixed inside one run: the published bundle over HTTPS (the release
// entry point, falling back to the Pages mirror on a *transport* failure only), or a
// directory staged into the container for an offline run. Whichever it is, the bytes go
// through the same ContractVerifier, because "it came from the right URL" is not a
// reason to trust a payload - the manifest's hashes are.
//
// Everything here blocks. It is called on a background queue, never on the main thread:
// the main thread belongs to WebKit, which has to stay free to run the compile
// callbacks that the caller interleaves with these downloads.

import Foundation

/// Where one run's bundle came from, for the `bundle` block of run.json.
struct BundleOrigin {
    var source: String      // "network" | "disk"
    var origin: String      // "release" | "mirror" | "disk"
    var manifestUrl: String?
}

final class BundleLoader {
    private let arguments: Arguments
    private let clock: ProbeClock
    private let log: Log
    private let verifier: ContractVerifier
    private let session: URLSession

    /// The Pages mirror of the entry point (CONTRACT section 3). It is only tried when
    /// the operator did not name a manifest URL of their own: a run that was told where
    /// to look must not quietly measure something else.
    static let pagesLatestManifest = "https://mioutic.github.io/janus-filters/latest/manifest.json"

    private(set) var origin = BundleOrigin(source: "disk", origin: "disk", manifestUrl: nil)
    /// Base URLs tried for payloads, in order, once the manifest is verified.
    private var payloadBases: [String] = []

    init(arguments: Arguments, clock: ProbeClock, log: Log, verifier: ContractVerifier) {
        self.arguments = arguments
        self.clock = clock
        self.log = log
        self.verifier = verifier

        // No cookies, no credentials, no shared cache: CONTRACT section 2 says requests
        // carry nothing beyond a User-Agent, and a cached manifest would make "what is
        // published right now" unanswerable.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = TimeInterval(arguments.stepTimeoutMs) / 1000.0
        configuration.timeoutIntervalForResource = TimeInterval(arguments.budgetMs) / 1000.0
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    // MARK: - Manifest

    /// Steps 1 to 11. Returns the verified manifest and the exact bytes it was parsed
    /// from, so the record can carry `manifestSha256` of the signed bytes.
    func loadManifest(appBuild: Int) throws -> (manifest: Manifest, bytes: Data) {
        let manifestBytes: Data
        let signatureBytes: Data
        let mark = clock.ms()

        if let directory = arguments.bundleDir {
            let base = RunPaths.resolve(directory, under: documentsDirectory())
            manifestBytes = try readFile(base.appendingPathComponent("manifest.json"))
            signatureBytes = try readFile(base.appendingPathComponent("manifest.json.sig"))
            origin = BundleOrigin(source: "disk", origin: "disk", manifestUrl: nil)
            try verifier.recordManifestDownload(
                bytes: manifestBytes.count, ms: clock.since(mark), origin: "disk"
            )
        } else {
            guard let primary = arguments.manifestUrl else {
                throw ProbeFailure(.usage, "no-bundle-source", "neither a manifest URL nor a bundle directory")
            }
            var candidates: [(URL, String)] = [(primary, "release")]
            // The mirror is the fallback for anything served from the GitHub release
            // prefix, not only for the byte-identical default URL: the same asset typed
            // with a trailing slash, or reached through -ProbeManifestUrl, used to lose
            // the mirror entirely, so one asset 5xx became exit 75 with a single retry.
            // A URL already on the Pages host has nowhere further to fall back to.
            let releasePrefix = ContractVerifier.allowedUrlPrefixes[0]
            if primary.absoluteString.hasPrefix(releasePrefix),
               let mirror = URL(string: BundleLoader.pagesLatestManifest) {
                candidates.append((mirror, "mirror"))
            }

            var fetched: (Data, Data, String, URL)?
            var lastFailure: ProbeFailure?
            for (url, label) in candidates {
                do {
                    let manifest = try fetch(url)
                    let signature = try fetch(signatureURL(for: url))
                    fetched = (manifest, signature, label, url)
                    break
                } catch let failure as ProbeFailure {
                    // Transport only. A bad signature is not a transport problem and is
                    // never retried against a mirror expecting a different answer
                    // (CONTRACT section 11).
                    lastFailure = failure
                    log.warn("manifest fetch from \(label) failed: \(failure.code)")
                    continue
                }
            }
            guard let result = fetched else {
                throw lastFailure
                    ?? ProbeFailure(.tempFail, "manifest-unreachable", "no manifest source answered")
            }
            manifestBytes = result.0
            signatureBytes = result.1
            origin = BundleOrigin(
                source: "network", origin: result.2, manifestUrl: result.3.absoluteString
            )
            try verifier.recordManifestDownload(
                bytes: manifestBytes.count, ms: clock.since(mark), origin: result.2
            )
        }

        let manifest = try verifier.verifyManifest(
            manifestBytes: manifestBytes,
            signatureBytes: signatureBytes,
            now: Date(),
            appBuild: appBuild
        )

        // Payload bases come from the verified manifest and from nowhere else: the
        // latest-download form is never used to construct a payload URL (CONTRACT 3).
        payloadBases = [manifest.baseUrl] + manifest.mirrors
        return (manifest, manifestBytes)
    }

    // MARK: - Payloads

    /// Steps 12 to 15 for one file, from whichever base answers first.
    func loadPayload(file: String, expected: ManifestFile, label: String) throws -> Data {
        let compressed = try fetchPayloadBytes(file: file, label: label)
        return try verifier.verifyPayload(compressed, expected: expected, label: label)
    }

    /// The transport half on its own, so a caller that wants `downloadMs` and the
    /// verify cost reported separately - which compile.buckets[] in run.json does -
    /// can time the two halves rather than one blended number.
    func fetchPayloadBytes(file: String, label: String) throws -> Data {
        let compressed: Data
        if let directory = arguments.bundleDir {
            let base = RunPaths.resolve(directory, under: documentsDirectory())
            compressed = try readFile(base.appendingPathComponent(file))
        } else {
            var data: Data?
            var lastFailure: ProbeFailure?
            for base in payloadBases {
                guard let url = URL(string: base + file) else { continue }
                guard ContractVerifier.isAllowedUrl(url.absoluteString) else {
                    throw ProbeFailure(
                        .bundle, "url-not-allowed",
                        "\(label): \(base) is not under an allowed prefix"
                    )
                }
                do {
                    data = try fetch(url)
                    break
                } catch let failure as ProbeFailure {
                    lastFailure = failure
                    log.warn("payload \(file) failed from \(base): \(failure.code)")
                    continue
                }
            }
            guard let fetched = data else {
                throw lastFailure
                    ?? ProbeFailure(.tempFail, "payload-unreachable", "\(label): no base answered")
            }
            compressed = fetched
        }
        return compressed
    }

    // MARK: - Transport

    /// One blocking GET. Any transport-level outcome - DNS, TLS, timeout, 4xx, 5xx - is
    /// exit 75 (tempfail), which the runner retries once; a mismatch against the signed
    /// manifest is exit 65 and is never retried.
    private func fetch(_ url: URL) throws -> Data {
        precondition(!Thread.isMainThread, "BundleLoader.fetch must not run on the main thread")

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("ProbeHost/1.0 (janus-filters M2c probe)", forHTTPHeaderField: "User-Agent")

        var payload: Data?
        var response: URLResponse?
        var failure: Error?
        let semaphore = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: request) { data, urlResponse, error in
            payload = data
            response = urlResponse
            failure = error
            semaphore.signal()
        }
        let started = clock.ms()
        task.resume()
        let deadline = DispatchTime.now() + .milliseconds(arguments.stepTimeoutMs + 5_000)
        if semaphore.wait(timeout: deadline) == .timedOut {
            task.cancel()
            throw ProbeFailure(.tempFail, "fetch-timeout", "\(url.path) did not answer in time")
        }
        if let error = failure {
            throw ProbeFailure(
                .tempFail, "fetch-failed",
                "\(url.path): \((error as NSError).domain) \((error as NSError).code)"
            )
        }
        guard let http = response as? HTTPURLResponse else {
            throw ProbeFailure(.tempFail, "fetch-no-response", "\(url.path): no HTTP response")
        }
        guard http.statusCode == 200 else {
            throw ProbeFailure(.tempFail, "fetch-status", "\(url.path): HTTP \(http.statusCode)")
        }
        guard let body = payload, !body.isEmpty else {
            throw ProbeFailure(.tempFail, "fetch-empty", "\(url.path): empty body")
        }
        log.detail("fetched \(url.lastPathComponent): \(body.count) bytes in \(clock.since(started))ms")
        return body
    }

    private func signatureURL(for manifest: URL) -> URL {
        URL(string: manifest.absoluteString + ".sig") ?? manifest.appendingPathExtension("sig")
    }

    private func readFile(_ url: URL) throws -> Data {
        do {
            return try Data(contentsOf: url, options: [.mappedIfSafe])
        } catch {
            throw ProbeFailure(
                .tempFail, "disk-read",
                "could not read \(url.lastPathComponent) from the staged bundle"
            )
        }
    }

    private func documentsDirectory() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
    }
}
