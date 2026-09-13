// SPDX-License-Identifier: GPL-3.0-or-later
//
// ConvertCommand.swift - PIPELINE.md section 12, `JanusConvert convert`.
//
// Converts one bucket of AdGuard-syntax rules into WKContentRuleList JSON for one
// flavour. Every argument of `convertArray` is passed explicitly: the library
// defaults are Safari 13 with advanced blocking off, which would silently produce a
// weak, vocabulary-poor list.

import ArgumentParser
import ContentBlockerConverter
import Dispatch
import Foundation

struct ConvertCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "convert",
        abstract: "Convert one bucket into WKContentRuleList JSON for one flavour."
    )

    @Option(help: "One bucket's rule text, one rule per line (build/buckets/<bucketId>.txt).")
    var input: String

    @Option(help: "Bucket id, e.g. janus.net.ads.03.")
    var bucketId: String

    @Option(help: "Rule-list flavour (ios17|ios26).")
    var flavour: Flavour

    @Option(help: "Where to write the converted Safari JSON.")
    var outJson: String

    @Option(help: "Where to write the ConversionResult counters.")
    var outStats: String

    @Option(help: "Append this bucket's advanced-rules text to this file (bucket-id order).")
    var advanced: String?

    @Option(help: "Cap the Safari JSON at this many bytes; 0 means no limit.")
    var maxJsonBytes: Int = 0

    @Flag(help: "Fail with exit 3 when the converter reports any rule error.")
    var strict = false

    private static let stage = "convert"

    mutating func run() throws {
        let stage = ConvertCommand.stage

        guard maxJsonBytes >= 0 else {
            throw JanusError.usage("bad-max-json-bytes", "--max-json-bytes must not be negative")
        }
        guard !bucketId.isEmpty else {
            throw JanusError.usage("bad-bucket-id", "--bucket-id must not be empty")
        }

        let safariVersion = try flavour.resolvedSafariVersion()
        let sourceText = try IO.readText(at: input, label: "--input")
        let rules = IO.ruleLines(from: sourceText)
        guard !rules.isEmpty else {
            throw JanusError.usage(
                "input-empty",
                "--input contains no rules: " + URL(fileURLWithPath: input).lastPathComponent
            )
        }
        let maxJsonSizeBytes: Int? = maxJsonBytes > 0 ? maxJsonBytes : nil

        Log.info(stage: stage, event: "start", [
            "bucketId": bucketId,
            "flavour": flavour.rawValue,
            "safariVersion": safariVersion.doubleValue,
            "sourceLineCount": rules.count,
            "advancedBlocking": true,
            "maxJsonSizeBytes": maxJsonBytes,
        ])

        let startedAt = DispatchTime.now().uptimeNanoseconds
        let result = ContentBlockerConverter().convertArray(
            rules: rules,
            safariVersion: safariVersion,
            advancedBlocking: true,
            maxJsonSizeBytes: maxJsonSizeBytes,
            progress: nil
        )
        let convertMs = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)

        // Exit 5 when the library's output is not an array of objects. The converter
        // is trusted but never assumed: a malformed payload must not reach the phone.
        let safariJSONData = Data(result.safariRulesJSON.utf8)
        try ConvertCommand.assertArrayOfObjects(safariJSONData, bucketId: bucketId)

        // Written exactly as the library produced them: the manifest SHA-256 is over
        // these bytes, so the pipeline never reformats the JSON.
        try IO.writeAtomic(safariJSONData, to: outJson)

        let advancedText = result.advancedRulesText ?? ""
        var advancedTarget: Any = NSNull()
        if let advancedPath = advanced {
            try IO.appendText(advancedText, to: advancedPath)
            advancedTarget = URL(fileURLWithPath: advancedPath).lastPathComponent
        } else if !advancedText.isEmpty {
            Log.warn(stage: stage, event: "advanced-rules-dropped", [
                "bucketId": bucketId,
                "advancedRulesCount": result.advancedRulesCount,
                "message": "converter produced advanced rules but --advanced was not given",
            ])
        }

        let stats: [String: Any] = [
            "tool": ToolInfo.name,
            "toolVersion": ToolInfo.version,
            "safariConverterLib": ToolInfo.safariConverterLib,
            "bucketId": bucketId,
            "flavour": flavour.rawValue,
            "safariVersion": safariVersion.doubleValue,
            "advancedBlocking": true,
            "strict": strict,
            "maxJsonSizeBytes": maxJsonBytes,
            "sourceLineCount": rules.count,
            "sourceRulesCount": result.sourceRulesCount,
            "sourceSafariCompatibleRulesCount": result.sourceSafariCompatibleRulesCount,
            "safariRulesCount": result.safariRulesCount,
            "advancedRulesCount": result.advancedRulesCount,
            "discardedSafariRules": result.discardedSafariRules,
            "errorsCount": result.errorsCount,
            "safariRulesBytes": safariJSONData.count,
            "advancedRulesBytes": Data(advancedText.utf8).count,
            "outJson": URL(fileURLWithPath: outJson).lastPathComponent,
            "advancedFile": advancedTarget,
        ]
        try IO.writeJSON(stats, to: outStats)

        Log.info(stage: stage, event: "converted", [
            "bucketId": bucketId,
            "flavour": flavour.rawValue,
            "safariRulesCount": result.safariRulesCount,
            "advancedRulesCount": result.advancedRulesCount,
            "discardedSafariRules": result.discardedSafariRules,
            "errorsCount": result.errorsCount,
            "safariRulesBytes": safariJSONData.count,
            "convertMs": convertMs,
        ])

        try IO.printJSON(stats)

        if strict, result.errorsCount > 0 {
            throw JanusError.policy(
                "conversion-errors-in-strict-mode",
                "converter reported " + String(result.errorsCount) + " rule error(s) for bucket " + bucketId,
                ["bucketId": bucketId, "errorsCount": result.errorsCount, "flavour": flavour.rawValue]
            )
        }
    }

    /// The converter must hand back a JSON array whose every element is an object.
    private static func assertArrayOfObjects(_ data: Data, bucketId: String) throws {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            throw JanusError.integrity(
                "output-not-json",
                "converted JSON for " + bucketId + " does not parse: " + error.localizedDescription,
                ["bucketId": bucketId]
            )
        }
        guard let array = parsed as? [Any] else {
            throw JanusError.integrity(
                "output-not-array",
                "converted JSON for " + bucketId + " is not a top-level array",
                ["bucketId": bucketId]
            )
        }
        for (index, element) in array.enumerated() where !(element is [String: Any]) {
            throw JanusError.integrity(
                "output-element-not-object",
                "converted JSON for " + bucketId + " has a non-object element at index " + String(index),
                ["bucketId": bucketId, "index": index]
            )
        }
    }
}
