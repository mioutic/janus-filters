// SPDX-License-Identifier: GPL-3.0-or-later
//
// Support.swift - exit codes, logging, hashing, deterministic IO and the argument
// parser for RuleListValidate. See PIPELINE.md sections 3 and 13.

import CryptoKit
import Foundation

// MARK: - Tool identity

enum ToolInfo {
    static let name = "RuleListValidate"
    static let version = "1.0.0"
}

// MARK: - Exit codes (PIPELINE.md section 3, identical across all tools)

enum JanusExit: Int32 {
    case ok = 0
    case internalError = 1
    case usage = 2
    case policy = 3
    case network = 4
    case integrity = 5
}

struct JanusError: Error, CustomStringConvertible {
    let exit: JanusExit
    let event: String
    let message: String
    var fields: [String: Any] = [:]

    var description: String { message }

    static func usage(_ event: String, _ message: String, _ fields: [String: Any] = [:]) -> JanusError {
        JanusError(exit: .usage, event: event, message: message, fields: fields)
    }

    static func policy(_ event: String, _ message: String, _ fields: [String: Any] = [:]) -> JanusError {
        JanusError(exit: .policy, event: event, message: message, fields: fields)
    }

    static func integrity(_ event: String, _ message: String, _ fields: [String: Any] = [:]) -> JanusError {
        JanusError(exit: .integrity, event: event, message: message, fields: fields)
    }

    static func internalFailure(_ event: String, _ message: String, _ fields: [String: Any] = [:]) -> JanusError {
        JanusError(exit: .internalError, event: event, message: message, fields: fields)
    }
}

// MARK: - Logging

/// One JSON object per line on stderr: {"stage","event","level", ...fields}.
/// stdout carries only the machine-readable summary. Rule text is never logged at
/// info level and nothing read from the environment is ever logged.
enum Log {
    static let stage = "validate"

    static func emit(event: String, level: String, _ fields: [String: Any] = [:]) {
        var object: [String: Any] = fields
        object["stage"] = stage
        object["event"] = event
        object["level"] = level
        var line = "{\"event\":\"" + event + "\",\"level\":\"" + level + "\",\"stage\":\"" + stage + "\"}"
        if let data = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ), let text = String(data: data, encoding: .utf8) {
            line = text
        }
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }

    static func info(_ event: String, _ fields: [String: Any] = [:]) {
        emit(event: event, level: "info", fields)
    }

    static func warn(_ event: String, _ fields: [String: Any] = [:]) {
        emit(event: event, level: "warn", fields)
    }

    static func error(_ event: String, _ fields: [String: Any] = [:]) {
        emit(event: event, level: "error", fields)
    }
}

// MARK: - Hashing

enum Hash {
    static func sha256Hex(_ data: Data) -> String {
        var hex = ""
        hex.reserveCapacity(64)
        for byte in SHA256.hash(data: data) {
            hex += String(format: "%02x", byte)
        }
        return hex
    }
}

// MARK: - Deterministic IO

enum IO {
    static func readData(at path: String, label: String) throws -> Data {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw JanusError.usage("input-missing", label + " does not exist: " + url.lastPathComponent)
        }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw JanusError.usage(
                "input-unreadable",
                label + " could not be read: " + url.lastPathComponent + ": " + error.localizedDescription
            )
        }
    }

    static func createDirectory(at url: URL) throws {
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        } catch {
            throw JanusError.internalFailure(
                "mkdir-failed",
                "could not create directory " + url.lastPathComponent + ": " + error.localizedDescription
            )
        }
    }

    static func ensureParentDirectory(of path: String) throws {
        try createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent())
    }

    static func writeAtomic(_ data: Data, to path: String) throws {
        try ensureParentDirectory(of: path)
        do {
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            throw JanusError.internalFailure(
                "write-failed",
                "could not write " + URL(fileURLWithPath: path).lastPathComponent + ": "
                    + error.localizedDescription
            )
        }
    }

    /// Two-space indentation, sorted keys, unescaped slashes, one trailing newline.
    static func prettyJSON(_ object: Any) throws -> Data {
        do {
            var data = try JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            )
            data.append(0x0A)
            return data
        } catch {
            throw JanusError.internalFailure(
                "json-encode-failed",
                "could not encode JSON: " + error.localizedDescription
            )
        }
    }

    /// One compact JSON object, no trailing newline: a JSON Lines record.
    static func jsonLine(_ object: Any) throws -> Data {
        do {
            return try JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys, .withoutEscapingSlashes]
            )
        } catch {
            throw JanusError.internalFailure(
                "jsonl-encode-failed",
                "could not encode a JSON Lines record: " + error.localizedDescription
            )
        }
    }

    static func writeJSON(_ object: Any, to path: String) throws {
        let encoded = try prettyJSON(object)
        try writeAtomic(encoded, to: path)
    }

    static func printJSON(_ object: Any) throws {
        let encoded = try prettyJSON(object)
        FileHandle.standardOutput.write(encoded)
    }

    /// Collects the JSON Lines records of a run and writes them in one go, so a
    /// partially written log can never be mistaken for a complete one.
    final class LineWriter {
        private let path: String
        private var buffer = Data()
        private(set) var count = 0

        init(path: String) {
            self.path = path
        }

        func append(_ object: Any) throws {
            let encoded = try IO.jsonLine(object)
            buffer.append(encoded)
            buffer.append(0x0A)
            count += 1
        }

        /// Always writes, even with no records: an empty JSON Lines file is an
        /// unambiguous "nothing was dropped", where a missing file is not.
        func flush() throws {
            try IO.writeAtomic(buffer, to: path)
        }
    }
}

// MARK: - Arguments

struct Options {
    var dir: String = ""
    var flavour: String = ""
    var out: String = ""
    var store: String?
    var softCap = 80_000
    var hardCap = 110_000
    var compileBudgetMs = 20_000
    /// Compile time over budget is a warning by default (DESIGN 3.4): a slow
    /// hosted runner must not block a release.
    var compileBudgetFatal = false
    var bisect = false
    /// A floor, not a ceiling: the validator raises it to the depth a bucket of
    /// this size actually needs (Entry.swift).
    var maxBisect = 40
    var compress: String?
    /// Compile one trivial list and exit: proves WKContentRuleListStore works in
    /// this unbundled command-line tool before the convert loop burns 45 minutes.
    var selfTest = false
    /// `source=compressed` pairs to check through the Foundation decoder the device
    /// itself calls, for payloads compressed by something other than this tool.
    var verifyLzfse: [(source: String, compressed: String)] = []

    static let usageText = """
    RuleListValidate - compile every converted bucket with WKContentRuleListStore.

    USAGE:
      RuleListValidate --dir <dir> --flavour <ios17|ios26> --out <report.json> [options]

    OPTIONS:
      --dir <dir>               directory of <bucketId>.json files
      --flavour <ios17|ios26>   the flavour those files were converted for
      --out <file>              where to write report.json
      --store <path>            scratch WKContentRuleListStore directory
      --soft-cap <int>          warn above this rule count (default 80000)
      --hard-cap <int>          fail above this rule count (default 110000)
      --compile-budget-ms <int> warn above this compile time (default 20000)
      --compile-budget-fatal    make that budget a failure instead of a warning
      --bisect                  halve a failing bucket to find the offending rules
      --max-bisect <int>        minimum compile attempts per bisect (default 40)
      --compress <dir>          also write <bucketId>.<flavour>.json.lzfse there
      --self-test               compile one trivial list, print the result, exit
      --verify-lzfse <pairs>    comma-separated source=compressed pairs to decode
                                through NSData.decompressed(using:.lzfse) and exit
      -h, --help                print this text

    EXIT CODES: 0 ok, 1 internal error, 2 usage, 3 budget or policy violation,
    5 integrity failure (a bucket WebKit refuses to compile).
    """

    /// A parsed command line, or `nil` when help was requested and printed.
    static func parse(_ arguments: [String]) throws -> Options? {
        var options = Options()
        var seen = Set<String>()
        var index = 0

        func nextValue(for flag: String) throws -> String {
            index += 1
            guard index < arguments.count else {
                throw JanusError.usage("missing-value", flag + " requires a value")
            }
            return arguments[index]
        }

        func intValue(_ raw: String, _ flag: String) throws -> Int {
            guard let value = Int(raw), value >= 0 else {
                throw JanusError.usage("bad-int", flag + " requires a non-negative integer, got " + raw)
            }
            return value
        }

        while index < arguments.count {
            var argument = arguments[index]
            var inlineValue: String?
            if argument.hasPrefix("--"), let equals = argument.firstIndex(of: "=") {
                inlineValue = String(argument[argument.index(after: equals)...])
                argument = String(argument[argument.startIndex..<equals])
            }

            func value(_ flag: String) throws -> String {
                if let inlineValue { return inlineValue }
                return try nextValue(for: flag)
            }

            switch argument {
            case "-h", "--help":
                FileHandle.standardOutput.write(Data((usageText + "\n").utf8))
                return nil
            case "--dir":
                options.dir = try value(argument)
            case "--flavour":
                options.flavour = try value(argument)
            case "--out":
                options.out = try value(argument)
            case "--store":
                options.store = try value(argument)
            case "--soft-cap":
                options.softCap = try intValue(try value(argument), argument)
            case "--hard-cap":
                options.hardCap = try intValue(try value(argument), argument)
            case "--compile-budget-ms":
                options.compileBudgetMs = try intValue(try value(argument), argument)
            case "--max-bisect":
                options.maxBisect = try intValue(try value(argument), argument)
            case "--compile-budget-fatal":
                if inlineValue != nil {
                    throw JanusError.usage("unexpected-value", "--compile-budget-fatal takes no value")
                }
                options.compileBudgetFatal = true
            case "--self-test":
                if inlineValue != nil {
                    throw JanusError.usage("unexpected-value", "--self-test takes no value")
                }
                options.selfTest = true
            case "--verify-lzfse":
                for pair in try value(argument).split(separator: ",", omittingEmptySubsequences: true) {
                    let halves = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: true)
                    guard halves.count == 2 else {
                        throw JanusError.usage(
                            "bad-pair",
                            "--verify-lzfse takes source=compressed pairs, got " + String(pair)
                        )
                    }
                    options.verifyLzfse.append(
                        (source: String(halves[0]), compressed: String(halves[1]))
                    )
                }
            case "--compress":
                options.compress = try value(argument)
            case "--bisect":
                if inlineValue != nil {
                    throw JanusError.usage("unexpected-value", "--bisect takes no value")
                }
                options.bisect = true
            default:
                throw JanusError.usage("unknown-argument", "unknown argument: " + argument)
            }
            guard seen.insert(argument).inserted else {
                throw JanusError.usage("repeated-argument", "repeated argument: " + argument)
            }
            index += 1
        }

        if options.selfTest || !options.verifyLzfse.isEmpty { return options }
        guard !options.dir.isEmpty else { throw JanusError.usage("missing-dir", "--dir is required") }
        guard !options.out.isEmpty else { throw JanusError.usage("missing-out", "--out is required") }
        guard options.flavour == "ios17" || options.flavour == "ios26" else {
            throw JanusError.usage(
                "bad-flavour",
                "--flavour must be ios17 or ios26, got " + (options.flavour.isEmpty ? "nothing" : options.flavour)
            )
        }
        guard options.hardCap > 0, options.softCap > 0 else {
            throw JanusError.usage("bad-caps", "--soft-cap and --hard-cap must be positive")
        }
        guard options.softCap <= options.hardCap else {
            throw JanusError.usage("bad-caps", "--soft-cap must not exceed --hard-cap")
        }
        guard options.compileBudgetMs > 0 else {
            throw JanusError.usage("bad-budget", "--compile-budget-ms must be positive")
        }
        return options
    }
}
