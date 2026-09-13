// SPDX-License-Identifier: GPL-3.0-or-later
//
// Support.swift - exit codes, logging, deterministic IO and the flavour table
// shared by every JanusConvert subcommand. See PIPELINE.md sections 3 and 12.

import ArgumentParser
import ContentBlockerConverter
import FilterEngine
import Foundation

// MARK: - Tool identity

enum ToolInfo {
    static let name = "JanusConvert"
    /// Bumped by hand; recorded in every stats file so a report can tell which
    /// build produced a number.
    static let version = "1.0.0"
    /// The pinned SafariConverterLib version, read from the library itself rather
    /// than hard-coded, so a bad pin shows up in the output instead of silently.
    static let safariConverterLib = ContentBlockerConverterVersion.library
    static let scriptlets = ContentBlockerConverterVersion.scriptlets
    static let extendedCSS = ContentBlockerConverterVersion.extendedCSS
    /// FilterEngine serialisation schema (1 in SafariConverterLib 4.3.0).
    static let engineSchemaVersion = Schema.VERSION
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

/// An error that carries the process exit code and a machine-readable event name.
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
/// stdout carries only the machine-readable summary of a command.
/// Never logs rule text and never logs anything read from the environment.
enum Log {
    static func emit(stage: String, event: String, level: String, _ fields: [String: Any] = [:]) {
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

    static func info(stage: String, event: String, _ fields: [String: Any] = [:]) {
        emit(stage: stage, event: event, level: "info", fields)
    }

    static func warn(stage: String, event: String, _ fields: [String: Any] = [:]) {
        emit(stage: stage, event: event, level: "warn", fields)
    }

    static func error(stage: String, event: String, _ fields: [String: Any] = [:]) {
        emit(stage: stage, event: event, level: "error", fields)
    }
}

// MARK: - Flavour

/// The two rule-list flavours Janus publishes. PIPELINE.md section 12:
/// `ios17` is handed to the library as 17, which resolves to `.safari16_4` - the
/// newest vocabulary Safari 17 actually understands - and `ios26` as 26.
/// Never pass a value in 11..16.3: it falls into the library default branch and
/// silently becomes Safari 13.
enum Flavour: String, CaseIterable, ExpressibleByArgument {
    case ios17
    case ios26

    var safariVersionValue: Double {
        switch self {
        case .ios17: return 17.0
        case .ios26: return 26.0
        }
    }

    /// Resolved `SafariVersion`. Written through an explicitly Optional binding so
    /// it compiles whether the library declares the initialiser as `init` or `init?`.
    func resolvedSafariVersion() throws -> SafariVersion {
        let resolved: SafariVersion? = SafariVersion(safariVersionValue)
        guard let version = resolved else {
            throw JanusError.usage(
                "safari-version-unresolved",
                "SafariConverterLib rejected Safari version " + String(safariVersionValue)
                    + " for flavour " + rawValue
            )
        }
        return version
    }

    static var valueList: String {
        Flavour.allCases.map { $0.rawValue }.joined(separator: "|")
    }
}

// MARK: - Deterministic IO

enum IO {
    /// Reads a UTF-8 text file. A missing or unreadable input is a usage error (exit 2).
    static func readText(at path: String, label: String) throws -> String {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw JanusError.usage("input-missing", label + " does not exist: " + url.lastPathComponent)
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw JanusError.usage(
                "input-unreadable",
                label + " could not be read: " + url.lastPathComponent + ": " + error.localizedDescription
            )
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw JanusError.integrity("input-not-utf8", label + " is not valid UTF-8: " + url.lastPathComponent)
        }
        return text
    }

    /// One rule per line, LF endings, CR tolerated, blank lines dropped.
    /// Comments are kept: the converter is the authority on what it can use.
    static func ruleLines(from text: String) -> [String] {
        var lines: [String] = []
        lines.reserveCapacity(text.utf8.count / 40 + 1)
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var line = String(rawLine)
            if line.hasSuffix("\r") { line.removeLast() }
            if line.isEmpty { continue }
            lines.append(line)
        }
        return lines
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

    /// Atomic, no timestamps: the SHA-256 in the manifest is over exactly these bytes.
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

    static func writeText(_ text: String, to path: String) throws {
        try writeAtomic(Data(text.utf8), to: path)
    }

    /// Appends text, creating the file when it does not exist yet. This is how one
    /// `advanced.txt` is accumulated for the whole set, in bucket-id order.
    static func appendText(_ text: String, to path: String) throws {
        guard !text.isEmpty else { return }
        try ensureParentDirectory(of: path)
        let url = URL(fileURLWithPath: path)
        let payload = text.hasSuffix("\n") ? text : text + "\n"
        let data = Data(payload.utf8)
        if !FileManager.default.fileExists(atPath: url.path) {
            try writeAtomic(data, to: path)
            return
        }
        do {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            throw JanusError.internalFailure(
                "append-failed",
                "could not append to " + url.lastPathComponent + ": " + error.localizedDescription
            )
        }
    }

    /// Two-space indentation, sorted keys, unescaped slashes, exactly one trailing
    /// newline - the JSON convention of PIPELINE.md section 3.
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

    static func writeJSON(_ object: Any, to path: String) throws {
        let encoded = try prettyJSON(object)
        try writeAtomic(encoded, to: path)
    }

    static func printJSON(_ object: Any) throws {
        let encoded = try prettyJSON(object)
        FileHandle.standardOutput.write(encoded)
    }
}
