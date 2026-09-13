// SPDX-License-Identifier: GPL-3.0-or-later
//
// ProbeDelegates.swift - everything WebKit tells the harness (01-probehost.md section 4).
//
// The headline number, "requests blocked", comes from one mechanism and one only: the
// private navigation-delegate callback
// `_webView:contentRuleListWithIdentifier:performedAction:forURL:`, declared here with
// its exact Objective-C selector. Every private property it hands back is read through
// `responds(to:)` plus KVC, so a WebKit release that drops one yields `false` rather
// than a crash - the same discipline the spike applies to every other SPI.
//
// The delegate object is fully constructed before it is assigned to the web view,
// because WebKit caches `respondsToSelector:` at assignment time; a delegate that grows
// a method afterwards is a delegate WebKit will never call.

import Foundation
import UIKit
import WebKit

// MARK: - Small helpers shared by the runners

/// Polls a predicate on the main queue until it holds or the deadline passes. The whole
/// app is a callback machine with no async/await: one primitive, used everywhere, makes
/// every wait in the run look the same in the log.
func probePoll(
    intervalMs: Int = 100,
    timeoutMs: Int,
    until predicate: @escaping () -> Bool,
    completion: @escaping (Bool) -> Void
) {
    let deadline = Date().addingTimeInterval(TimeInterval(timeoutMs) / 1000.0)
    func tick() {
        if predicate() {
            completion(true)
            return
        }
        if Date() >= deadline {
            completion(false)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(intervalMs)) { tick() }
    }
    tick()
}

func probeAfter(ms: Int, _ block: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(0, ms)), execute: block)
}

enum ProbeURL {
    /// Section 5.1: no query strings, ever. Every URL recorded anywhere in run.json is
    /// truncated at the `?`, so a run artifact cannot carry an identifier a site put in
    /// a URL, and nothing downstream reverses that.
    static func strip(_ raw: String) -> String {
        var value = raw
        if let hash = value.firstIndex(of: "#") { value = String(value[..<hash]) }
        if let question = value.firstIndex(of: "?") { value = String(value[..<question]) }
        return value
    }

    static func host(_ raw: String) -> String? {
        URL(string: raw)?.host
    }

    /// An approximation of the registrable domain, used for "cross-site" and
    /// "third-party host" counts. There is no Public Suffix List in this app - shipping
    /// one would be a dependency - so the rule is "last two labels, plus a third for the
    /// handful of two-part suffixes that appear in the scenario list". It is documented
    /// as approximate in docs/PROBEHOST.md and is never used for a blocking decision.
    static let twoPartSuffixes: Set<String> = [
        "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "com.au", "com.br", "co.in",
        "com.mx", "co.nz", "co.za", "com.tr", "com.cn", "github.io",
    ]

    static func registrableDomain(_ host: String?) -> String? {
        guard let host = host?.lowercased(), !host.isEmpty else { return nil }
        // An IP literal is its own registrable domain.
        if host.allSatisfy({ $0.isNumber || $0 == "." }) { return host }
        let labels = host.split(separator: ".").map(String.init)
        guard labels.count > 2 else { return host }
        let lastTwo = labels.suffix(2).joined(separator: ".")
        if twoPartSuffixes.contains(lastTwo) {
            return labels.suffix(3).joined(separator: ".")
        }
        return lastTwo
    }
}

// MARK: - Records

struct RequestEntry {
    var url: String
    var type: String
    var bytes: Int
    var durationMs: Int
    var frameOrigin: String
    var isMainFrame: Bool
}

/// One main-frame navigation the app was asked to allow. It is an *attempt*: the policy
/// callback fires before anything is committed, and a navigation that is cancelled,
/// fails or is replaced still arrives here. `committed` is filled in by didCommit, so
/// the M4 popunder evidence can tell an attempt from a page that actually loaded.
struct NavigationAttempt {
    var url: String
    var ms: Int
    var navigationType: String
    var crossSite: Bool
    var suspectedRedirect: Bool
    var committed: Bool = false
}

struct NativePopup {
    var url: String
    var sourceOrigin: String
    var ms: Int
    var features: String
}

struct ScriptPopup {
    var url: String
    var ms: Int
    var userActivation: Bool?
}

struct DialogEntry {
    var kind: String
    var message: String
    var origin: String
    var ms: Int
}

struct ConsoleEntry {
    var level: String
    var text: String
    var origin: String
    var ms: Int
}

struct BlockedAction {
    var identifier: String
    /// The query-stripped URL the action fired for. Kept because WebKit calls the
    /// delegate once per matching rule list per load, and the bundle is ~59 overlapping
    /// shards: without the URL there is no way to tell "one request blocked by three
    /// lists" from "three requests blocked". blocked.distinctUrls is derived from it.
    var url: String
    var host: String
    var registrableDomain: String
    var flags: [String: Bool]
    /// _WKContentRuleListAction.notifications is an NSArray<NSString *>, not a BOOL.
    /// The strings are whatever a `notify` rule carried; the record truncates them.
    var notifications: [String]
}

/// One frame that has reported in from probe.js. The WKFrameInfo is kept so counts can
/// be taken in that frame with `evaluateJavaScript(_:in:in:)`; the id is generated in
/// the page, because WebKit exposes no stable frame identifier to the app.
final class ProbeFrame {
    let id: String
    var origin: String
    var isMainFrame: Bool
    var info: WKFrameInfo
    /// Arrival order. The id is random (probe.js has no stable frame identifier to give
    /// us), so this is the only way to prefer the frames of the current navigation when
    /// a phase can only afford to evaluate in some of them.
    var seq: Int

    init(id: String, origin: String, isMainFrame: Bool, info: WKFrameInfo, seq: Int) {
        self.id = id
        self.origin = origin
        self.isMainFrame = isMainFrame
        self.info = info
        self.seq = seq
    }
}

// MARK: - Metrics

/// Everything observed during one run. Touched on the main thread only.
final class ProbeMetrics {
    let clock: ProbeClock
    let maxRequests: Int
    let maxConsole: Int

    init(clock: ProbeClock, maxRequests: Int, maxConsole: Int) {
        self.clock = clock
        self.maxRequests = maxRequests
        self.maxConsole = maxConsole
    }

    // Requests, from PerformanceObserver in every frame.
    var requests: [RequestEntry] = []
    var requestsTruncated = false
    var requestsSeen = 0
    var transferBytes = 0
    var lastRequestMs = 0

    // Blocked actions, from the rule-list SPI.
    var blocked: [BlockedAction] = []
    var spiFired = false
    var spiMissingProperties: Set<String> = []

    // Navigation.
    var attempts: [NavigationAttempt] = []
    var serverRedirects: [String] = []
    var didFinish = false
    var commitMs: Int?
    var loadMs: Int?
    var navigationStartMs = 0
    var failure: (code: Int, domain: String, ms: Int)?
    var webContentTerminated = false
    var httpStatus: Int?
    var activePatternsSet = 0
    var activePatternsAvailable: Bool?
    var finalUrl: String?

    // UI.
    var nativePopups: [NativePopup] = []
    var scriptPopups: [ScriptPopup] = []
    var dialogs: [DialogEntry] = []
    var dialogsTruncated = false
    var console: [ConsoleEntry] = []
    var consoleTruncated = false
    var consoleErrors = 0

    // Frames and the tap.
    var frames: [String: ProbeFrame] = [:]
    /// A count phase evaluated only the newest maxFramesPerPhase subframes.
    var framesTruncated = false
    /// Monotonic arrival counter for ProbeFrame.seq.
    var frameSeq = 0
    var tapMs: Int?
    var pageLoadTiming: [String: Int]?

    /// Callbacks, not requests: one blocked URL fires once per matching rule list.
    var blockedTotal: Int { blocked.count }

    /// Distinct query-stripped URLs whose load a rule list actually stopped. This is the
    /// number a reader means by "requests blocked"; blockedTotal is rule-list actions.
    var blockedDistinctUrls: Int {
        var urls: Set<String> = []
        for action in blocked where action.flags["blockedLoad"] == true {
            urls.insert(action.url)
        }
        return urls.count
    }

    /// Distinct URLs across every action kind, blocked or not (madeHTTPS, redirected,
    /// blockedCookies, modifiedHeaders, notify), so the two can be compared.
    var blockedDistinctUrlsAnyAction: Int { Set(blocked.map { $0.url }).count }

    func recordRequest(_ entry: RequestEntry) {
        requestsSeen += 1
        lastRequestMs = clock.ms()
        transferBytes += max(0, entry.bytes)
        guard requests.count < maxRequests else {
            requestsTruncated = true
            return
        }
        requests.append(entry)
    }

    func recordConsole(_ entry: ConsoleEntry) {
        if entry.level == "error" { consoleErrors += 1 }
        guard console.count < maxConsole else {
            consoleTruncated = true
            return
        }
        console.append(entry)
    }

    func recordDialog(_ entry: DialogEntry) {
        guard dialogs.count < 50 else {
            dialogsTruncated = true
            return
        }
        dialogs.append(entry)
    }

    /// Counts by whatever key the caller asks for; the record turns these into
    /// `blocked.byList`, `byHost` and `byFamily`.
    func blockedCounts(_ key: (BlockedAction) -> String) -> [String: Int] {
        var counts: [String: Int] = [:]
        for action in blocked {
            counts[key(action), default: 0] += 1
        }
        return counts
    }

    func blockedByAction() -> [String: Int] {
        var counts: [String: Int] = [
            "blockedLoad": 0, "blockedCookies": 0, "madeHTTPS": 0,
            "redirected": 0, "modifiedHeaders": 0, "notifications": 0,
        ]
        for action in blocked {
            if !action.notifications.isEmpty { counts["notifications", default: 0] += 1 }
            for (key, value) in action.flags where value {
                counts[key, default: 0] += 1
            }
        }
        return counts
    }
}

// MARK: - The delegate

final class ProbeDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let metrics: ProbeMetrics
    let log: Log
    private let clock: ProbeClock

    /// The `_activeContentRuleListActionPatterns` value for this run: the janus.active
    /// rule-list identifier mapped to the pattern set (CONTRACT 8.6). Empty when the
    /// bundle's `surrogates` kill switch is off, when janus.active did not compile, or
    /// in mode `none`.
    var activePatterns: [String: Set<String>] = [:]

    /// Set by the runner once the page has been asked to load, so "ms from the tap" and
    /// `suspectedRedirect` have something to be relative to.
    var requestedRegistrableDomain: String?

    var onDidFinish: (() -> Void)?
    var onDidFail: ((Int, String) -> Void)?
    var onWebContentTerminated: (() -> Void)?

    /// The five BOOL properties. `notifications` is deliberately absent: it is an
    /// NSArray of strings, and reading it as an NSNumber silently yields false forever,
    /// which is how byAction.notifications came to be structurally zero.
    private static let actionFlagKeys = [
        "blockedLoad", "blockedCookies", "madeHTTPS", "redirected", "modifiedHeaders",
    ]

    init(metrics: ProbeMetrics, log: Log, clock: ProbeClock) {
        self.metrics = metrics
        self.log = log
        self.clock = clock
        super.init()
    }

    // MARK: Rule-list SPI - the headline measurement

    @objc(_webView:contentRuleListWithIdentifier:performedAction:forURL:)
    func probe_webView(
        _ webView: WKWebView,
        contentRuleListWithIdentifier identifier: String,
        performedAction action: NSObject,
        forURL url: URL
    ) {
        var flags: [String: Bool] = [:]
        for key in ProbeDelegate.actionFlagKeys {
            // responds(to:) first: `redirected` and `modifiedHeaders` are iOS 16+, and a
            // future WebKit may drop any of them. A missing property is `false`, never a
            // crash and never a guess.
            guard action.responds(to: NSSelectorFromString(key)) else {
                metrics.spiMissingProperties.insert(key)
                continue
            }
            let value = (action.value(forKey: key) as? NSNumber)?.boolValue ?? false
            flags[key] = value
        }
        var notifications: [String] = []
        if action.responds(to: NSSelectorFromString("notifications")) {
            notifications = (action.value(forKey: "notifications") as? [String]) ?? []
        } else {
            metrics.spiMissingProperties.insert("notifications")
        }
        let host = url.host ?? ""
        let stripped = ProbeURL.strip(url.absoluteString)
        metrics.spiFired = true
        metrics.blocked.append(
            BlockedAction(
                identifier: identifier,
                url: stripped,
                host: host,
                registrableDomain: ProbeURL.registrableDomain(host) ?? host,
                flags: flags,
                notifications: notifications
            )
        )
        log.detail("blocked \(identifier) \(stripped)")
    }

    @objc(_webView:didGeneratePageLoadTiming:)
    func probe_webView(_ webView: WKWebView, didGeneratePageLoadTiming timing: NSObject) {
        let keys = [
            "navigationStart", "firstVisualLayout", "firstMeaningfulPaint",
            "documentFinishedLoading", "allSubresourcesFinishedLoading",
        ]
        var dates: [String: Date] = [:]
        for key in keys {
            guard timing.responds(to: NSSelectorFromString(key)) else { continue }
            if let date = timing.value(forKey: key) as? Date { dates[key] = date }
        }
        guard let start = dates["navigationStart"] else {
            if !dates.isEmpty { metrics.pageLoadTiming = [:] }
            return
        }
        var offsets: [String: Int] = ["navigationStart": 0]
        for (key, date) in dates where key != "navigationStart" {
            offsets[key] = Int(date.timeIntervalSince(start) * 1000.0)
        }
        metrics.pageLoadTiming = offsets
    }

    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        applyActivePatterns(to: preferences)

        if navigationAction.targetFrame?.isMainFrame ?? false {
            let url = navigationAction.request.url?.absoluteString ?? ""
            let host = ProbeURL.host(url)
            let crossSite = ProbeURL.registrableDomain(host) != requestedRegistrableDomain
            let type = ProbeDelegate.navigationTypeName(navigationAction.navigationType)
            let now = clock.ms()
            // Section 4.3: a cross-site main-frame navigation that nobody clicked, within
            // 1.5 s of the tap, is evidence for M4's popunder work. It is counted here
            // because it is free, and it is never used as a pass criterion.
            let nearTap = metrics.tapMs.map { now - $0 <= 1500 } ?? false
            let suspect = crossSite && type != "linkActivated" && nearTap
            metrics.attempts.append(
                NavigationAttempt(
                    url: ProbeURL.strip(url), ms: now, navigationType: type,
                    crossSite: crossSite, suspectedRedirect: suspect
                )
            )
        }
        decisionHandler(.allow, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame,
           let http = navigationResponse.response as? HTTPURLResponse {
            metrics.httpStatus = http.statusCode
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if metrics.commitMs == nil { metrics.commitMs = clock.ms() - metrics.navigationStartMs }
        // Mark the attempt this commit belongs to. WebKit hands back no correlation
        // token here, so the rule is "the most recent attempt for this URL, else the
        // most recent attempt at all" - enough to separate a navigation that loaded
        // from one that was only proposed, which is all `committed` claims.
        let url = webView.url.map { ProbeURL.strip($0.absoluteString) }
        if let url = url,
           let index = metrics.attempts.lastIndex(where: { $0.url == url && !$0.committed }) {
            metrics.attempts[index].committed = true
        } else if let index = metrics.attempts.indices.last {
            metrics.attempts[index].committed = true
        }
    }

    func webView(
        _ webView: WKWebView,
        didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!
    ) {
        if let url = webView.url?.absoluteString {
            metrics.serverRedirects.append(ProbeURL.strip(url))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        metrics.didFinish = true
        metrics.loadMs = clock.ms() - metrics.navigationStartMs
        metrics.finalUrl = webView.url.map { ProbeURL.strip($0.absoluteString) }
        onDidFinish?()
    }

    func webView(
        _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
    ) {
        recordFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        recordFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        metrics.webContentTerminated = true
        log.warn("the web content process terminated")
        onWebContentTerminated?()
    }

    private func recordFailure(_ error: Error) {
        let nsError = error as NSError
        // -999 is "cancelled", which every navigation that is replaced by another one
        // reports. Recording it as a failure would turn an ordinary redirect into an
        // error state.
        guard nsError.code != NSURLErrorCancelled else { return }
        metrics.failure = (nsError.code, nsError.domain, clock.ms() - metrics.navigationStartMs)
        // The failing URL and the description are what tell an ATS refusal apart from a
        // real transport failure: WKWebView reports a policy refusal as -1005 ("network
        // connection lost"), the same code a dropped connection gets, and without the
        // description every such gate failure costs another CI round trip.
        let failingURL = nsError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String ?? "-"
        log.warn(
            "navigation failed: \(nsError.domain) \(nsError.code) url=\(failingURL) "
                + "detail=\(nsError.localizedDescription)"
        )
        onDidFail?(nsError.code, nsError.domain)
    }

    /// CONTRACT 8.6 through the setter WebKit actually declares. The property is
    /// `_activeContentRuleListActionPatterns` with the setter
    /// `_setActiveContentRuleListActionPatterns:`, so KVC is given the key *without* the
    /// leading underscore: its search order finds `_set<Key>:` and nothing else in this
    /// object would answer to it. The setter selector is checked first, because an
    /// unanswered KVC key raises an Objective-C exception Swift cannot catch.
    private func applyActivePatterns(to preferences: WKWebpagePreferences) {
        guard !activePatterns.isEmpty else { return }
        let setter = NSSelectorFromString("_setActiveContentRuleListActionPatterns:")
        guard preferences.responds(to: setter) else {
            if metrics.activePatternsAvailable == nil { metrics.activePatternsAvailable = false }
            return
        }
        metrics.activePatternsAvailable = true
        var bridged: [String: NSSet] = [:]
        for (identifier, patterns) in activePatterns {
            bridged[identifier] = NSSet(array: Array(patterns))
        }
        preferences.setValue(bridged, forKey: "activeContentRuleListActionPatterns")
        metrics.activePatternsSet += 1
    }

    static func navigationTypeName(_ type: WKNavigationType) -> String {
        switch type {
        case .linkActivated: return "linkActivated"
        case .formSubmitted: return "formSubmitted"
        case .backForward: return "backForward"
        case .reload: return "reload"
        case .formResubmitted: return "formResubmitted"
        case .other: return "other"
        @unknown default: return "unknown"
        }
    }

    // MARK: WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        let url = navigationAction.request.url?.absoluteString ?? ""
        metrics.nativePopups.append(
            NativePopup(
                url: ProbeURL.strip(url),
                sourceOrigin: ProbeDelegate.originString(navigationAction.sourceFrame.securityOrigin),
                ms: clock.ms(),
                features: ProbeDelegate.featureString(windowFeatures)
            )
        )
        log.line("popup requested: \(ProbeURL.strip(url))")
        // ProbeHost never opens a second web view: a count here means the page asked
        // WebKit for a window and WebKit agreed to ask us.
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        recordDialog(kind: "alert", message: message, frame: frame)
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        recordDialog(kind: "confirm", message: message, frame: frame)
        completionHandler(false)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        recordDialog(kind: "prompt", message: prompt, frame: frame)
        completionHandler(nil)
    }

    private func recordDialog(kind: String, message: String, frame: WKFrameInfo) {
        metrics.recordDialog(
            DialogEntry(
                kind: kind,
                message: String(message.prefix(200)),
                origin: ProbeDelegate.originString(frame.securityOrigin),
                ms: clock.ms()
            )
        )
        // Dismissed immediately with the neutral answer, so a dialog loop cannot stall
        // a run (section 4.5).
    }

    // MARK: WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any], let kind = body["k"] as? String else { return }
        let origin = ProbeDelegate.originString(message.frameInfo.securityOrigin)
        let isMainFrame = message.frameInfo.isMainFrame

        switch kind {
        case "hello":
            guard let fid = body["fid"] as? String else { return }
            metrics.frameSeq += 1
            metrics.frames[fid] = ProbeFrame(
                id: fid, origin: origin, isMainFrame: isMainFrame, info: message.frameInfo,
                seq: metrics.frameSeq
            )
            log.detail("frame \(fid) \(origin)\(isMainFrame ? " (main)" : "")")

        case "res":
            guard let entries = body["e"] as? [[Any]] else { return }
            for entry in entries where entry.count >= 4 {
                let name = entry[0] as? String ?? ""
                let type = entry[1] as? String ?? "other"
                let bytes = (entry[2] as? NSNumber)?.intValue ?? 0
                let duration = (entry[3] as? NSNumber)?.intValue ?? 0
                metrics.recordRequest(
                    RequestEntry(
                        url: ProbeURL.strip(name), type: type.isEmpty ? "other" : type,
                        bytes: bytes, durationMs: duration,
                        frameOrigin: origin, isMainFrame: isMainFrame
                    )
                )
            }

        case "open":
            metrics.scriptPopups.append(
                ScriptPopup(
                    url: ProbeURL.strip(body["u"] as? String ?? ""),
                    ms: clock.ms(),
                    userActivation: (body["act"] as? NSNumber)?.boolValue
                )
            )

        case "console":
            let level = body["level"] as? String ?? "error"
            metrics.recordConsole(
                ConsoleEntry(
                    level: level,
                    text: String((body["text"] as? String ?? "").prefix(300)),
                    origin: origin,
                    ms: clock.ms()
                )
            )

        default:
            break
        }
    }

    // MARK: Formatting

    /// `protocol` is a Swift keyword, so the WKSecurityOrigin property is spelled
    /// with backticks.
    static func originString(_ origin: WKSecurityOrigin) -> String {
        if origin.host.isEmpty { return "null" }
        let port = origin.port == 0 ? "" : ":\(origin.port)"
        return "\(origin.`protocol`)://\(origin.host)\(port)"
    }

    static func featureString(_ features: WKWindowFeatures) -> String {
        var parts: [String] = []
        if let width = features.width { parts.append("width=\(width.intValue)") }
        if let height = features.height { parts.append("height=\(height.intValue)") }
        if let menu = features.menuBarVisibility { parts.append("menubar=\(menu.boolValue ? 1 : 0)") }
        if let toolbar = features.toolbarsVisibility {
            parts.append("toolbar=\(toolbar.boolValue ? 1 : 0)")
        }
        if let resizable = features.allowsResizing { parts.append("resizable=\(resizable.boolValue ? 1 : 0)") }
        return parts.joined(separator: ",")
    }
}
