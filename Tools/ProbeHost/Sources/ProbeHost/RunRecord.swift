// SPDX-License-Identifier: GPL-3.0-or-later
//
// RunRecord.swift - the run.json schema of docs/probehost/01-probehost.md section 5.
//
// Two decisions shape this file.
//
// First, the JSON is built as an ordered value tree and serialised here rather than by
// JSONEncoder. `null` means "not measured" and `0` means "measured, and it was zero",
// and that distinction is load-bearing all the way to the summary - an encoder that
// silently omits a nil optional would turn "we could not see this" into "this did not
// happen". Key order is fixed for the same reason a diff of two runs should be
// readable.
//
// Second, every number that enters this file comes from a mechanism named in section 4.
// `blocked.total` is the count of rule-list SPI callbacks and is never derived from the
// request list; `requests` is the cross-check and says so; a capped array always has its
// truncation flag beside it.

import Foundation
import UIKit
import WebKit

// MARK: - JSON

indirect enum JSONValue {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([(String, JSONValue)])

    static func stringOrNull(_ value: String?) -> JSONValue {
        value.map { .string($0) } ?? .null
    }

    static func intOrNull(_ value: Int?) -> JSONValue {
        value.map { .int($0) } ?? .null
    }

    static func boolOrNull(_ value: Bool?) -> JSONValue {
        value.map { .bool($0) } ?? .null
    }

    static func counts(_ dictionary: [String: Int]) -> JSONValue {
        .object(dictionary.sorted { $0.key < $1.key }.map { ($0.key, .int($0.value)) })
    }

    /// Converts a value that came back from `evaluateJavaScript`. Dictionary keys are
    /// sorted so two runs of the same page produce comparable files.
    static func from(_ value: Any?) -> JSONValue {
        guard let value = value, !(value is NSNull) else { return .null }
        if let number = value as? NSNumber {
            if CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() {
                return .bool(number.boolValue)
            }
            let double = number.doubleValue
            if double == double.rounded(), abs(double) < 9_007_199_254_740_992 {
                return .int(number.intValue)
            }
            return .double(double)
        }
        if let text = value as? String { return .string(text) }
        if let array = value as? [Any] { return .array(array.map { JSONValue.from($0) }) }
        if let dictionary = value as? [String: Any] {
            return .object(dictionary.sorted { $0.key < $1.key }.map { ($0.key, JSONValue.from($0.value)) })
        }
        return .string(String(describing: value))
    }

    func serialized(indent: Int = 0) -> String {
        let pad = String(repeating: " ", count: indent)
        let inner = String(repeating: " ", count: indent + 2)
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .int(let value): return String(value)
        case .double(let value):
            if value.isNaN || value.isInfinite { return "null" }
            return String(format: "%.4f", value)
        case .string(let value): return JSONValue.escape(value)
        case .array(let items):
            if items.isEmpty { return "[]" }
            let body = items.map { inner + $0.serialized(indent: indent + 2) }
                .joined(separator: ",\n")
            return "[\n" + body + "\n" + pad + "]"
        case .object(let pairs):
            if pairs.isEmpty { return "{}" }
            let body = pairs.map { inner + JSONValue.escape($0.0) + ": " + $0.1.serialized(indent: indent + 2) }
                .joined(separator: ",\n")
            return "{\n" + body + "\n" + pad + "}"
        }
    }

    func data() -> Data {
        Data((serialized() + "\n").utf8)
    }

    private static func escape(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7F {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

// MARK: - Host

struct HostInfo {
    var osVersion: String
    var osMajor: Int
    var model: String
    var deviceName: String
    var locale: String
    var timeZone: String
    var appVersion: String
    var appBuild: String
    var width: Int
    var height: Int
    var scale: Int
    var userAgent: String?

    static func current(viewport: CGSize, scale: CGFloat, userAgent: String?) -> HostInfo {
        let device = UIDevice.current
        let version = device.systemVersion
        let major = Int(version.split(separator: ".").first.map(String.init) ?? "") ?? 0
        let info = Bundle.main.infoDictionary ?? [:]
        return HostInfo(
            osVersion: version,
            osMajor: major,
            model: HostInfo.machine(),
            deviceName: device.name,
            locale: Locale.current.identifier,
            timeZone: TimeZone.current.identifier,
            appVersion: info["CFBundleShortVersionString"] as? String ?? "0",
            appBuild: info["CFBundleVersion"] as? String ?? "0",
            width: Int(viewport.width.rounded()),
            height: Int(viewport.height.rounded()),
            scale: Int(scale.rounded()),
            userAgent: userAgent
        )
    }

    /// In the simulator `utsname.machine` is the host architecture, so the simulated
    /// model comes from the environment variable the simulator sets; the fallback keeps
    /// the field honest rather than inventing a model name.
    static func machine() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated
        }
        var system = utsname()
        uname(&system)
        let raw = withUnsafeBytes(of: &system.machine) { pointer -> String in
            let bytes = pointer.bindMemory(to: CChar.self)
            return String(cString: bytes.baseAddress!)
        }
        return raw
    }

    static var appBuildNumber: Int {
        Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1") ?? 1
    }

    func json(simulator: Bool) -> JSONValue {
        .object([
            ("osVersion", .string(osVersion)),
            ("osMajor", .int(osMajor)),
            ("model", .string(model)),
            ("deviceName", .string(deviceName)),
            ("simulator", .bool(simulator)),
            ("locale", .string(locale)),
            ("timeZone", .string(timeZone)),
            ("appVersion", .string(appVersion)),
            ("appBuild", .string(appBuild)),
            ("viewport", .object([
                ("width", .int(width)), ("height", .int(height)), ("scale", .int(scale)),
            ])),
            ("userAgent", JSONValue.stringOrNull(userAgent)),
        ])
    }
}

// MARK: - The record

final class RunRecord {
    let schemaVersion = 1

    // run
    var runId: String
    var suite: String
    var scenarioId: String?
    var mode: String?
    var repeatIndex: Int?
    var order: [String]?
    var startedAt: Date
    var endedAt: Date?
    var durationMs: Int?

    /// Whether this WebKit still declares the rule-list action callback, taken with
    /// `responds(to:)` on the delegate once the web view exists. It is an availability
    /// fact and is true in mode `none` too; whether anything fired is `spi.fired`.
    var spiSelectorPresent = false

    // Blocks the runners fill in as they go. `.null` is the honest starting value for
    // every one of them: a run that dies before a phase must not report a zero for it.
    var host: JSONValue = .null
    var bundle: JSONValue = .null
    var contract: JSONValue = .null
    var compile: JSONValue = .null
    var pageState: JSONValue = .null
    var dom: JSONValue = .null
    var overlays: JSONValue = .null
    /// seen / kept / truncated for the overlay sample, plus the elapsed time it
    /// was taken at. The array is capped; this is what says so.
    var overlaysSummary: JSONValue = .null
    var tap: JSONValue = .null
    var scroll: JSONValue = .null
    var screenshots: [JSONValue] = []
    var fixture: JSONValue = .null
    var expect: JSONValue = .null

    var metrics: ProbeMetrics?
    var requestedUrl: String?

    // harness
    var status = "ok"
    var exitCode: Int32 = 0
    var timeouts: [(String, Int)] = []
    var extraWarnings: [String] = []
    var fixturePort: Int?

    init(runId: String, suite: String, startedAt: Date) {
        self.runId = runId
        self.suite = suite
        self.startedAt = startedAt
    }

    func build(log: Log) -> JSONValue {
        var root: [(String, JSONValue)] = []
        root.append(("schemaVersion", .int(schemaVersion)))

        root.append(("run", .object([
            ("id", .string(runId)),
            ("suite", .string(suite)),
            ("scenarioId", JSONValue.stringOrNull(scenarioId)),
            ("mode", JSONValue.stringOrNull(mode)),
            ("repeat", JSONValue.intOrNull(repeatIndex)),
            ("order", order.map { JSONValue.array($0.map { JSONValue.string($0) }) } ?? .null),
            ("startedAt", .string(ProbeClock.rfc3339(startedAt))),
            ("endedAt", endedAt.map { JSONValue.string(ProbeClock.rfc3339($0)) } ?? .null),
            ("durationMs", JSONValue.intOrNull(durationMs)),
        ])))

        root.append(("host", host))
        root.append(("bundle", bundle))
        root.append(("contract", contract))
        root.append(("compile", compile))

        if let metrics = metrics {
            root.append(("navigation", navigationBlock(metrics)))
        } else {
            root.append(("navigation", .null))
        }
        root.append(("pageState", pageState))
        root.append(("requests", metrics.map { requestsBlock($0) } ?? .null))
        root.append(("blocked", metrics.map { blockedBlock($0) } ?? .null))
        root.append(("dom", dom))
        root.append(("overlays", overlays))
        root.append(("overlaysSummary", overlaysSummary))
        root.append(("popups", metrics.map { popupsBlock($0) } ?? .null))
        root.append(("dialogs", metrics.map { dialogsBlock($0) } ?? .null))
        root.append(("dialogsTruncated", metrics.map { JSONValue.bool($0.dialogsTruncated) } ?? .null))
        root.append(("console", metrics.map { consoleBlock($0) } ?? .null))
        root.append(("consoleTruncated", metrics.map { JSONValue.bool($0.consoleTruncated) } ?? .null))
        root.append(("consoleErrors", metrics.map { JSONValue.int($0.consoleErrors) } ?? .null))
        root.append(("tap", tap))
        root.append(("scroll", scroll))
        root.append(("screenshots", .array(screenshots)))
        root.append(("fixture", fixture))
        root.append(("expect", expect))
        root.append(("timing", metrics.map { timingBlock($0) } ?? .null))

        var warnings = log.warnings + extraWarnings
        if let metrics = metrics {
            // Mode `none` must produce exactly zero blocked actions. A non-zero count
            // there is a harness bug, not a measurement, and it is raised as such.
            if mode == "none", metrics.blockedTotal > 0 {
                warnings.append("mode none recorded \(metrics.blockedTotal) blocked actions")
            }
            if !metrics.spiMissingProperties.isEmpty {
                warnings.append(
                    "rule-list action properties absent: "
                        + metrics.spiMissingProperties.sorted().joined(separator: ",")
                )
            }
        }

        root.append(("harness", .object([
            ("status", .string(status)),
            ("exitCode", .int(Int(exitCode))),
            ("timeouts", .array(timeouts.map {
                .object([("phase", .string($0.0)), ("budgetMs", .int($0.1))])
            })),
            ("warnings", .array(warnings.map { .string($0) })),
            ("errors", .array(log.errors.map { .string($0) })),
            ("probeScriptFrames", metrics.map { JSONValue.int($0.frames.count) } ?? .null),
            ("fixturePort", JSONValue.intOrNull(fixturePort)),
        ])))

        return .object(root)
    }

    // MARK: Blocks derived from the metrics

    private func navigationBlock(_ metrics: ProbeMetrics) -> JSONValue {
        var idleMs: JSONValue = .null
        if let loadMs = metrics.loadMs, metrics.lastRequestMs > 0 {
            idleMs = .int(max(0, metrics.lastRequestMs - metrics.navigationStartMs - loadMs))
        }
        return .object([
            ("requestedUrl", JSONValue.stringOrNull(requestedUrl)),
            ("finalUrl", JSONValue.stringOrNull(metrics.finalUrl)),
            ("didFinish", .bool(metrics.didFinish)),
            ("commitMs", JSONValue.intOrNull(metrics.commitMs)),
            ("loadMs", JSONValue.intOrNull(metrics.loadMs)),
            ("idleMs", idleMs),
            // `attempts`, not `commits`: this list comes from the policy callback, which
            // fires before anything is committed. `committed` is set from didCommit, so a
            // cancelled or replaced navigation cannot inflate the cross-site and
            // suspectedRedirect evidence M4's popunder work builds on.
            ("attempts", .array(metrics.attempts.map { attempt in
                .object([
                    ("url", .string(attempt.url)),
                    ("ms", .int(attempt.ms)),
                    ("navigationType", .string(attempt.navigationType)),
                    ("crossSite", .bool(attempt.crossSite)),
                    ("suspectedRedirect", .bool(attempt.suspectedRedirect)),
                    ("committed", .bool(attempt.committed)),
                ])
            })),
            ("attemptsCommitted", .int(metrics.attempts.filter { $0.committed }.count)),
            ("serverRedirects", .array(metrics.serverRedirects.map { .string($0) })),
            ("activePatternsSet", .int(metrics.activePatternsSet)),
            ("activePatternsAvailable", JSONValue.boolOrNull(metrics.activePatternsAvailable)),
            ("webContentTerminated", .bool(metrics.webContentTerminated)),
            ("failure", metrics.failure.map { failure -> JSONValue in
                .object([
                    ("code", .int(failure.code)),
                    ("domain", .string(failure.domain)),
                    ("ms", .int(failure.ms)),
                ])
            } ?? .null),
        ])
    }

    private func requestsBlock(_ metrics: ProbeMetrics) -> JSONValue {
        var byType: [String: Int] = [:]
        var hosts: [String: Int] = [:]
        var thirdParty: Set<String> = []
        let requestedDomain = ProbeURL.registrableDomain(ProbeURL.host(requestedUrl ?? ""))
        for entry in metrics.requests {
            byType[entry.type, default: 0] += 1
            if let host = ProbeURL.host(entry.url) {
                hosts[host, default: 0] += 1
                if let domain = ProbeURL.registrableDomain(host), domain != requestedDomain {
                    thirdParty.insert(host)
                }
            }
        }
        return .object([
            ("observed", .int(metrics.requestsSeen)),
            ("truncated", .bool(metrics.requestsTruncated)),
            ("transferBytesLowerBound", .int(metrics.transferBytes)),
            ("byType", JSONValue.counts(byType)),
            ("frames", .int(metrics.frames.count)),
            ("framesTruncatedInCountPhase", .bool(metrics.framesTruncated)),
            ("thirdPartyHosts", .int(thirdParty.count)),
            ("hosts", JSONValue.counts(hosts)),
            ("entries", .array(metrics.requests.map { entry in
                .object([
                    ("u", .string(entry.url)),
                    ("t", .string(entry.type)),
                    ("b", .int(entry.bytes)),
                    ("d", .int(entry.durationMs)),
                    ("f", .string(entry.frameOrigin)),
                    ("m", .bool(entry.isMainFrame)),
                ])
            })),
        ])
    }

    private func blockedBlock(_ metrics: ProbeMetrics) -> JSONValue {
        // The family is the bucket id prefix of the rule-list identifier (CONTRACT 8.5):
        // `janus.net.ads.00.3f0a1c2d` is family `net.ads`. Nothing else is inferred from
        // the identifier, and an identifier that does not parse is counted as `other`
        // rather than dropped.
        var byFamily: [String: Int] = [:]
        for action in metrics.blocked {
            byFamily[RunRecord.family(ofIdentifier: action.identifier), default: 0] += 1
        }
        var notifications: [String] = []
        for action in metrics.blocked where !action.notifications.isEmpty {
            notifications.append(contentsOf: action.notifications)
        }
        let notifySample = Array(Set(notifications)).sorted().prefix(20)
        return .object([
            // `total` counts rule-list *actions*, not requests: WebKit calls the delegate
            // once per matching list per load, and the bundle is ~59 overlapping shards,
            // so one blocked URL can arrive several times. `distinctUrls` is the count a
            // reader means by "requests blocked"; the report headline uses that one.
            ("total", .int(metrics.blockedTotal)),
            ("distinctUrls", .int(metrics.blockedDistinctUrls)),
            ("distinctUrlsAnyAction", .int(metrics.blockedDistinctUrlsAnyAction)),
            ("spi", .object([
                // Two different facts, and conflating them made a healthy run read as
                // "the private SPI is unavailable": `selectorPresent` is whether this
                // WebKit still declares the callback, `fired` is whether anything matched
                // in this run (always false in mode none, and on a page that blocked
                // nothing).
                ("selectorPresent", .bool(spiSelectorPresent)),
                ("fired", .bool(metrics.spiFired)),
                ("selector", .string("_webView:contentRuleListWithIdentifier:performedAction:forURL:")),
                ("missingProperties", .array(
                    metrics.spiMissingProperties.sorted().map { .string($0) }
                )),
                // WebKit notifies this delegate for network-level results only
                // (blockedLoad, madeHTTPS, blockedCookies, redirected, modifiedHeaders,
                // notify). `css-display-none` produces no callback at all, so byFamily
                // can never contain cos.generic or cos.specific and `total` is a lower
                // bound on what the rule lists did. The cosmetic families' only
                // measurement is dom.uniqueVisible.
                ("coversCosmetic", .bool(false)),
                ("coversNetworkOnly", .bool(true)),
            ])),
            ("notifications", .object([
                ("actions", .int(metrics.blocked.filter { !$0.notifications.isEmpty }.count)),
                ("distinct", .int(Set(notifications).count)),
                ("sample", .array(notifySample.map { JSONValue.string($0) })),
            ])),
            ("byAction", JSONValue.counts(metrics.blockedByAction())),
            ("byFamily", JSONValue.counts(byFamily)),
            ("byList", JSONValue.counts(metrics.blockedCounts { $0.identifier })),
            ("byHost", JSONValue.counts(metrics.blockedCounts { $0.host })),
            ("byDomain", JSONValue.counts(metrics.blockedCounts { $0.registrableDomain })),
            ("families", .object([
                ("measuredHere", .array(
                    ["net.ads", "net.privacy", "net.other", "active"].map { JSONValue.string($0) }
                )),
                ("notMeasurableHere", .array(
                    ["cos.generic", "cos.specific"].map { JSONValue.string($0) }
                )),
                ("note", .string("css-display-none fires no rule-list action; see dom.uniqueVisible")),
            ])),
            ("unexpected", .bool(mode == "none" && metrics.blockedTotal > 0)),
        ])
    }

    static func family(ofIdentifier identifier: String) -> String {
        let parts = identifier.split(separator: ".").map(String.init)
        guard parts.count >= 3, parts[0] == "janus" else { return "other" }
        if parts[1] == "active" { return "active" }
        guard parts.count >= 4 else { return "other" }
        return "\(parts[1]).\(parts[2])"
    }

    private func popupsBlock(_ metrics: ProbeMetrics) -> JSONValue {
        .object([
            ("native", .array(metrics.nativePopups.map { popup in
                .object([
                    ("url", .string(popup.url)),
                    ("sourceOrigin", .string(popup.sourceOrigin)),
                    ("ms", .int(popup.ms)),
                    ("features", .string(popup.features)),
                ])
            })),
            ("js", .array(metrics.scriptPopups.map { popup in
                .object([
                    ("url", .string(popup.url)),
                    ("ms", .int(popup.ms)),
                    ("userActivation", JSONValue.boolOrNull(popup.userActivation)),
                ])
            })),
            ("nativeCount", .int(metrics.nativePopups.count)),
            ("jsCount", .int(metrics.scriptPopups.count)),
        ])
    }

    private func dialogsBlock(_ metrics: ProbeMetrics) -> JSONValue {
        .array(metrics.dialogs.map { dialog in
            .object([
                ("kind", .string(dialog.kind)),
                ("message", .string(dialog.message)),
                ("origin", .string(dialog.origin)),
                ("ms", .int(dialog.ms)),
            ])
        })
    }

    private func consoleBlock(_ metrics: ProbeMetrics) -> JSONValue {
        .array(metrics.console.map { entry in
            .object([
                ("level", .string(entry.level)),
                ("text", .string(entry.text)),
                ("origin", .string(entry.origin)),
                ("ms", .int(entry.ms)),
            ])
        })
    }

    private func timingBlock(_ metrics: ProbeMetrics) -> JSONValue {
        .object([
            ("pageLoadTimingSpi", metrics.pageLoadTiming.map { JSONValue.counts($0) } ?? .null),
            ("navigationStartMs", .int(metrics.navigationStartMs)),
            ("firstCommitMs", JSONValue.intOrNull(metrics.commitMs)),
            ("didFinishMs", JSONValue.intOrNull(metrics.loadMs)),
        ])
    }

    // MARK: Blocks the runner hands in

    static func contractBlock(_ verifier: ContractVerifier) -> JSONValue {
        .object([
            ("ok", .bool(verifier.ok)),
            ("steps", .array(verifier.steps.map { step in
                .object([
                    ("step", .int(step.step)),
                    ("name", .string(step.name)),
                    ("ok", .bool(step.ok)),
                    ("ms", .int(step.ms)),
                    ("detail", JSONValue.stringOrNull(step.detail)),
                ])
            })),
            ("failedStep", JSONValue.intOrNull(verifier.failedStep)),
            ("failureReason", JSONValue.stringOrNull(verifier.failureReason)),
        ])
    }

    static func bundleBlock(
        manifest: Manifest,
        manifestSha256: String,
        origin: BundleOrigin,
        flavour: String,
        flavourAuto: Bool,
        ageHours: Int?
    ) -> JSONValue {
        .object([
            ("source", .string(origin.source)),
            ("origin", .string(origin.origin)),
            ("manifestUrl", JSONValue.stringOrNull(origin.manifestUrl)),
            ("contractVersion", .int(manifest.contractVersion)),
            ("schemaVersion", .int(manifest.schemaVersion)),
            ("layoutVersion", .int(manifest.layoutVersion)),
            ("version", .int(Int(manifest.version))),
            ("issuedAt", .string(manifest.issuedAt)),
            ("ageHours", JSONValue.intOrNull(ageHours)),
            ("keyId", .string(manifest.keyId)),
            ("flavour", .string(flavour)),
            ("flavourAuto", .bool(flavourAuto)),
            ("generator", .object([
                ("pipeline", JSONValue.stringOrNull(manifest.generator.pipeline)),
                ("safariConverterLib", JSONValue.stringOrNull(manifest.generator.safariConverterLib)),
                ("scriptlets", JSONValue.stringOrNull(manifest.generator.scriptlets)),
                ("extendedCss", JSONValue.stringOrNull(manifest.generator.extendedCss)),
            ])),
            ("manifestSha256", .string(manifestSha256)),
            ("killSwitches", .object(
                manifest.killSwitches.sorted { $0.key < $1.key }.map { ($0.key, .bool($0.value)) }
            )),
        ])
    }

    static func compileBlock(
        buckets: [CompiledBucket],
        attached: Int,
        totalMs: Int,
        storeFresh: Bool,
        activePatterns: (list: String, count: Int, scope: String)?
    ) -> JSONValue {
        .object([
            ("storeFresh", .bool(storeFresh)),
            ("attached", .int(attached)),
            ("failed", .int(buckets.filter { !$0.ok }.count)),
            // In mode `none` the payloads are still downloaded, hash-checked and
            // decompressed - the contract evidence - but nothing is handed to WebKit,
            // so totalMs is download and verify time and compileMs is null per bucket.
            ("compiledLists", .int(buckets.filter { $0.compiled }.count)),
            ("compileSkipped", .int(buckets.filter { !$0.compiled }.count)),
            ("totalMs", .int(totalMs)),
            ("buckets", .array(buckets.map { bucket in
                .object([
                    ("id", .string(bucket.id)),
                    ("family", .string(bucket.family)),
                    ("identifier", .string(bucket.identifier)),
                    ("ruleCount", JSONValue.intOrNull(bucket.ruleCount)),
                    ("size", JSONValue.intOrNull(bucket.size)),
                    ("downloadSize", JSONValue.intOrNull(bucket.downloadSize)),
                    ("downloadMs", JSONValue.intOrNull(bucket.downloadMs)),
                    ("decompressMs", JSONValue.intOrNull(bucket.decompressMs)),
                    ("compileMs", JSONValue.intOrNull(bucket.compileMs)),
                    ("ok", .bool(bucket.ok)),
                    ("error", JSONValue.stringOrNull(bucket.error)),
                    ("attached", .bool(bucket.attached)),
                    ("synthetic", .bool(bucket.synthetic)),
                    ("compiled", .bool(bucket.compiled)),
                ])
            })),
            ("activePatterns", activePatterns.map { patterns -> JSONValue in
                .object([
                    ("list", .string(patterns.list)),
                    ("patternCount", .int(patterns.count)),
                    ("scope", .string(patterns.scope)),
                ])
            } ?? .null),
        ])
    }

    static func screenshotEntry(name: String, file: String, ms: Int, size: CGSize, bytes: Int)
        -> JSONValue
    {
        .object([
            ("name", .string(name)),
            ("file", .string(file)),
            ("ms", .int(ms)),
            ("width", .int(Int(size.width.rounded()))),
            ("height", .int(Int(size.height.rounded()))),
            ("bytes", .int(bytes)),
        ])
    }
}
