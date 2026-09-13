// SPDX-License-Identifier: GPL-3.0-or-later
//
// RuleListCompiler.swift - CONTRACT section 8.5.
//
// Two rules decide the shape of this file. Compilation is *initiated on the main actor,
// one bucket at a time*: WebKit does the parsing on its own queue and calls back on
// main, and starting the call anywhere else is the iOS 26 crash Brave fixed in
// brave-core #31483. And reads, decompression and hashing stay off main, so the only
// thing the main thread does here is call `compileContentRuleList` and take the
// callback.
//
// The caller runs on a background queue and blocks on a semaphore while main compiles.
// That is deliberate: it serialises the compiles for free, keeps peak memory to one
// decompressed bucket, and leaves the main thread free to run the callback that
// releases it.

import Foundation
import WebKit

/// One bucket's trip through the pipeline, for `compile.buckets[]` in run.json.
struct CompiledBucket {
    var id: String
    var family: String
    var identifier: String
    var ruleCount: Int?
    var size: Int?
    var downloadSize: Int?
    var downloadMs: Int?
    var decompressMs: Int?
    var compileMs: Int?
    var ok: Bool
    var error: String?
    var attached: Bool
    /// True for lists ProbeHost itself synthesised (the offline self-check list), which
    /// are not part of the published bundle and are never counted as one.
    var synthetic: Bool = false
    /// False when the payload was fetched and verified but never handed to WebKit: mode
    /// `none` attaches nothing, so compiling there measures nothing and costs the suite
    /// its budget. `compileMs` is null for those, never zero.
    var compiled: Bool = true
}

final class RuleListCompiler {
    let storeURL: URL
    private let store: WKContentRuleListStore
    private let log: Log
    private let clock: ProbeClock
    private let lock = NSLock()
    private var lists: [(identifier: String, list: WKContentRuleList)] = []

    init(storeDirectory: URL, log: Log, clock: ProbeClock) throws {
        // Typed as Optional so this compiles whatever nullability the SDK declares for
        // +storeWithURL:.
        let candidate: WKContentRuleListStore? = WKContentRuleListStore(url: storeDirectory)
        guard let store = candidate else {
            throw ProbeFailure(
                .internalError, "store-unavailable",
                "WKContentRuleListStore(url:) returned nothing for \(storeDirectory.lastPathComponent)"
            )
        }
        self.store = store
        self.storeURL = storeDirectory
        self.log = log
        self.clock = clock
    }

    /// Every list compiled in this run, in compile order. The scenario runner adds them
    /// all to the user content controller in `blocked` mode and adds none in `none`.
    var compiledLists: [WKContentRuleList] {
        lock.lock()
        defer { lock.unlock() }
        return lists.map { $0.list }
    }

    var compiledIdentifiers: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lists.map { $0.identifier }
    }

    /// Blocking compile. Safe to call from a background queue; it must not be called on
    /// the main thread, because it waits for a callback that main has to deliver.
    /// Returns the elapsed milliseconds and an error string, never throwing: a bucket
    /// that will not compile is a measurement, and the run continues with the rest.
    @discardableResult
    func compile(identifier: String, json: String, timeoutMs: Int) -> (ms: Int, error: String?) {
        precondition(!Thread.isMainThread, "compile(identifier:json:) blocks and must not run on main")

        let box = CompileBox()
        let semaphore = DispatchSemaphore(value: 0)
        let started = clock.ms()

        DispatchQueue.main.async { [store] in
            // CONTRACT 8.5: look up first, compile only what is missing. On the default
            // fresh store this always misses, which is what makes compileMs a cold
            // number; with -ProbeKeepStore it is the point.
            store.lookUpContentRuleList(forIdentifier: identifier) { existing, _ in
                if let existing = existing {
                    box.list = existing
                    box.reused = true
                    semaphore.signal()
                    return
                }
                store.compileContentRuleList(
                    forIdentifier: identifier,
                    encodedContentRuleList: json
                ) { list, error in
                    box.list = list
                    if let error = error {
                        let nsError = error as NSError
                        box.error = "\(nsError.domain) \(nsError.code): \(nsError.localizedDescription)"
                    } else if list == nil {
                        box.error = "WebKit returned neither a list nor an error"
                    }
                    semaphore.signal()
                }
            }
        }

        if semaphore.wait(timeout: .now() + .milliseconds(timeoutMs)) == .timedOut {
            // The callback may still arrive; the box is what it writes into, and nothing
            // reads it after this point.
            log.warn("compile \(identifier) exceeded \(timeoutMs)ms")
            return (clock.since(started), "compile did not finish within \(timeoutMs)ms")
        }

        let elapsed = clock.since(started)
        if let list = box.list {
            lock.lock()
            lists.append((identifier, list))
            lock.unlock()
            log.detail("compiled \(identifier) in \(elapsed)ms\(box.reused ? " (reused)" : "")")
            return (elapsed, nil)
        }
        return (elapsed, box.error ?? "unknown compile failure")
    }

    /// The offline self-check list (00-index.md section 1). It is compiled and attached
    /// only for `fixture:` scenarios and for the spike, and it is marked `synthetic` in
    /// the record so nobody mistakes it for a published bucket. Without it, "0 requests
    /// blocked" on a live site would be ambiguous between "the filters did not block"
    /// and "the harness is not measuring".
    /// The url-filter values use `[.]` rather than a backslash escape: the rule list is
    /// JSON, `\.` is not a valid JSON escape, and a character class says the same thing
    /// to the regex with nothing for a string literal to get wrong on the way.
    static func selftestRuleListJSON() -> String {
        """
        [
          {"trigger":{"url-filter":"/blocked[.]js"},"action":{"type":"block"}},
          {"trigger":{"url-filter":".*"},
           "action":{"type":"css-display-none","selector":"#ad-slot"}}
        ]
        """
    }

    /// A one-rule list that redirects the spike's fixture script, used by the
    /// active-action-patterns probe (04-spike.md section 3.3).
    static func spikeRedirectRuleListJSON(to target: String) -> String {
        """
        [
          {"trigger":{"url-filter":"/redirect-me[.]js"},
           "action":{"type":"redirect","redirect":{"url":"\(target)"}}}
        ]
        """
    }
}

/// A reference box the WebKit callbacks write into, so a timed-out compile cannot write
/// into a stack frame that has already returned.
private final class CompileBox {
    var list: WKContentRuleList?
    var error: String?
    var reused = false
}
