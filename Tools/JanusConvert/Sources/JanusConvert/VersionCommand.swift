// SPDX-License-Identifier: GPL-3.0-or-later
//
// VersionCommand.swift - PIPELINE.md section 12, `JanusConvert version`.
//
// Prints the tool, library and schema versions as JSON on stdout. CI records this in
// the run's inspection artifacts and pack copies `engineSchemaVersion` into the
// manifest, so the app can tell whether the prebuilt engine payload is readable by
// the SafariConverterLib it links (CONTRACT.md section 9.3).

import ArgumentParser
import ContentBlockerConverter
import Foundation

struct VersionCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "version",
        abstract: "Print tool, SafariConverterLib and schema versions as JSON."
    )

    mutating func run() throws {
        let flavours: [[String: Any]] = Flavour.allCases.map { flavour in
            var entry: [String: Any] = [
                "flavour": flavour.rawValue,
                "safariVersion": flavour.safariVersionValue,
            ]
            // The resolved case is reported through the library's own description so a
            // future change in its version table cannot pass unnoticed.
            if let resolved = try? flavour.resolvedSafariVersion() {
                entry["resolved"] = resolved.debugDescription
                entry["resolvedValue"] = resolved.doubleValue
                entry["rulesLimit"] = resolved.rulesLimit
            }
            return entry
        }

        let summary: [String: Any] = [
            "tool": ToolInfo.name,
            "toolVersion": ToolInfo.version,
            "safariConverterLib": ToolInfo.safariConverterLib,
            "scriptlets": ToolInfo.scriptlets,
            "extendedCss": ToolInfo.extendedCSS,
            "engineSchemaVersion": ToolInfo.engineSchemaVersion,
            "flavours": flavours,
        ]

        try IO.printJSON(summary)
    }
}
