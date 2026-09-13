// SPDX-License-Identifier: GPL-3.0-or-later
//
// Compiler.swift - PIPELINE.md section 13, the WebKit half of RuleListValidate.
//
// Compilation is initiated on the main thread, one list at a time. That is
// deliberate: it is Brave's fix for the iOS 26 crash (brave-core #31483), and WebKit
// already does the parsing and compiling on its own queue and calls back on the main
// run loop. In a command-line tool nothing pumps that run loop for us, so every call
// is driven synchronously by running the main run loop until the completion handler
// fires or the deadline passes.

import Dispatch
import Foundation
import WebKit

/// The result of one compile attempt.
struct CompileOutcome {
    var succeeded: Bool
    var milliseconds: Int
    var timedOut: Bool
    var errorDomain: String?
    var errorCode: Int?
    var errorMessage: String?

    /// The compiler's message, or a synthetic one for a timeout.
    var failureMessage: String? {
        if succeeded { return nil }
        if timedOut { return "compile did not finish within the timeout" }
        return errorMessage ?? "unknown compile failure"
    }

    var reportFields: [String: Any] {
        var fields: [String: Any] = [:]
        fields["domain"] = errorDomain ?? (timedOut ? "JanusValidate" : "unknown")
        fields["code"] = errorCode ?? (timedOut ? -1 : 0)
        fields["message"] = failureMessage ?? ""
        return fields
    }
}

private final class CompletionBox {
    var finished = false
    var errorDomain: String?
    var errorCode: Int?
    var errorMessage: String?
}

final class RuleListCompiler {
    let storeURL: URL
    private let store: WKContentRuleListStore
    private var probeCounter = 0

    /// The store directory is removed and recreated, so a stale compiled list can
    /// never make a broken bucket look healthy.
    init(storeDirectory: URL) throws {
        if FileManager.default.fileExists(atPath: storeDirectory.path) {
            do {
                try FileManager.default.removeItem(at: storeDirectory)
            } catch {
                throw JanusError.internalFailure(
                    "store-not-cleared",
                    "could not clear the rule-list store: " + error.localizedDescription
                )
            }
        }
        try IO.createDirectory(at: storeDirectory)

        // Typed as Optional so this compiles whatever nullability the SDK declares
        // for +storeWithURL:.
        let candidate: WKContentRuleListStore? = WKContentRuleListStore(url: storeDirectory)
        guard let store = candidate else {
            throw JanusError.internalFailure(
                "store-unavailable",
                "WKContentRuleListStore(url:) returned nothing for the scratch store"
            )
        }
        self.store = store
        self.storeURL = storeDirectory
    }

    /// An identifier for a throwaway compile during bisection.
    func nextProbeIdentifier(for bucketId: String) -> String {
        probeCounter += 1
        return bucketId + ".probe." + String(probeCounter)
    }

    /// Compiles one encoded rule list and waits for WebKit to answer. Must be called
    /// from the main thread: the completion handler is delivered on the main run loop.
    func compile(identifier: String, encoded: String, timeoutMs: Int) -> CompileOutcome {
        precondition(Thread.isMainThread, "compile(identifier:encoded:timeoutMs:) must run on the main thread")

        let box = CompletionBox()
        let startedAt = DispatchTime.now().uptimeNanoseconds

        store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: encoded) { _, error in
            if let error = error {
                let nsError = error as NSError
                box.errorDomain = nsError.domain
                box.errorCode = nsError.code
                box.errorMessage = nsError.localizedDescription
            }
            box.finished = true
        }

        let finished = RuleListCompiler.pumpMainRunLoop(
            until: { box.finished },
            timeout: TimeInterval(timeoutMs) / 1000.0
        )
        let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)

        if !finished {
            return CompileOutcome(
                succeeded: false,
                milliseconds: elapsedMs,
                timedOut: true,
                errorDomain: nil,
                errorCode: nil,
                errorMessage: nil
            )
        }

        let succeeded = box.errorMessage == nil && box.errorDomain == nil
        if succeeded {
            // Keep the scratch store small: nothing here is ever loaded again.
            remove(identifier: identifier)
        }
        return CompileOutcome(
            succeeded: succeeded,
            milliseconds: elapsedMs,
            timedOut: false,
            errorDomain: box.errorDomain,
            errorCode: box.errorCode,
            errorMessage: box.errorMessage
        )
    }

    /// Best-effort removal; a failure here is never fatal because the whole store
    /// directory is thrown away at the end of the run.
    func remove(identifier: String) {
        precondition(Thread.isMainThread, "remove(identifier:) must run on the main thread")
        let box = CompletionBox()
        store.removeContentRuleList(forIdentifier: identifier) { error in
            if let error = error {
                box.errorMessage = (error as NSError).localizedDescription
            }
            box.finished = true
        }
        _ = RuleListCompiler.pumpMainRunLoop(until: { box.finished }, timeout: 30.0)
        if let message = box.errorMessage {
            Log.warn("store-remove-failed", ["identifier": identifier, "message": message])
        }
    }

    func destroyStore() {
        try? FileManager.default.removeItem(at: storeURL)
    }

    /// Runs the main run loop until `condition` holds or the timeout elapses.
    /// Returns false only on timeout.
    static func pumpMainRunLoop(until condition: () -> Bool, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            let now = Date()
            if now >= deadline { return condition() }
            let sliceEnd = min(deadline, now.addingTimeInterval(0.05))
            if !RunLoop.main.run(mode: .default, before: sliceEnd) {
                // No input source was ready; yield briefly instead of spinning.
                Thread.sleep(forTimeInterval: 0.002)
            }
        }
        return true
    }
}
