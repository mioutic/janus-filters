// SPDX-License-Identifier: GPL-3.0-or-later
//
// ScenarioRunner.swift - the step machine of docs/probehost/01-probehost.md section 3.
//
// Load, settle, classify, scroll, snapshot, tap, count, snapshot, write. Each phase has
// its own deadline and a phase that expires is recorded in `harness.timeouts` and
// followed by the next phase, because a run that measured four things out of six is
// worth more than a run that measured nothing. The whole run has a budget too, and when
// it expires the record is written with `harness.status: "budget"` and whatever was
// measured - still exit 0, because a budget is a fact about the runner, not about the
// filters.
//
// Nothing in here can make the process exit non-zero for a *blocking* outcome. Zero
// blocked requests, a page that never loaded, a bucket that would not compile and a
// CAPTCHA are all exit 0 with the facts recorded (section 2.3).

import Foundation
import UIKit
import WebKit

/// A flag set from one thread and read from another. The bundle phase runs on a
/// background queue and has to notice a budget that expired on the main thread.
final class AtomicFlag {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}

/// The one scenario this launch was given (02-runner.md section 5.1). The runner stages
/// it, already expanded: `@common` is resolved, `urlFrom` is resolved, and the page-state
/// matchers travel with it. The app therefore has no opinion about which sites exist.
struct Scenario {
    var id: String
    var title: String?
    var url: String
    var selectors: [String]
    var tapCentre: Bool
    var waitIdleMs: Int
    var timeoutMs: Int
    var budgetMs: Int?
    var screenshots: Bool
    var scrollTimes: Int
    var scrollDy: Int
    var scrollPauseMs: Int
    var pageStateMatchers: [String: Any]
    var repeatIndex: Int?
    var order: [String]?
    var expect: [String: Any]?

    /// Accepts either the scenario object at the top level or wrapped in a `scenario`
    /// key, with `pageState` alongside it or inside it. Both shapes appear in the
    /// runner's staging code over time and neither costs anything to support; what is
    /// *not* supported is a missing `id` or `url`, which is a usage error.
    static func load(from url: URL, arguments: Arguments) throws -> Scenario {
        guard let data = try? Data(contentsOf: url) else {
            throw ProbeFailure(
                .usage, "scenario-unreadable",
                "could not read the scenario at \(url.lastPathComponent)"
            )
        }
        guard let top = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw ProbeFailure(.usage, "scenario-malformed", "the scenario file is not a JSON object")
        }
        let body = (top["scenario"] as? [String: Any]) ?? top
        guard let id = body["id"] as? String, !id.isEmpty else {
            throw ProbeFailure(.usage, "scenario-no-id", "the scenario has no id")
        }
        guard let target = body["url"] as? String, !target.isEmpty else {
            throw ProbeFailure(.usage, "scenario-no-url", "scenario \(id) has no url")
        }
        let scroll = (body["scroll"] as? [String: Any]) ?? [:]
        let matchers = (top["pageState"] as? [String: Any])
            ?? (body["pageState"] as? [String: Any]) ?? [:]

        return Scenario(
            id: id,
            title: body["title"] as? String,
            url: target,
            selectors: (body["selectors"] as? [String])?.filter { !$0.isEmpty } ?? [],
            tapCentre: (body["tapCentre"] as? NSNumber)?.boolValue ?? false,
            waitIdleMs: (body["waitIdleMs"] as? NSNumber)?.intValue ?? 2_500,
            timeoutMs: (body["timeoutMs"] as? NSNumber)?.intValue ?? arguments.stepTimeoutMs,
            budgetMs: (body["budgetMs"] as? NSNumber)?.intValue,
            screenshots: ((body["screenshots"] as? NSNumber)?.boolValue ?? true)
                && arguments.screenshots,
            scrollTimes: (scroll["times"] as? NSNumber)?.intValue ?? 0,
            scrollDy: (scroll["dy"] as? NSNumber)?.intValue ?? 800,
            scrollPauseMs: (scroll["pauseMs"] as? NSNumber)?.intValue ?? 700,
            pageStateMatchers: matchers,
            repeatIndex: (body["repeat"] as? NSNumber)?.intValue,
            order: body["order"] as? [String],
            expect: body["expect"] as? [String: Any]
        )
    }
}

final class ScenarioRunner {
    private let arguments: Arguments
    private let paths: RunPaths
    private let log: Log
    private let clock: ProbeClock
    private let record: RunRecord
    private let container: UIView

    private let metrics: ProbeMetrics
    private let delegate: ProbeDelegate
    private let verifier: ContractVerifier
    private let fixtures: FixtureServer
    private let budgetExpired = AtomicFlag()

    private var scenario: Scenario?
    private var webView: WKWebView?
    private var compiler: RuleListCompiler?
    private var resolvedUrl: String = ""
    private var settled = false
    private var finished = false
    private var completion: ((ProbeExit) -> Void)?
    private var domOverlays: [JSONValue] = []

    init(
        arguments: Arguments, paths: RunPaths, log: Log, clock: ProbeClock,
        record: RunRecord, container: UIView
    ) {
        self.arguments = arguments
        self.paths = paths
        self.log = log
        self.clock = clock
        self.record = record
        self.container = container
        self.metrics = ProbeMetrics(
            clock: clock, maxRequests: arguments.maxRequests, maxConsole: arguments.maxConsole
        )
        self.delegate = ProbeDelegate(metrics: metrics, log: log, clock: clock)
        self.verifier = ContractVerifier(clock: clock, log: log)
        self.fixtures = FixtureServer(log: log, clock: clock)
    }

    // MARK: - Entry

    func start(completion: @escaping (ProbeExit) -> Void) {
        self.completion = completion
        record.suite = "scenario"
        record.mode = arguments.mode.rawValue

        do {
            let scenario = try Scenario.load(
                from: paths.containerURL(arguments.scenarioPath), arguments: arguments
            )
            self.scenario = scenario
            record.scenarioId = scenario.id
            record.repeatIndex = scenario.repeatIndex
            record.order = scenario.order
            if let expect = scenario.expect {
                record.expect = JSONValue.from(expect)
            }
            log.line("scenario \(scenario.id) mode \(arguments.mode.rawValue)")

            // The whole-run budget. It is armed before anything slow happens, and it is
            // what guarantees a DONE sentinel even if a phase never calls back.
            let budget = scenario.budgetMs ?? arguments.budgetMs
            probeAfter(ms: budget) { [weak self] in
                guard let self = self, !self.finished else { return }
                self.budgetExpired.set()
                self.log.warn("run budget of \(budget)ms expired")
                self.record.timeouts.append(("run", budget))
                self.finish(status: "budget", exit: .ok)
            }

            if scenario.url.hasPrefix("fixture:") {
                let port = try fixtures.start(requestedPort: arguments.fixturePort)
                record.fixturePort = Int(port)
                // Logged rather than awaited. If the listener turns out to be
                // unreachable, the gate failure that follows arrives with the reason
                // already in the same run.log instead of costing another CI round.
                fixtures.verifyReachable()
            }
            resolvedUrl = fixtures.resolve(scenario.url)
            record.requestedUrl = ProbeURL.strip(resolvedUrl)
            delegate.requestedRegistrableDomain =
                ProbeURL.registrableDomain(ProbeURL.host(resolvedUrl))

            bundlePhase()
        } catch let failure as ProbeFailure {
            fail(failure)
        } catch {
            fail(ProbeFailure(.internalError, "unexpected", error.localizedDescription))
        }
    }

    // MARK: - Phase 1: bundle, verify, compile

    private func bundlePhase() {
        let loader = BundleLoader(
            arguments: arguments, clock: clock, log: log, verifier: verifier
        )
        let storeDirectory: URL
        do {
            storeDirectory = try paths.prepareStore(keepExisting: arguments.keepStore)
            compiler = try RuleListCompiler(storeDirectory: storeDirectory, log: log, clock: clock)
        } catch let failure as ProbeFailure {
            fail(failure)
            return
        } catch {
            fail(ProbeFailure(.internalError, "store", error.localizedDescription))
            return
        }
        guard let compiler = compiler else { return }

        let osMajor = Int(UIDevice.current.systemVersion.split(separator: ".").first.map(String.init) ?? "")
            ?? 0
        let wantsSelftestList =
            (scenario?.url.hasPrefix("fixture:") ?? false) && arguments.mode == .blocked
        let started = clock.ms()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            var buckets: [CompiledBucket] = []
            var activePatterns: (list: String, count: Int, scope: String)?
            do {
                let loaded = try loader.loadManifest(appBuild: HostInfo.appBuildNumber)
                let manifest = loaded.manifest
                let (flavour, automatic) = Arguments.resolvedFlavour(
                    self.arguments.flavour, osMajor: osMajor
                )
                guard manifest.flavours.contains(flavour) else {
                    throw ProbeFailure(
                        .bundle, "flavour-absent",
                        "the bundle carries no \(flavour) flavour"
                    )
                }
                if !automatic {
                    let expected = osMajor >= 26 ? "ios26" : "ios17"
                    if expected != flavour {
                        self.log.warn(
                            "measuring flavour \(flavour) on iOS \(osMajor), which CONTRACT 8.1 "
                                + "would pick \(expected) for"
                        )
                    }
                }

                let ageHours = manifest.issuedAtDate.map {
                    Int(Date().timeIntervalSince($0) / 3600.0)
                }
                let bundleBlock = RunRecord.bundleBlock(
                    manifest: manifest,
                    manifestSha256: ContractVerifier.sha256Hex(loaded.bytes),
                    origin: loader.origin,
                    flavour: flavour,
                    flavourAuto: automatic,
                    ageHours: ageHours
                )

                // CONTRACT 8.6: the active action pattern set is derived from
                // payloads.siteFix, never hard-coded. The payload is fetched and verified
                // for that reason alone; the surrogate count is what the record carries.
                var surrogatePatterns = 0
                if manifest.killSwitchEnabled("surrogates"),
                   let entry = manifest.payloads["siteFix"] {
                    let data = try loader.loadPayload(
                        file: entry.file, expected: entry, label: "payloads.siteFix"
                    )
                    if let payload = try? JSONDecoder().decode(SiteFixPayload.self, from: data) {
                        surrogatePatterns = payload.surrogatePatternCount
                    } else {
                        self.log.warn("payloads.siteFix did not decode; active patterns not derived")
                    }
                }

                if wantsSelftestList {
                    // The offline self check: one URL that must be blocked and one that
                    // must load. Without it, "0 requests blocked" on a live site is
                    // ambiguous between "the filters did not block" and "the harness is
                    // not measuring" (00-index.md section 1).
                    let identifier = "probe.selftest.local"
                    let outcome = compiler.compile(
                        identifier: identifier,
                        json: RuleListCompiler.selftestRuleListJSON(),
                        timeoutMs: 15_000
                    )
                    buckets.append(
                        CompiledBucket(
                            id: identifier, family: "probe.selftest", identifier: identifier,
                            ruleCount: 2, size: nil, downloadSize: nil, downloadMs: nil,
                            decompressMs: nil, compileMs: outcome.ms, ok: outcome.error == nil,
                            error: outcome.error, attached: outcome.error == nil, synthetic: true
                        )
                    )
                    if let error = outcome.error {
                        self.log.warn("the self-check rule list did not compile: " + error)
                    }
                }

                let selected = manifest.selectedBuckets(
                    flavour: flavour, families: self.arguments.families,
                    optInLists: self.arguments.optInLists
                )
                self.log.line(
                    "bundle \(manifest.version) flavour \(flavour): \(selected.count) buckets selected"
                )

                for (bucket, entry) in selected {
                    if self.budgetExpired.isSet {
                        self.log.warn("budget expired during compile; \(buckets.count) buckets done")
                        break
                    }
                    let identifier = Manifest.identifier(
                        bucketId: bucket.id, sha256: entry.sha256
                    )
                    var compiled = CompiledBucket(
                        id: bucket.id, family: bucket.family, identifier: identifier,
                        ruleCount: entry.ruleCount, size: entry.size,
                        downloadSize: entry.downloadSize, downloadMs: nil,
                        decompressMs: nil, compileMs: nil, ok: false, error: nil, attached: false
                    )

                    let downloadMark = self.clock.ms()
                    let compressed = try loader.fetchPayloadBytes(
                        file: entry.file, label: bucket.id
                    )
                    compiled.downloadMs = self.clock.since(downloadMark)

                    let verifyMark = self.clock.ms()
                    let json = try self.verifier.verifyPayload(
                        compressed, expected: entry, label: bucket.id
                    )
                    compiled.decompressMs = self.clock.since(verifyMark)

                    // Mode `none` attaches nothing, so compiling all ~59 lists there was
                    // ~42 s of runner time per launch spent on a rule set no page would
                    // ever see - half the suite's bundle work, which is what pushed the
                    // tail of the scenario list into skipped/budget. Everything the
                    // contract is verified from still happens above: the payload is
                    // downloaded, its hash checked and its JSON decompressed. Only the
                    // WebKit compile is skipped, and the record says so.
                    if self.arguments.mode == .blocked {
                        let outcome = compiler.compile(
                            identifier: identifier,
                            json: String(decoding: json, as: UTF8.self),
                            timeoutMs: self.arguments.stepTimeoutMs
                        )
                        compiled.compileMs = outcome.ms
                        compiled.ok = outcome.error == nil
                        compiled.error = outcome.error
                        compiled.attached = compiled.ok
                        if let error = outcome.error {
                            self.log.warn("bucket \(bucket.id) did not compile: \(error)")
                        }
                    } else {
                        compiled.compiled = false
                        compiled.ok = true
                        compiled.attached = false
                    }
                    buckets.append(compiled)

                    if bucket.family == "active", compiled.ok, surrogatePatterns > 0 {
                        // WebKit matches these as URL match patterns, not as the regexes
                        // the surrogate entries carry, so the list is granted the widest
                        // scope and each rule's own url-filter decides where it applies.
                        // Narrowing here could only under-report what janus.active does.
                        activePatterns = (identifier, surrogatePatterns, "*://*/*")
                    }
                }
                self.verifier.finishPayloadSteps()

                let totalMs = self.clock.since(started)
                let attached = buckets.filter { $0.attached }.count
                DispatchQueue.main.async {
                    self.record.bundle = bundleBlock
                    self.record.contract = RunRecord.contractBlock(self.verifier)
                    self.record.compile = RunRecord.compileBlock(
                        buckets: buckets, attached: attached, totalMs: totalMs,
                        storeFresh: !self.arguments.keepStore, activePatterns: activePatterns
                    )
                    if let patterns = activePatterns, self.arguments.mode == .blocked {
                        self.delegate.activePatterns = [patterns.list: [patterns.scope]]
                    }
                    self.buildWebView()
                }
            } catch let failure as ProbeFailure {
                DispatchQueue.main.async {
                    self.record.contract = RunRecord.contractBlock(self.verifier)
                    if !buckets.isEmpty {
                        self.record.compile = RunRecord.compileBlock(
                            buckets: buckets, attached: 0, totalMs: self.clock.since(started),
                            storeFresh: !self.arguments.keepStore, activePatterns: nil
                        )
                    }
                    self.fail(failure)
                }
            } catch {
                DispatchQueue.main.async {
                    self.fail(
                        ProbeFailure(.internalError, "bundle-phase", error.localizedDescription)
                    )
                }
            }
        }
    }

    // MARK: - Phase 2: the web view

    private func buildWebView() {
        guard !finished, scenario != nil, let compiler = compiler else { return }

        guard let scriptURL = Bundle.main.url(forResource: "probe", withExtension: "js"),
              let script = try? String(contentsOf: scriptURL, encoding: .utf8)
        else {
            fail(ProbeFailure(.internalError, "probe-js-missing", "probe.js is not in the app bundle"))
            return
        }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.suppressesIncrementalRendering = false

        let controller = WKUserContentController()
        controller.add(delegate, name: "probe")
        controller.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )

        if arguments.mode == .blocked {
            for list in compiler.compiledLists { controller.add(list) }
            log.line("attached \(compiler.compiledLists.count) rule lists")
        } else {
            log.line("mode none: no rule lists attached")
        }
        configuration.userContentController = controller

        let webView = WKWebView(frame: container.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isInspectable = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Delegates are assigned only once the object is complete: WebKit caches
        // respondsToSelector: at assignment, and the two private selectors above are
        // what the headline number depends on.
        webView.navigationDelegate = delegate
        webView.uiDelegate = delegate
        // Availability, not activity: whether this WebKit still declares the rule-list
        // action callback. It is true in mode `none` as well, which is the point - a run
        // that blocked nothing must not read as "the SPI is gone".
        record.spiSelectorPresent = delegate.responds(
            to: NSSelectorFromString(
                "_webView:contentRuleListWithIdentifier:performedAction:forURL:"
            )
        )
        container.addSubview(webView)
        self.webView = webView

        record.host = HostInfo.current(
            viewport: container.bounds.size,
            scale: UIScreen.main.scale,
            userAgent: nil
        ).json(simulator: true)
        // The Result-based overload, so nothing depends on which of the two
        // evaluateJavaScript signatures the compiler picks.
        webView.evaluateJavaScript("navigator.userAgent", in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            guard case .success(let value) = result, let agent = value as? String else { return }
            self.record.host = HostInfo.current(
                viewport: self.container.bounds.size,
                scale: UIScreen.main.scale,
                userAgent: agent
            ).json(simulator: true)
        }

        navigate()
    }

    // MARK: - Phase 3: navigate and settle

    private func navigate() {
        guard let webView = webView, let scenario = scenario else { return }
        guard let url = URL(string: resolvedUrl) else {
            fail(ProbeFailure(.usage, "scenario-bad-url", "the scenario url did not parse"))
            return
        }
        // The metrics only join the record once a page is actually being loaded. A run
        // that failed before this point reports `requests` and `blocked` as null - not
        // measured - rather than as zero, which would read as "measured, and it was
        // zero" (section 5).
        record.metrics = metrics
        metrics.navigationStartMs = clock.ms()
        delegate.onDidFinish = { [weak self] in self?.log.detail("didFinish") }
        delegate.onWebContentTerminated = { [weak self] in
            self?.log.warn("web content terminated during load")
        }
        log.line("loading \(ProbeURL.strip(resolvedUrl))")
        webView.load(URLRequest(url: url))

        probePoll(timeoutMs: scenario.timeoutMs, until: { [weak self] in
            guard let self = self else { return true }
            return self.metrics.didFinish || self.metrics.failure != nil
                || self.metrics.webContentTerminated
        }, completion: { [weak self] loaded in
            guard let self = self, !self.finished else { return }
            if !loaded {
                self.log.warn("load did not finish within \(scenario.timeoutMs)ms")
                self.record.timeouts.append(("load", scenario.timeoutMs))
            }
            self.waitForIdle()
        })
    }

    private func waitForIdle() {
        guard let scenario = scenario else { return }
        let idleTarget = scenario.waitIdleMs
        let deadline = min(scenario.timeoutMs, idleTarget * 4 + 2_000)
        let startedIdle = clock.ms()
        probePoll(intervalMs: 150, timeoutMs: deadline, until: { [weak self] in
            guard let self = self else { return true }
            let quiet = self.clock.ms() - max(self.metrics.lastRequestMs, startedIdle)
            return quiet >= idleTarget
        }, completion: { [weak self] quiet in
            guard let self = self, !self.finished else { return }
            if !quiet {
                self.log.detail("page never went quiet for \(idleTarget)ms")
                self.record.timeouts.append(("idle", deadline))
            }
            self.settled = true
            self.classifyPageState()
        })
    }

    // MARK: - Phase 4: classify, scroll, snapshot, tap, count

    private func classifyPageState() {
        guard let scenario = scenario else { return }
        let config = ScenarioRunner.jsonText(scenario.pageStateMatchers)
        // Every frame, not just the main one: OneTrust, Didomi and Sourcepoint render
        // their consent UI inside a cross-origin iframe, so a main-frame-only matcher
        // would almost never see the consent wall its selectors were written for.
        evaluateInAllFrames("window.__probe && __probe.state(\(config))") { [weak self] results in
            guard let self = self else { return }
            var state = "unknown"
            var matched: [JSONValue] = []
            var title: String?
            var answered = false
            var names: Set<String> = []
            for (frame, value) in results {
                guard let result = value as? [String: Any] else { continue }
                answered = true
                if frame == nil || frame?.isMainFrame == true {
                    title = (result["title"] as? String) ?? title
                }
                let hits = (result["matched"] as? [[Any]]) ?? []
                for hit in hits where hit.count >= 2 {
                    guard let name = hit[0] as? String else { continue }
                    names.insert(name)
                    matched.append(.object([
                        ("state", .string(name)),
                        ("evidence", .string(String(describing: hit[1]).prefix(120).description)),
                        ("frame", JSONValue.stringOrNull(frame?.origin ?? "main")),
                    ]))
                }
            }
            if answered {
                // Precedence: a body that actually matched a challenge wins over the HTTP
                // status, because Cloudflare and Reddit serve their bot walls as 403 and
                // filing those under "error" would contradict what the reader is told to
                // expect. The status stays in the record either way, so both facts
                // survive. A load that never produced a page is still an error.
                if self.metrics.webContentTerminated || self.metrics.failure != nil {
                    state = "error"
                } else if names.contains("challenged") {
                    state = "challenged"
                } else if (self.metrics.httpStatus ?? 200) >= 400 {
                    state = "error"
                } else if names.contains("login-wall") {
                    state = "login-wall"
                } else if names.contains("consent-wall") {
                    state = "consent-wall"
                } else if self.metrics.didFinish {
                    state = "ok"
                }
            } else if self.metrics.failure != nil || self.metrics.webContentTerminated {
                state = "error"
            }
            self.record.pageState = .object([
                ("state", .string(state)),
                ("matched", .array(matched)),
                ("title", JSONValue.stringOrNull(title)),
                ("httpStatus", JSONValue.intOrNull(self.metrics.httpStatus)),
            ])
            self.log.line("pageState \(state)")
            self.scrollPhase(step: 0, performed: 0)
        }
    }

    private func scrollPhase(step: Int, performed: Int) {
        guard let scenario = scenario, !finished else { return }
        guard step < scenario.scrollTimes, !budgetExpired.isSet else {
            record.scroll = .object([
                ("requested", .int(scenario.scrollTimes)),
                ("performed", .int(performed)),
                ("dy", .int(scenario.scrollDy)),
                ("finalScrollY", .null),
            ])
            if scenario.scrollTimes > 0 {
                // Read the final position before moving on, so a lazy feed's scroll
                // depth is part of the record rather than folklore.
                evaluate("window.__probe && __probe.scroll(0)", in: nil) { [weak self] value in
                    guard let self = self else { return }
                    self.record.scroll = .object([
                        ("requested", .int(scenario.scrollTimes)),
                        ("performed", .int(performed)),
                        ("dy", .int(scenario.scrollDy)),
                        ("finalScrollY", JSONValue.from(value)),
                    ])
                    self.snapshot(name: "settle") { self.tapPhase() }
                }
            } else {
                snapshot(name: "settle") { self.tapPhase() }
            }
            return
        }
        evaluate("window.__probe && __probe.scroll(\(scenario.scrollDy))", in: nil) { [weak self] _ in
            guard let self = self else { return }
            probeAfter(ms: scenario.scrollPauseMs) {
                self.scrollPhase(step: step + 1, performed: performed + 1)
            }
        }
    }

    private func tapPhase() {
        guard let scenario = scenario, !finished else { return }
        guard scenario.tapCentre, !budgetExpired.isSet else {
            record.tap = .object([
                ("requested", .bool(scenario.tapCentre)),
                ("performed", .bool(false)),
                ("method", .string("synthetic")),
                ("trusted", .bool(false)),
            ])
            countPhase()
            return
        }
        evaluate("window.__probe && __probe.tap()", in: nil) { [weak self] value in
            guard let self = self else { return }
            self.metrics.tapMs = self.clock.ms()
            var fields: [(String, JSONValue)] = [
                ("requested", .bool(true)),
                ("method", .string("synthetic")),
                // Not a trusted tap: WebKit grants user activation only to HID-level
                // input, so popup counts taken after this are indicative, never a pass
                // criterion (00-index.md section 1).
                ("trusted", .bool(false)),
                ("ms", .int(self.clock.ms())),
            ]
            if let result = value as? [String: Any] {
                fields.append(("performed", .bool((result["performed"] as? NSNumber)?.boolValue ?? false)))
                fields.append(("x", JSONValue.from(result["x"])))
                fields.append(("y", JSONValue.from(result["y"])))
                fields.append(("targetTag", JSONValue.from(result["targetTag"])))
                fields.append(("targetOrigin", JSONValue.from(result["targetOrigin"])))
                fields.append(("userActivationAfter", JSONValue.from(result["userActivationAfter"])))
            } else {
                fields.append(("performed", .bool(false)))
            }
            self.record.tap = .object(fields)
            // Give the page a moment to react: a popunder, a dialog or an interstitial
            // all arrive after the click, not with it.
            probeAfter(ms: 2_000) {
                self.snapshot(name: "tap") { self.countPhase() }
            }
        }
    }

    /// Delivers the last batch of PerformanceObserver entries before anything is
    /// counted. probe.js batches on a 250 ms timer and otherwise only flushes on
    /// pagehide, so without this the final resource entries - and any console entry in
    /// the same batch - never reached requests.observed.
    private func flushProbe(_ next: @escaping () -> Void) {
        evaluateInAllFrames("window.__probe && __probe.flush()") { _ in
            // One run-loop turn, so the messages the flush posted reach the handler
            // before the next phase reads the metrics.
            probeAfter(ms: 50, next)
        }
    }

    private func countPhase() {
        guard scenario != nil, !finished else { return }
        flushProbe { [weak self] in self?.countPhaseNow() }
    }

    private func countPhaseNow() {
        guard let scenario = scenario, !finished else { return }
        let selectors = ScenarioRunner.jsonText(scenario.selectors)
        var totals: [String: (total: Int, visible: Int, error: String?)] = [:]
        var answered = 0
        var attempted = 0
        var uniqueTotal = 0
        var uniqueVisible = 0
        var frameErrors: [JSONValue] = []
        let startedMs = clock.ms() - metrics.navigationStartMs

        evaluateInAllFrames("window.__probe && __probe.count(\(selectors))") { [weak self] results in
            guard let self = self else { return }
            attempted = results.count
            for (frame, value) in results {
                guard let payload = value as? [String: Any],
                      let rows = payload["rows"] as? [[String: Any]] else {
                    // A frame that timed out, or whose WKFrameInfo went stale, answered
                    // nothing. It is named here rather than silently counted as zero.
                    frameErrors.append(.object([
                        ("frame", .string(frame?.origin ?? "main")),
                        ("error", .string("no answer")),
                    ]))
                    continue
                }
                answered += 1
                // An element inside a frame the page has hidden is not visible to a
                // person, however visible it is to getComputedStyle inside that frame.
                let frameVisible = (payload["frameVisible"] as? NSNumber)?.boolValue ?? true
                uniqueTotal += (payload["uniqueTotal"] as? NSNumber)?.intValue ?? 0
                if frameVisible {
                    uniqueVisible += (payload["uniqueVisible"] as? NSNumber)?.intValue ?? 0
                }
                for row in rows {
                    guard let selector = row["selector"] as? String else { continue }
                    var entry = totals[selector] ?? (0, 0, nil)
                    entry.total += (row["total"] as? NSNumber)?.intValue ?? 0
                    if frameVisible {
                        entry.visible += (row["visible"] as? NSNumber)?.intValue ?? 0
                    }
                    if entry.error == nil, let error = row["error"] as? String { entry.error = error }
                    totals[selector] = entry
                }
            }
            guard answered > 0 else {
                // Not measured, so null - never 0. "Ads visible 0" from a count that
                // never happened is the one reading this record must never support.
                self.log.warn("no frame answered the DOM count")
                self.record.dom = .object([
                    ("totalMatched", .null),
                    ("totalVisible", .null),
                    ("uniqueMatched", .null),
                    ("uniqueVisible", .null),
                    ("selectors", .null),
                    ("frames", .int(0)),
                    ("framesAttempted", .int(attempted)),
                    ("frameErrors", .array(frameErrors)),
                    ("msSinceNavigationStart", .int(startedMs)),
                ])
                self.overlayPhase()
                return
            }
            let ordered = scenario.selectors.map { selector -> JSONValue in
                let entry = totals[selector] ?? (0, 0, nil)
                return .object([
                    ("selector", .string(selector)),
                    ("total", .int(entry.total)),
                    ("visible", .int(entry.visible)),
                    ("error", JSONValue.stringOrNull(entry.error)),
                ])
            }
            self.record.dom = .object([
                // total* sums per selector, so an element matching several of the
                // @common selectors is counted several times; unique* de-duplicates
                // within each frame and is the honest "how many ad elements" number.
                ("totalMatched", .int(totals.values.reduce(0) { $0 + $1.total })),
                ("totalVisible", .int(totals.values.reduce(0) { $0 + $1.visible })),
                ("uniqueMatched", .int(uniqueTotal)),
                ("uniqueVisible", .int(uniqueVisible)),
                ("selectors", .array(ordered)),
                ("frames", .int(answered)),
                ("framesAttempted", .int(attempted)),
                ("frameErrors", .array(frameErrors)),
                // The two modes settle at different times on a lazy-loading page, so the
                // elapsed time the count was taken at is part of the measurement.
                ("msSinceNavigationStart", .int(startedMs)),
            ])
            self.overlayPhase()
        }
    }

    private func overlayPhase() {
        let startedMs = clock.ms() - metrics.navigationStartMs
        evaluateInAllFrames("window.__probe && __probe.overlays()") { [weak self] results in
            guard let self = self else { return }
            var overlays: [JSONValue] = []
            var seen = 0
            var answered = 0
            var truncated = false
            for (_, value) in results {
                guard let payload = value as? [String: Any],
                      let rows = payload["rows"] as? [[String: Any]] else { continue }
                answered += 1
                seen += (payload["seen"] as? NSNumber)?.intValue ?? rows.count
                if (payload["truncated"] as? NSNumber)?.boolValue == true { truncated = true }
                for row in rows {
                    guard overlays.count < ScenarioRunner.maxOverlays else {
                        truncated = true
                        break
                    }
                    overlays.append(JSONValue.from(row))
                }
            }
            guard answered > 0 else {
                self.record.overlays = .null
                self.record.overlaysSummary = .object([
                    ("seen", .null), ("kept", .null), ("truncated", .null),
                    ("msSinceNavigationStart", .int(startedMs)),
                ])
                self.fixturePhase()
                return
            }
            self.record.overlays = .array(overlays)
            // A capped array always has its truncation flag beside it (RunRecord 5.1).
            // Without seen/kept, 25 overlays in mode none and 10 in mode blocked both
            // reported 10 and the delta was silently zero.
            self.record.overlaysSummary = .object([
                ("seen", .int(seen)),
                ("kept", .int(overlays.count)),
                ("truncated", .bool(truncated)),
                ("msSinceNavigationStart", .int(startedMs)),
            ])
            self.fixturePhase()
        }
    }

    private func fixturePhase() {
        guard let scenario = scenario else { return }
        // One last flush before the record is built: anything the page loaded during the
        // count and overlay phases is still sitting in probe.js's 250 ms batch.
        guard scenario.url.hasPrefix("fixture:") else {
            flushProbe { [weak self] in
                guard let self = self else { return }
                self.snapshot(name: "end") { self.finish(status: "ok", exit: .ok) }
            }
            return
        }
        evaluate("window.__probe && __probe.fixture()", in: nil) { [weak self] value in
            guard let self = self else { return }
            var fields: [(String, JSONValue)] = [
                ("port", .int(Int(self.fixtures.port))),
                ("served", JSONValue.counts(self.fixtures.servedPaths)),
                // The server's own hit counts are the strongest evidence there is: a
                // request that never arrived is a request something stopped.
                ("blockedRequestReachedServer", .bool(self.fixtures.hitCount("/blocked.js") > 0)),
                ("allowedRequestReachedServer", .bool(self.fixtures.hitCount("/allowed.js") > 0)),
            ]
            if let flags = value as? [String: Any] {
                fields.append(("page", JSONValue.from(flags)))
            } else {
                fields.append(("page", .null))
            }
            self.record.fixture = .object(fields)
            self.flushProbe {
                self.snapshot(name: "end") { self.finish(status: "ok", exit: .ok) }
            }
        }
    }

    // MARK: - Helpers

    private func snapshot(name: String, then next: @escaping () -> Void) {
        guard let webView = webView, let scenario = scenario, scenario.screenshots else {
            next()
            return
        }
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let mark = clock.ms()
        var handled = false
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            guard let self = self, !handled else { return }
            handled = true
            defer { next() }
            guard let image = image, let data = image.pngData() else {
                self.log.warn("snapshot \(name) failed: \(error?.localizedDescription ?? "no image")")
                return
            }
            let url = self.paths.screenshotURL(name: name)
            do {
                try data.write(to: url, options: [.atomic])
                self.record.screenshots.append(
                    RunRecord.screenshotEntry(
                        name: name,
                        file: self.paths.screenshotFileName(name: name),
                        ms: mark,
                        size: image.size,
                        bytes: data.count
                    )
                )
            } catch {
                self.log.warn("could not write snapshot \(name): \(error.localizedDescription)")
            }
        }
    }

    private func evaluate(_ source: String, in frame: ProbeFrame?, completion: @escaping (Any?) -> Void) {
        guard let webView = webView else {
            completion(nil)
            return
        }
        var answered = false
        let deadline = min(10_000, arguments.stepTimeoutMs)
        probeAfter(ms: deadline) {
            guard !answered else { return }
            answered = true
            completion(nil)
        }
        webView.evaluateJavaScript(source, in: frame?.info, in: .page) { result in
            guard !answered else { return }
            answered = true
            switch result {
            case .success(let value):
                completion(value)
            case .failure(let error):
                self.log.detail("evaluate failed: \(error.localizedDescription)")
                completion(nil)
            }
        }
    }

    // The sample of subframes a phase evaluates in, and the wall clock the whole phase
    // gets. metrics.frames grows with every iframe that ever said hello, including frames
    // from navigations that are long gone, and each evaluation can cost up to 10 s: an
    // ad-heavy page could otherwise spend the entire run budget here and finish with dom
    // and overlays null. Both caps are recorded on the phase.
    static let maxFramesPerPhase = 64
    static let maxOverlays = 10
    private static let framePhaseBudgetMs = 45_000

    /// Runs the same source in every frame probe.js has reported from (up to the cap), so
    /// cross-origin ad iframes are counted and attributed rather than silently missed.
    private func evaluateInAllFrames(
        _ source: String, completion: @escaping ([(ProbeFrame?, Any?)]) -> Void
    ) {
        var frames: [ProbeFrame?] = [nil]
        // Newest first by arrival order, and only frames WebKit still hands back as
        // subframes: a stale WKFrameInfo answers nothing and costs a full evaluation
        // timeout to discover.
        let live = metrics.frames.values
            .filter { !$0.isMainFrame && !$0.info.isMainFrame }
            .sorted { $0.seq > $1.seq }
        var cappedFrames = false
        for frame in live {
            guard frames.count < ScenarioRunner.maxFramesPerPhase else {
                cappedFrames = true
                break
            }
            frames.append(frame)
        }
        if cappedFrames {
            metrics.framesTruncated = true
            log.detail("frame phase capped at \(ScenarioRunner.maxFramesPerPhase) frames")
        }

        var results: [(ProbeFrame?, Any?)] = []
        var done = false
        let deadline = Date().addingTimeInterval(
            TimeInterval(ScenarioRunner.framePhaseBudgetMs) / 1000.0
        )
        func step(_ index: Int) {
            guard !done else { return }
            guard index < frames.count, Date() < deadline else {
                if index < frames.count {
                    self.log.warn("frame phase hit its wall with \(frames.count - index) frames left")
                    self.record.timeouts.append(("frames", ScenarioRunner.framePhaseBudgetMs))
                }
                done = true
                completion(results)
                return
            }
            evaluate(source, in: frames[index]) { value in
                results.append((frames[index], value))
                step(index + 1)
            }
        }
        step(0)
    }

    static func jsonText(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8)
        else {
            // An array of strings is not a top-level JSON object for
            // JSONSerialization's purposes on older systems; wrapping keeps one code
            // path and never interpolates unescaped text into a script.
            if let array = value as? [String],
               let data = try? JSONSerialization.data(withJSONObject: ["v": array]),
               let text = String(data: data, encoding: .utf8) {
                return "(\(text)).v"
            }
            return "null"
        }
        return text
    }

    // MARK: - Finishing

    private func fail(_ failure: ProbeFailure) {
        log.error("\(failure.code): \(failure.message)")
        finish(status: failure.exit.statusName, exit: failure.exit)
    }

    private func finish(status: String, exit code: ProbeExit) {
        guard !finished else { return }
        finished = true
        fixtures.stop()
        if !arguments.keepStore { paths.removeStore() }

        record.status = status
        record.exitCode = code.rawValue
        record.endedAt = Date()
        record.durationMs = clock.ms()
        if case .null = record.host {
            record.host = HostInfo.current(
                viewport: container.bounds.size, scale: UIScreen.main.scale, userAgent: nil
            ).json(simulator: true)
        }
        log.line("run finished: status \(status), exit \(code.rawValue), blocked \(metrics.blockedTotal)")
        completion?(code)
    }
}
