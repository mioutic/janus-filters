// SPDX-License-Identifier: GPL-3.0-or-later
//
// SpikeRunner.swift - the M0 capability probes of docs/probehost/04-spike.md.
//
// The spike answers questions. It measures no blocking, touches no live site, and fails
// no job for a `fail` verdict: a probe that reports "this SPI is gone" is the spike
// working perfectly. Every probe runs against the in-app fixture server on 127.0.0.1,
// every private selector is reached through `responds(to:)` plus KVC, and `unknown` is a
// first-class answer that is never dressed up as pass or fail - a guess here would let a
// whole feature be built on nothing.

import Foundation
import UIKit
import WebKit

struct SpikeProbe {
    var id: String
    var title: String
    var verdict: String       // pass | fail | unknown | skipped
    var ms: Int
    var evidence: JSONValue
    var reason: String?

    func json() -> JSONValue {
        .object([
            ("id", .string(id)),
            ("title", .string(title)),
            ("verdict", .string(verdict)),
            ("ms", .int(ms)),
            ("evidence", evidence),
            ("reason", JSONValue.stringOrNull(reason)),
        ])
    }
}

/// One web view, its delegate and its metrics, built and torn down per probe so no probe
/// can inherit another's state.
final class SpikeWebView {
    let webView: WKWebView
    let delegate: ProbeDelegate
    let metrics: ProbeMetrics
    private let clock: ProbeClock
    private let log: Log

    init(
        container: UIView, lists: [WKContentRuleList], script: String,
        log: Log, clock: ProbeClock
    ) {
        self.clock = clock
        self.log = log
        metrics = ProbeMetrics(clock: clock, maxRequests: 500, maxConsole: 100)
        delegate = ProbeDelegate(metrics: metrics, log: log, clock: clock)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let controller = WKUserContentController()
        controller.add(delegate, name: "probe")
        controller.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
        for list in lists { controller.add(list) }
        configuration.userContentController = controller

        webView = WKWebView(frame: container.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = delegate
        webView.uiDelegate = delegate
        container.addSubview(webView)
    }

    func remove() {
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeAllUserScripts()
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: "probe")
        webView.removeFromSuperview()
    }

    /// Loads and waits for didFinish, a failure, or the deadline. `true` means the page
    /// finished; every probe treats "did not finish" as `unknown`, because a fixture that
    /// did not load proves nothing about the SPI under test.
    func load(_ url: String, settleMs: Int, timeoutMs: Int, completion: @escaping (Bool) -> Void) {
        guard let target = URL(string: url) else {
            completion(false)
            return
        }
        metrics.didFinish = false
        metrics.failure = nil
        metrics.navigationStartMs = clock.ms()
        webView.load(URLRequest(url: target))
        probePoll(timeoutMs: timeoutMs, until: { [weak self] in
            guard let self = self else { return true }
            return self.metrics.didFinish || self.metrics.failure != nil
                || self.metrics.webContentTerminated
        }, completion: { finished in
            probeAfter(ms: settleMs) { completion(finished && self.metrics.didFinish) }
        })
    }

    func evaluate(_ source: String, in frame: ProbeFrame? = nil, completion: @escaping (Any?) -> Void) {
        var answered = false
        probeAfter(ms: 8_000) {
            guard !answered else { return }
            answered = true
            completion(nil)
        }
        webView.evaluateJavaScript(source, in: frame?.info, in: .page) { result in
            guard !answered else { return }
            answered = true
            switch result {
            case .success(let value): completion(value)
            case .failure: completion(nil)
            }
        }
    }

    /// The same source in the main frame and in every subframe probe.js reported from,
    /// with the main-frame flag alongside each answer.
    func evaluateEverywhere(_ source: String, completion: @escaping ([(Bool, Any?)]) -> Void) {
        var targets: [ProbeFrame?] = [nil]
        for frame in metrics.frames.values where !frame.isMainFrame { targets.append(frame) }
        var results: [(Bool, Any?)] = []
        func step(_ index: Int) {
            guard index < targets.count else {
                completion(results)
                return
            }
            let frame = targets[index]
            evaluate(source, in: frame) { value in
                results.append((frame == nil, value))
                step(index + 1)
            }
        }
        step(0)
    }
}

final class SpikeRunner {
    private let arguments: Arguments
    private let paths: RunPaths
    private let log: Log
    private let clock: ProbeClock
    private let container: UIView

    private let fixtures: FixtureServer
    private var compiler: RuleListCompiler?
    private var script = ""
    private var probes: [SpikeProbe] = []
    private var completion: ((ProbeExit) -> Void)?
    private var finished = false
    private var record: JSONValue = .null
    private var started = Date()
    private var status = "ok"
    private var exitCode: ProbeExit = .ok

    /// The selector every blocked-request number in M2c depends on.
    private static let actionSelector = "_webView:contentRuleListWithIdentifier:performedAction:forURL:"
    private static let timingSelector = "_webView:didGeneratePageLoadTiming:"

    init(arguments: Arguments, paths: RunPaths, log: Log, clock: ProbeClock, container: UIView) {
        self.arguments = arguments
        self.paths = paths
        self.log = log
        self.clock = clock
        self.container = container
        self.fixtures = FixtureServer(log: log, clock: clock)
    }

    var spikeRecord: JSONValue { record }

    func start(completion: @escaping (ProbeExit) -> Void) {
        self.completion = completion
        started = Date()
        do {
            _ = try fixtures.start(requestedPort: arguments.fixturePort)
            let storeDirectory = try paths.prepareStore(keepExisting: false)
            compiler = try RuleListCompiler(storeDirectory: storeDirectory, log: log, clock: clock)
            guard let url = Bundle.main.url(forResource: "probe", withExtension: "js"),
                  let source = try? String(contentsOf: url, encoding: .utf8)
            else {
                throw ProbeFailure(.internalError, "probe-js-missing", "probe.js is not in the app bundle")
            }
            script = source
        } catch let failure as ProbeFailure {
            log.error("\(failure.code): \(failure.message)")
            status = failure.exit.statusName
            exitCode = failure.exit
            finish()
            return
        } catch {
            status = "internal"
            exitCode = .internalError
            finish()
            return
        }

        // A whole-suite budget, so a hung probe still produces a file and a DONE.
        probeAfter(ms: arguments.budgetMs) { [weak self] in
            guard let self = self, !self.finished else { return }
            self.log.warn("spike budget expired")
            self.status = "budget"
            self.finish()
        }

        probes.append(
            SpikeProbe(
                id: "installed-runtimes",
                title: "Which simulator runtimes and iPhone device types exist on this image?",
                verdict: "skipped", ms: 0,
                evidence: .object([("runnerSide", .bool(true))]),
                reason: "runner-side probe: the runner records it from `simctl list`"
            )
        )
        probeRuleListCallback()
    }

    // MARK: - 3.2 rule-list-action-callback

    private func probeRuleListCallback() {
        let mark = clock.ms()
        let title = "Does _webView:contentRuleListWithIdentifier:performedAction:forURL: fire?"
        guard let compiler = compiler else { return }
        let identifier = "spike.block.0"

        compileOffMain(
            identifier: identifier, json: RuleListCompiler.selftestRuleListJSON(), compiler: compiler
        ) { [weak self] list, error in
            guard let self = self else { return }
            guard let list = list else {
                self.addProbe(
                    SpikeProbe(
                        id: "rule-list-action-callback", title: title, verdict: "unknown",
                        ms: self.clock.since(mark),
                        evidence: .object([("compileError", JSONValue.stringOrNull(error))]),
                        reason: "the two-rule fixture list did not compile"
                    )
                )
                self.probeActivePatterns()
                return
            }

            let view = SpikeWebView(
                container: self.container, lists: [list], script: self.script,
                log: self.log, clock: self.clock
            )
            let selectorPresent = view.delegate.responds(to: NSSelectorFromString(SpikeRunner.actionSelector))
            let url = self.fixtures.resolve("fixture:/selftest.html")
            view.load(url, settleMs: 1_200, timeoutMs: 15_000) { loaded in
                view.evaluate("window.__probeFixture || null") { flags in
                    let page = flags as? [String: Any] ?? [:]
                    let controlLoaded = (page["allowed"] as? NSNumber)?.boolValue ?? false
                    let blockedRan = (page["blocked"] as? NSNumber)?.boolValue ?? false
                    let blockedHits = self.fixtures.hitCount("/blocked.js")
                    let allowedHits = self.fixtures.hitCount("/allowed.js")
                    let callbacks = view.metrics.blocked.filter { $0.identifier == identifier }
                    let blockedLoad = callbacks.contains { $0.flags["blockedLoad"] == true }

                    var flagReport: [(String, JSONValue)] = []
                    for key in ["blockedLoad", "blockedCookies", "madeHTTPS", "redirected",
                                "modifiedHeaders", "notifications"] {
                        let present = !view.metrics.spiMissingProperties.contains(key)
                        let value = callbacks.first?.flags[key] ?? false
                        flagReport.append((key, present ? .bool(value) : .null))
                    }

                    let evidence = JSONValue.object([
                        ("selectorPresent", .bool(selectorPresent)),
                        ("callbackCount", .int(callbacks.count)),
                        ("identifier", .string(identifier)),
                        ("url", .string(ProbeURL.strip(url))),
                        ("actionProperties", .object(flagReport)),
                        ("missingProperties", .array(
                            view.metrics.spiMissingProperties.sorted().map { .string($0) }
                        )),
                        ("controlRequestLoaded", .bool(controlLoaded)),
                        ("blockedScriptExecuted", .bool(blockedRan)),
                        ("serverHitsBlockedJs", .int(blockedHits)),
                        ("serverHitsAllowedJs", .int(allowedHits)),
                        ("pageLoaded", .bool(loaded)),
                    ])

                    var verdict = "unknown"
                    var reason: String?
                    if !loaded {
                        reason = "the fixture page did not load"
                    } else if !selectorPresent {
                        reason = "the delegate does not carry the private selector"
                    } else if !controlLoaded {
                        reason = "the control request did not load, so nothing can be concluded"
                    } else if blockedLoad, !callbacks.isEmpty {
                        verdict = "pass"
                    } else if blockedHits == 0, !blockedRan {
                        // The page demonstrably never received the request, yet no
                        // callback arrived: the block happened, the notification did not.
                        verdict = "fail"
                        reason = "the request was blocked but no callback arrived"
                    } else {
                        reason = "the blocked request reached the server, so the list did not block"
                    }

                    view.remove()
                    self.addProbe(
                        SpikeProbe(
                            id: "rule-list-action-callback", title: title, verdict: verdict,
                            ms: self.clock.since(mark), evidence: evidence, reason: reason
                        )
                    )
                    self.probeActivePatterns()
                }
            }
        }
    }

    // MARK: - 3.3 active-action-patterns

    private func probeActivePatterns() {
        let mark = clock.ms()
        let title = "Does WKWebpagePreferences._activeContentRuleListActionPatterns gate redirects?"
        let id = "active-action-patterns"
        guard let compiler = compiler else { return }

        let preferences = WKWebpagePreferences()
        let setter = NSSelectorFromString("_setActiveContentRuleListActionPatterns:")
        let getter = NSSelectorFromString("_activeContentRuleListActionPatterns")
        let present = preferences.responds(to: setter) && preferences.responds(to: getter)
        guard present else {
            addProbe(
                SpikeProbe(
                    id: id, title: title, verdict: "unknown", ms: clock.since(mark),
                    evidence: .object([("propertyPresent", .bool(false))]),
                    reason: "WKWebpagePreferences does not respond to the private property"
                )
            )
            probeMediaPreference()
            return
        }

        let identifier = "spike.redirect.0"
        let target = fixtures.resolve("fixture:/redirected.js")
        compileOffMain(
            identifier: identifier,
            json: RuleListCompiler.spikeRedirectRuleListJSON(to: target),
            compiler: compiler
        ) { [weak self] list, error in
            guard let self = self else { return }
            guard let list = list else {
                self.addProbe(
                    SpikeProbe(
                        id: id, title: title, verdict: "unknown", ms: self.clock.since(mark),
                        evidence: .object([
                            ("propertyPresent", .bool(true)),
                            ("compileError", JSONValue.stringOrNull(error)),
                        ]),
                        reason: "the redirect fixture list did not compile"
                    )
                )
                self.probeMediaPreference()
                return
            }

            // Stop 1: no patterns granted. WebKit must ignore the redirect action.
            self.runRedirectStop(list: list, patterns: nil) { withoutPatterns in
                // Stop 2: the pattern set granted for this identifier, on every
                // navigation, main frame and subframe alike - WebKit checks the
                // initiating frame's own DocumentLoader.
                self.runRedirectStop(list: list, patterns: [identifier: ["*://*/*"]]) { withPatterns in
                    let evidence = JSONValue.object([
                        ("propertyPresent", .bool(true)),
                        ("identifier", .string(identifier)),
                        ("redirectTarget", .string(ProbeURL.strip(target))),
                        ("withoutPatterns", withoutPatterns.json),
                        ("withPatterns", withPatterns.json),
                    ])
                    var verdict = "unknown"
                    var reason: String?
                    if !withoutPatterns.loaded || !withPatterns.loaded {
                        reason = "the redirect fixture did not load"
                    } else if withoutPatterns.mainRedirected == nil || withPatterns.mainRedirected == nil {
                        reason = "the fixture frames did not report"
                    } else if withoutPatterns.anyRedirected == false && withPatterns.allRedirected == true {
                        verdict = "pass"
                    } else {
                        verdict = "fail"
                        reason = withoutPatterns.anyRedirected == true
                            ? "a redirect fired with no pattern set"
                            : "no redirect fired with the pattern set"
                    }
                    self.addProbe(
                        SpikeProbe(
                            id: id, title: title, verdict: verdict, ms: self.clock.since(mark),
                            evidence: evidence, reason: reason
                        )
                    )
                    self.probeMediaPreference()
                }
            }
        }
    }

    private struct RedirectStop {
        var loaded = false
        var mainRedirected: Bool?
        var frameRedirected: Bool?
        var serverHitsOriginal = 0
        var serverHitsRedirected = 0

        var anyRedirected: Bool? {
            guard mainRedirected != nil || frameRedirected != nil else { return nil }
            return (mainRedirected ?? false) || (frameRedirected ?? false)
        }

        var allRedirected: Bool? {
            guard let main = mainRedirected else { return nil }
            return main && (frameRedirected ?? main)
        }

        var json: JSONValue {
            .object([
                ("loaded", .bool(loaded)),
                ("mainFrameRedirected", JSONValue.boolOrNull(mainRedirected)),
                ("subFrameRedirected", JSONValue.boolOrNull(frameRedirected)),
                ("serverHitsRedirectMe", .int(serverHitsOriginal)),
                ("serverHitsRedirected", .int(serverHitsRedirected)),
            ])
        }
    }

    private func runRedirectStop(
        list: WKContentRuleList,
        patterns: [String: Set<String>]?,
        completion: @escaping (RedirectStop) -> Void
    ) {
        let view = SpikeWebView(
            container: container, lists: [list], script: script, log: log, clock: clock
        )
        if let patterns = patterns { view.delegate.activePatterns = patterns }
        let beforeOriginal = fixtures.hitCount("/redirect-me.js")
        let beforeRedirected = fixtures.hitCount("/redirected.js")
        let url = fixtures.resolve("fixture:/redirect.html")
        view.load(url, settleMs: 1_200, timeoutMs: 15_000) { [weak self] loaded in
            guard let self = self else { return }
            var stop = RedirectStop()
            stop.loaded = loaded
            view.evaluateEverywhere("window.__probeFixture || null") { results in
                for (isMain, value) in results {
                    let page = value as? [String: Any] ?? [:]
                    let redirected = (page["redirected"] as? NSNumber)?.boolValue ?? false
                    if isMain { stop.mainRedirected = redirected } else { stop.frameRedirected = redirected }
                }
                stop.serverHitsOriginal = self.fixtures.hitCount("/redirect-me.js") - beforeOriginal
                stop.serverHitsRedirected = self.fixtures.hitCount("/redirected.js") - beforeRedirected
                view.remove()
                completion(stop)
            }
        }
    }

    // MARK: - 3.4 and 3.5 media

    private func probeMediaPreference() {
        let mark = clock.ms()
        let id = "media-pref-next-navigation"
        let title = "Do WKPreferences media SPI changes apply from the next navigation?"

        let view = SpikeWebView(
            container: container, lists: [], script: script, log: log, clock: clock
        )
        let preferences = view.webView.configuration.preferences
        let mediaSetter = NSSelectorFromString("_setMediaSourceEnabled:")
        let managedSetter = NSSelectorFromString("_setManagedMediaSourceEnabled:")
        let mediaPresent = preferences.responds(to: mediaSetter)
        let managedPresent = preferences.responds(to: managedSetter)

        guard mediaPresent || managedPresent else {
            view.remove()
            addProbe(
                SpikeProbe(
                    id: id, title: title, verdict: "unknown", ms: clock.since(mark),
                    evidence: .object([
                        ("mediaSourceSpi", .bool(false)),
                        ("managedMediaSourceSpi", .bool(false)),
                    ]),
                    reason: "neither media preference SPI is present on WKPreferences"
                )
            )
            probeMediaAvailability()
            return
        }

        func setPreferences(_ enabled: Bool) {
            // The KVC key drops the leading underscore on purpose: the setter WebKit
            // declares is `_setMediaSourceEnabled:`, which is exactly what KVC's
            // `_set<Key>:` step finds. The setter is checked with responds(to:) first,
            // because an unanswered key raises an exception Swift cannot catch.
            if mediaPresent {
                preferences.setValue(NSNumber(value: enabled), forKey: "mediaSourceEnabled")
            }
            if managedPresent {
                preferences.setValue(NSNumber(value: enabled), forKey: "managedMediaSourceEnabled")
            }
        }

        let url = fixtures.resolve("fixture:/media.html")
        let readout = "JSON.stringify((window.__probeFixture || {}).media || null)"

        setPreferences(false)
        view.load(url, settleMs: 400, timeoutMs: 15_000) { [weak self] loadedOne in
            guard let self = self else { return }
            view.evaluate(readout) { first in
                setPreferences(true)
                view.load(url, settleMs: 400, timeoutMs: 15_000) { loadedTwo in
                    view.evaluate(readout) { second in
                        setPreferences(false)
                        view.load(url, settleMs: 400, timeoutMs: 15_000) { loadedThree in
                            view.evaluate(readout) { third in
                                let stops = [first, second, third].map { SpikeRunner.mediaStop($0) }
                                let evidence = JSONValue.object([
                                    ("mediaSourceSpi", .bool(mediaPresent)),
                                    ("managedMediaSourceSpi", .bool(managedPresent)),
                                    ("stops", .array([
                                        SpikeRunner.mediaStopJSON("native", stops[0]),
                                        SpikeRunner.mediaStopJSON("desktop-mse", stops[1]),
                                        SpikeRunner.mediaStopJSON("native-again", stops[2]),
                                    ])),
                                    ("webViewRecreated", .bool(false)),
                                ])
                                var verdict = "unknown"
                                var reason: String?
                                let allLoaded = loadedOne && loadedTwo && loadedThree
                                let blind = stops.allSatisfy {
                                    ($0["mediaSource"] as? String ?? "undefined") == "undefined"
                                        && ($0["managedMediaSource"] as? String ?? "undefined") == "undefined"
                                }
                                if !allLoaded {
                                    reason = "a stop did not load"
                                } else if blind {
                                    // Simulator media capability differs from the phone;
                                    // a type absent in every state makes the experiment
                                    // blind, and that is `unknown`, not `fail`.
                                    reason = "neither type is exposed in any state, so the experiment is blind"
                                } else if SpikeRunner.mediaChanged(stops[0], stops[1])
                                    && SpikeRunner.mediaChanged(stops[1], stops[2]) {
                                    verdict = "pass"
                                } else {
                                    verdict = "fail"
                                    reason = "the reported types did not change across stops"
                                }
                                view.remove()
                                self.addProbe(
                                    SpikeProbe(
                                        id: id, title: title, verdict: verdict,
                                        ms: self.clock.since(mark), evidence: evidence, reason: reason
                                    )
                                )
                                self.probeMediaAvailability()
                            }
                        }
                    }
                }
            }
        }
    }

    private static func mediaStop(_ value: Any?) -> [String: Any] {
        guard let text = value as? String, let data = text.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data),
              let object = parsed as? [String: Any]
        else { return [:] }
        return object
    }

    private static func mediaStopJSON(_ name: String, _ stop: [String: Any]) -> JSONValue {
        .object([("stop", .string(name)), ("report", JSONValue.from(stop))])
    }

    private static func mediaChanged(_ left: [String: Any], _ right: [String: Any]) -> Bool {
        for key in ["mediaSource", "managedMediaSource"] {
            let a = left[key] as? String ?? "undefined"
            let b = right[key] as? String ?? "undefined"
            if a != b { return true }
        }
        return false
    }

    private func probeMediaAvailability() {
        let mark = clock.ms()
        let id = "media-source-availability"
        let title = "What does this simulator expose: MediaSource, ManagedMediaSource, HLS, codecs?"

        let view = SpikeWebView(
            container: container, lists: [], script: script, log: log, clock: clock
        )
        let url = fixtures.resolve("fixture:/media.html")
        view.load(url, settleMs: 400, timeoutMs: 15_000) { [weak self] loaded in
            guard let self = self else { return }
            view.evaluate("JSON.stringify((window.__probeFixture || {}).media || null)") { value in
                let report = SpikeRunner.mediaStop(value)
                view.remove()
                // A capability report is never `fail`: "this runner has no AV1 decoder"
                // is a fact about the runner, and a red cell would teach the reader to
                // ignore red cells.
                let verdict = (loaded && !report.isEmpty) ? "pass" : "unknown"
                self.addProbe(
                    SpikeProbe(
                        id: id, title: title, verdict: verdict, ms: self.clock.since(mark),
                        evidence: .object([
                            ("pageLoaded", .bool(loaded)),
                            ("report", JSONValue.from(report)),
                            ("appliesTo", .string("simulator; not a statement about a device")),
                        ]),
                        reason: verdict == "pass" ? nil : "the media fixture never reported"
                    )
                )
                self.probePageLoadTiming()
            }
        }
    }

    // MARK: - 3.6 page-load-timing-spi

    private func probePageLoadTiming() {
        let mark = clock.ms()
        let id = "page-load-timing-spi"
        let title = "Does _webView:didGeneratePageLoadTiming: fire, and what does _WKPageLoadTiming carry?"

        let view = SpikeWebView(
            container: container, lists: [], script: script, log: log, clock: clock
        )
        let selectorPresent = view.delegate.responds(to: NSSelectorFromString(SpikeRunner.timingSelector))
        let url = fixtures.resolve("fixture:/selftest.html")
        view.load(url, settleMs: 200, timeoutMs: 15_000) { [weak self] loaded in
            guard let self = self else { return }
            // The callback may arrive well after didFinish; the spec allows ten seconds.
            probePoll(intervalMs: 250, timeoutMs: 10_000, until: {
                view.metrics.pageLoadTiming != nil
            }, completion: { fired in
                view.evaluate(
                    "JSON.stringify({nav: performance.timing ? "
                        + "(performance.timing.loadEventEnd - performance.timing.navigationStart) : null})"
                ) { value in
                    let navigationTiming = SpikeRunner.mediaStop(value)
                    let readable = view.metrics.pageLoadTiming ?? [:]
                    var verdict = "unknown"
                    var reason: String?
                    if !loaded {
                        reason = "the fixture page did not load, so nothing can be said"
                    } else if fired, readable["navigationStart"] != nil, readable.count >= 2 {
                        verdict = "pass"
                    } else if fired {
                        verdict = "unknown"
                        reason = "the callback fired but carried no readable properties"
                    } else if !navigationTiming.isEmpty {
                        verdict = "fail"
                        reason = "Navigation Timing answered, so the page loaded, but the callback never fired"
                    } else {
                        reason = "neither the callback nor Navigation Timing answered"
                    }
                    view.remove()
                    self.addProbe(
                        SpikeProbe(
                            id: id, title: title, verdict: verdict, ms: self.clock.since(mark),
                            evidence: .object([
                                ("selectorPresent", .bool(selectorPresent)),
                                ("callbackFired", .bool(fired)),
                                ("propertiesMs", JSONValue.counts(readable)),
                                ("navigationTiming", JSONValue.from(navigationTiming)),
                                ("note", .string(
                                    "the API's existence is trustworthy; the milliseconds are indicative"
                                        + " on a virtualised runner"
                                )),
                            ]),
                            reason: reason
                        )
                    )
                    self.finish()
                }
            })
        }
    }

    // MARK: - Plumbing

    /// Compiles on a background queue, because RuleListCompiler.compile blocks waiting
    /// for a callback the main thread has to deliver.
    private func compileOffMain(
        identifier: String, json: String, compiler: RuleListCompiler,
        completion: @escaping (WKContentRuleList?, String?) -> Void
    ) {
        let before = compiler.compiledLists.count
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = compiler.compile(
                identifier: identifier, json: json, timeoutMs: 20_000
            )
            let lists = compiler.compiledLists
            let list = lists.count > before ? lists[lists.count - 1] : nil
            DispatchQueue.main.async { completion(list, outcome.error) }
        }
    }

    private func addProbe(_ probe: SpikeProbe) {
        log.line("probe \(probe.id): \(probe.verdict)\(probe.reason.map { " (\($0))" } ?? "")")
        probes.append(probe)
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        fixtures.stop()
        paths.removeStore()

        // Every probe is always present, even when skipped: a probe that vanishes from
        // the output is indistinguishable from a probe nobody wrote.
        let expected = [
            ("installed-runtimes", "Which simulator runtimes and iPhone device types exist?"),
            ("rule-list-action-callback", "Does the rule-list action callback fire?"),
            ("active-action-patterns", "Do active action patterns gate redirects?"),
            ("media-pref-next-navigation", "Do media preference changes apply on the next navigation?"),
            ("media-source-availability", "What media capability does this runtime expose?"),
            ("page-load-timing-spi", "Does the page-load-timing SPI exist and fire?"),
        ]
        var ordered: [JSONValue] = []
        for (id, title) in expected {
            if let probe = probes.first(where: { $0.id == id }) {
                ordered.append(probe.json())
            } else {
                ordered.append(
                    SpikeProbe(
                        id: id, title: title, verdict: "unknown", ms: 0,
                        evidence: .object([]),
                        reason: "the probe did not run: the suite ended before it started"
                    ).json()
                )
            }
        }

        let host = HostInfo.current(
            viewport: container.bounds.size, scale: UIScreen.main.scale, userAgent: nil
        )
        record = .object([
            ("schemaVersion", .int(1)),
            ("suite", .string("spike")),
            ("runId", .string(arguments.runId)),
            ("startedAt", .string(ProbeClock.rfc3339(started))),
            ("endedAt", .string(ProbeClock.rfc3339(Date()))),
            ("host", .object([
                ("osVersion", .string(host.osVersion)),
                ("osMajor", .int(host.osMajor)),
                ("model", .string(host.model)),
                ("deviceName", .string(host.deviceName)),
                ("webkitBuild", .null),
                ("userAgent", JSONValue.stringOrNull(host.userAgent)),
            ])),
            ("fixturePort", .int(Int(fixtures.port))),
            ("probes", .array(ordered)),
            ("harness", .object([
                ("status", .string(status)),
                ("exitCode", .int(Int(exitCode.rawValue))),
                ("errors", .array(log.errors.map { .string($0) })),
                ("warnings", .array(log.warnings.map { .string($0) })),
            ])),
        ])
        completion?(exitCode)
    }
}
