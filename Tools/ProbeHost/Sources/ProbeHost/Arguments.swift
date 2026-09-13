// SPDX-License-Identifier: GPL-3.0-or-later
//
// Arguments.swift - the launch contract of docs/probehost/01-probehost.md section 2.
//
// ProbeHost is launched by `xcrun simctl launch` with `-ProbeXxx value` pairs, which
// Foundation exposes through NSArgumentDomain (UserDefaults.standard). Values are read
// from there; the raw argv is scanned as well, because an unknown `-Probe*` key has to
// be a usage error (exit 64) rather than a silent default. A typo in the runner that
// quietly produced a default run would be a measurement that says something other than
// what the operator asked for, and that is the one failure a measurement harness may
// not have.

import Foundation

/// Exit codes, section 2.3. A non-zero code always means "ProbeHost could not take a
/// measurement" and never "the filters performed badly".
enum ProbeExit: Int32 {
    case ok = 0
    case usage = 64
    case bundle = 65
    case internalError = 70
    case cantCreate = 73
    case tempFail = 75

    /// The `harness.status` string that accompanies this code in run.json.
    var statusName: String {
        switch self {
        case .ok: return "ok"
        case .usage: return "usage"
        case .bundle: return "bundle"
        case .internalError: return "internal"
        case .cantCreate: return "cantcreate"
        case .tempFail: return "network"
        }
    }
}

/// Every failure inside ProbeHost carries the exit code it implies, a stable short code
/// for machine reading, and a human message. Nothing throws a bare error: the runner's
/// retry policy (02-runner.md section 7) is keyed on the code.
struct ProbeFailure: Error {
    let exit: ProbeExit
    let code: String
    let message: String

    init(_ exit: ProbeExit, _ code: String, _ message: String) {
        self.exit = exit
        self.code = code
        self.message = message
    }

    var localizedDescription: String { "\(code): \(message)" }
}

enum ProbeSuite: String {
    case scenario
    case spike
}

enum ProbeMode: String {
    case blocked
    case none
}

enum ProbeFlavour: String {
    case ios17
    case ios26
    case auto
}

/// The parsed, validated launch arguments.
struct Arguments {
    var suite: ProbeSuite
    var runId: String
    var mode: ProbeMode
    var scenarioPath: String
    var outPath: String
    var manifestUrl: URL?
    var bundleDir: String?
    var flavour: ProbeFlavour
    var families: Set<String>?          // nil means "every family"
    var optInLists: [String]
    var stepTimeoutMs: Int
    var budgetMs: Int
    var maxRequests: Int
    var maxConsole: Int
    var screenshots: Bool
    var keepStore: Bool
    var fixturePort: UInt16
    var verbose: Bool

    /// The argument line as given, for run.log. Only `-Probe*` tokens, so nothing the
    /// launcher's environment added can leak into an artifact.
    var echo: [String]

    static let defaultManifestUrl =
        "https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json"

    /// CONTRACT section 4.4. `active` is always compiled and attached, whatever
    /// `-ProbeFamilies` says, because janus.active is not optional (CONTRACT 8.2).
    static let knownFamilies: Set<String> = [
        "net.ads", "net.privacy", "net.security", "cos.generic", "cos.specific", "active",
    ]

    static let knownKeys: Set<String> = [
        "ProbeSuite", "ProbeRunId", "ProbeMode", "ProbeScenario", "ProbeOut",
        "ProbeManifestUrl", "ProbeBundleDir", "ProbeFlavour", "ProbeFamilies",
        "ProbeOptInLists", "ProbeStepTimeoutMs", "ProbeBudgetMs", "ProbeMaxRequests",
        "ProbeMaxConsole", "ProbeScreenshots", "ProbeKeepStore", "ProbeFixturePort",
        "ProbeVerbose",
    ]

    // MARK: - Parsing

    static func parse(
        argv: [String] = ProcessInfo.processInfo.arguments,
        defaults: UserDefaults = .standard
    ) throws -> Arguments {
        var echo: [String] = []
        var seen: Set<String> = []

        // Scan argv for the key tokens themselves. UserDefaults has already turned
        // `-Key value` into a value, but it will not tell us about a key we never asked
        // for, and an unknown key is the whole point of this pass.
        var index = 1
        while index < argv.count {
            let token = argv[index]
            if token.hasPrefix("-Probe") {
                let key = String(token.dropFirst())
                guard knownKeys.contains(key) else {
                    throw ProbeFailure(
                        .usage, "unknown-argument",
                        "unknown launch argument \(token); known keys: "
                            + knownKeys.sorted().map { "-" + $0 }.joined(separator: " ")
                    )
                }
                guard !seen.contains(key) else {
                    throw ProbeFailure(.usage, "duplicate-argument", "\(token) given more than once")
                }
                seen.insert(key)
                echo.append(token)
                if index + 1 < argv.count, !argv[index + 1].hasPrefix("-Probe") {
                    echo.append(argv[index + 1])
                    index += 1
                }
            }
            index += 1
        }

        func string(_ key: String) -> String? {
            guard let raw = defaults.string(forKey: key) else { return nil }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }

        func integer(_ key: String, _ fallback: Int, _ range: ClosedRange<Int>) throws -> Int {
            guard let raw = string(key) else { return fallback }
            guard let value = Int(raw) else {
                throw ProbeFailure(.usage, "bad-integer", "-\(key) is not an integer: \(raw)")
            }
            guard range.contains(value) else {
                throw ProbeFailure(
                    .usage, "out-of-range",
                    "-\(key) must be between \(range.lowerBound) and \(range.upperBound), got \(value)"
                )
            }
            return value
        }

        func flag(_ key: String, _ fallback: Bool) throws -> Bool {
            guard let raw = string(key) else { return fallback }
            switch raw {
            case "0", "false", "NO", "no": return false
            case "1", "true", "YES", "yes": return true
            default:
                throw ProbeFailure(.usage, "bad-flag", "-\(key) must be 0 or 1, got \(raw)")
            }
        }

        // -ProbeSuite, required.
        guard let suiteRaw = string("ProbeSuite") else {
            throw ProbeFailure(.usage, "missing-suite", "-ProbeSuite is required (scenario or spike)")
        }
        guard let suite = ProbeSuite(rawValue: suiteRaw) else {
            throw ProbeFailure(.usage, "bad-suite", "-ProbeSuite must be scenario or spike, got \(suiteRaw)")
        }

        // -ProbeRunId, required, and it names a directory, so it is validated tightly.
        guard let runId = string("ProbeRunId") else {
            throw ProbeFailure(.usage, "missing-run-id", "-ProbeRunId is required")
        }
        guard isValidRunId(runId) else {
            throw ProbeFailure(
                .usage, "bad-run-id",
                "-ProbeRunId must match [A-Za-z0-9._-]{1,64}, got \(runId)"
            )
        }

        let modeRaw = string("ProbeMode") ?? ProbeMode.blocked.rawValue
        guard let mode = ProbeMode(rawValue: modeRaw) else {
            throw ProbeFailure(.usage, "bad-mode", "-ProbeMode must be blocked or none, got \(modeRaw)")
        }

        let flavourRaw = string("ProbeFlavour") ?? ProbeFlavour.auto.rawValue
        guard let flavour = ProbeFlavour(rawValue: flavourRaw) else {
            throw ProbeFailure(
                .usage, "bad-flavour",
                "-ProbeFlavour must be ios17, ios26 or auto, got \(flavourRaw)"
            )
        }

        let scenarioPath = try containerRelative(
            string("ProbeScenario") ?? "probe/in/scenario.json", key: "ProbeScenario"
        )
        let outPath = try containerRelative(
            string("ProbeOut") ?? "probe/out/\(runId)", key: "ProbeOut"
        )
        let bundleDir = try string("ProbeBundleDir").map {
            try containerRelative($0, key: "ProbeBundleDir")
        }

        // Offline and network are mutually exclusive: a run must not be able to claim a
        // disk bundle and then quietly fetch a different one.
        var manifestUrl: URL?
        if let raw = string("ProbeManifestUrl") {
            guard bundleDir == nil else {
                throw ProbeFailure(
                    .usage, "conflicting-source",
                    "-ProbeManifestUrl and -ProbeBundleDir are mutually exclusive"
                )
            }
            guard let url = URL(string: raw), url.scheme?.lowercased() == "https" else {
                throw ProbeFailure(.usage, "bad-manifest-url", "-ProbeManifestUrl must be an https URL")
            }
            manifestUrl = url
        } else if bundleDir == nil {
            manifestUrl = URL(string: defaultManifestUrl)
        }

        var families: Set<String>?
        if let raw = string("ProbeFamilies") {
            var parsed = Set(
                raw.split(separator: ",").map {
                    $0.trimmingCharacters(in: .whitespaces)
                }.filter { !$0.isEmpty }
            )
            for family in parsed where !knownFamilies.contains(family) {
                throw ProbeFailure(
                    .usage, "bad-family",
                    "-ProbeFamilies contains \(family); known families: "
                        + knownFamilies.sorted().joined(separator: ",")
                )
            }
            guard !parsed.isEmpty else {
                throw ProbeFailure(.usage, "empty-families", "-ProbeFamilies was empty")
            }
            parsed.insert("active")
            families = parsed
        }

        let optInLists = (string("ProbeOptInLists") ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        let fixturePortRaw = try integer("ProbeFixturePort", 0, 0...65535)
        guard fixturePortRaw == 0 || fixturePortRaw >= 1024 else {
            throw ProbeFailure(
                .usage, "bad-fixture-port",
                "-ProbeFixturePort must be 0 or 1024-65535, got \(fixturePortRaw)"
            )
        }

        return Arguments(
            suite: suite,
            runId: runId,
            mode: mode,
            scenarioPath: scenarioPath,
            outPath: outPath,
            manifestUrl: manifestUrl,
            bundleDir: bundleDir,
            flavour: flavour,
            families: families,
            optInLists: optInLists,
            stepTimeoutMs: try integer("ProbeStepTimeoutMs", 45_000, 1_000...180_000),
            budgetMs: try integer("ProbeBudgetMs", 240_000, 10_000...900_000),
            maxRequests: try integer("ProbeMaxRequests", 3_000, 100...20_000),
            maxConsole: try integer("ProbeMaxConsole", 200, 0...2_000),
            screenshots: try flag("ProbeScreenshots", true),
            keepStore: try flag("ProbeKeepStore", false),
            fixturePort: UInt16(fixturePortRaw),
            verbose: try flag("ProbeVerbose", false),
            echo: echo
        )
    }

    /// A run id becomes a directory name, so it is restricted to characters that cannot
    /// escape the container or confuse a shell on the runner side.
    static func isValidRunId(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 64 else { return false }
        let allowed = CharacterSet(charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        return value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    /// Paths in the launch contract are relative to the app's data container. An
    /// absolute path or a `..` component is a usage error: the runner writes into the
    /// container it resolved with `simctl get_app_container`, and nothing outside it is
    /// part of the contract.
    private static func containerRelative(_ path: String, key: String) throws -> String {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            throw ProbeFailure(.usage, "empty-path", "-\(key) was empty")
        }
        guard !trimmed.hasPrefix("/") else {
            throw ProbeFailure(.usage, "absolute-path", "-\(key) must be container-relative, got \(trimmed)")
        }
        let components = trimmed.split(separator: "/")
        guard !components.contains("..") else {
            throw ProbeFailure(.usage, "escaping-path", "-\(key) must not contain '..'")
        }
        return components.joined(separator: "/")
    }

    /// Only the flavour that matches the running OS is a safe measurement; CONTRACT 8.1
    /// picks it from the device's major version, never from the build SDK. An explicit
    /// value that contradicts the OS is honoured and reported as a warning, because
    /// measuring the wrong vocabulary on purpose is a legitimate experiment.
    static func resolvedFlavour(_ requested: ProbeFlavour, osMajor: Int) -> (String, Bool) {
        let automatic = osMajor >= 26 ? "ios26" : "ios17"
        switch requested {
        case .auto: return (automatic, true)
        case .ios17: return ("ios17", false)
        case .ios26: return ("ios26", false)
        }
    }
}
