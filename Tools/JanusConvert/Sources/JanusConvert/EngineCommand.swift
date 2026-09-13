// SPDX-License-Identifier: GPL-3.0-or-later
//
// EngineCommand.swift - PIPELINE.md section 12, `JanusConvert engine`.
//
// Builds the optional prebuilt FilterEngine index from the accumulated
// advanced-rules text. The library writes <out-dir>/.webext/{rules.txt, rules.bin,
// engine.bin, meta.bin} plus a lock file; CONTRACT.md section 9.3 allows only those
// four payload files in the published tar, so the rest is pruned here.

import ArgumentParser
import ContentBlockerConverter
import FilterEngine
import Foundation

struct EngineCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "engine",
        abstract: "Build the prebuilt FilterEngine payload from advanced-rules text."
    )

    @Option(help: "The accumulated advanced-rules text (build/converted/<flavour>/advanced.txt).")
    var input: String

    @Option(help: "Rule-list flavour (ios17|ios26).")
    var flavour: Flavour

    @Option(help: "Container directory; the library writes <out-dir>/.webext/* inside it.")
    var outDir: String

    private static let stage = "engine"

    mutating func run() throws {
        let stage = EngineCommand.stage
        let safariVersion = try flavour.resolvedSafariVersion()

        let text = try IO.readText(at: input, label: "--input")
        let lines = IO.ruleLines(from: text)
        guard !lines.isEmpty else {
            throw JanusError.usage(
                "input-empty",
                "--input contains no advanced rules: " + URL(fileURLWithPath: input).lastPathComponent
            )
        }

        let containerURL = URL(fileURLWithPath: outDir, isDirectory: true)
        try IO.createDirectory(at: containerURL)

        // A stale index must never be able to masquerade as a fresh one.
        let webextURL = containerURL.appendingPathComponent(Schema.BASE_DIR, isDirectory: true)
        if FileManager.default.fileExists(atPath: webextURL.path) {
            do {
                try FileManager.default.removeItem(at: webextURL)
            } catch {
                throw JanusError.internalFailure(
                    "stale-engine-not-removed",
                    "could not remove the previous " + Schema.BASE_DIR + " directory: "
                        + error.localizedDescription
                )
            }
        }

        Log.info(stage: stage, event: "start", [
            "flavour": flavour.rawValue,
            "safariVersion": safariVersion.doubleValue,
            "ruleLineCount": lines.count,
            "engineSchemaVersion": ToolInfo.engineSchemaVersion,
        ])

        let webExtension: WebExtension
        do {
            webExtension = try WebExtension(containerURL: containerURL, version: safariVersion)
        } catch {
            throw JanusError.internalFailure(
                "webextension-init-failed",
                "WebExtension(containerURL:version:) failed: " + error.localizedDescription
            )
        }

        do {
            _ = try webExtension.buildFilterEngine(rules: lines.joined(separator: "\n"))
        } catch {
            throw JanusError.integrity(
                "engine-build-failed",
                "buildFilterEngine(rules:) failed: " + error.localizedDescription,
                ["flavour": flavour.rawValue]
            )
        }

        // The four files CONTRACT.md section 9.3 allows, named from the library's own
        // schema constants rather than spelled out here.
        let payloadNames = [
            Schema.RULES_FILE_NAME,
            Schema.FILTER_RULE_STORAGE_FILE_NAME,
            Schema.FILTER_ENGINE_INDEX_FILE_NAME,
            Schema.ENGINE_META_FILE_NAME,
        ]

        var files: [[String: Any]] = []
        var totalBytes = 0
        for name in payloadNames {
            let fileURL = webextURL.appendingPathComponent(name, isDirectory: false)
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
                  let size = attributes[.size] as? Int, size > 0
            else {
                throw JanusError.integrity(
                    "engine-file-missing",
                    "FilterEngine did not write a usable " + name,
                    ["file": name, "flavour": flavour.rawValue]
                )
            }
            files.append(["name": name, "size": size])
            totalBytes += size
        }

        // Prune everything that is not a payload file (the lock and any migration
        // marker) so the tar pack builds matches CONTRACT.md section 9.3 exactly.
        var pruned: [String] = []
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: webextURL.path)) ?? []
        for name in contents.sorted() where !payloadNames.contains(name) {
            let victim = webextURL.appendingPathComponent(name)
            if (try? FileManager.default.removeItem(at: victim)) != nil {
                pruned.append(name)
            } else {
                Log.warn(stage: stage, event: "prune-failed", ["file": name])
            }
        }

        let summary: [String: Any] = [
            "tool": ToolInfo.name,
            "toolVersion": ToolInfo.version,
            "safariConverterLib": ToolInfo.safariConverterLib,
            "flavour": flavour.rawValue,
            "safariVersion": safariVersion.doubleValue,
            "engineSchemaVersion": ToolInfo.engineSchemaVersion,
            "baseDir": Schema.BASE_DIR,
            "ruleLineCount": lines.count,
            "files": files,
            "totalBytes": totalBytes,
            "pruned": pruned,
        ]

        Log.info(stage: stage, event: "built", [
            "flavour": flavour.rawValue,
            "engineSchemaVersion": ToolInfo.engineSchemaVersion,
            "totalBytes": totalBytes,
            "pruned": pruned,
        ])

        try IO.printJSON(summary)
    }
}
