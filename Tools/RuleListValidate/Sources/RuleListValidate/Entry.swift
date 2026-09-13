// SPDX-License-Identifier: GPL-3.0-or-later
//
// Entry.swift - PIPELINE.md section 13, the RuleListValidate driver.
//
// For each bucket, in sorted id order: read the JSON off the main thread, hash it,
// then hop to the main thread and compile it with WKContentRuleListStore, one at a
// time, measuring wall time. `compileMs` on the runner is not a phone number and is
// never presented as one; it is a regression signal and a cost hint for the app's
// compile queue.

import Dispatch
import Foundation

@main
enum RuleListValidateMain {
    static func main() {
        do {
            guard let options = try Options.parse(Array(CommandLine.arguments.dropFirst())) else {
                exit(JanusExit.ok.rawValue)
            }
            if options.selfTest {
                exit(try Validator(options: options).selfTest().rawValue)
            }
            if !options.verifyLzfse.isEmpty {
                exit(try Validator(options: options).verifyExternalLzfse().rawValue)
            }
            let outcome = try Validator(options: options).run()
            exit(outcome.rawValue)
        } catch let error as JanusError {
            var fields = error.fields
            fields["message"] = error.message
            Log.error(error.event, fields)
            FileHandle.standardError.write(Data(("error: " + error.message + "\n").utf8))
            exit(error.exit.rawValue)
        } catch {
            let message = String(describing: error)
            Log.error("internal-error", ["message": message])
            FileHandle.standardError.write(Data(("error: " + message + "\n").utf8))
            exit(JanusExit.internalError.rawValue)
        }
    }
}

final class Validator {
    private let options: Options
    /// 0 ok, 1 budget or policy violation, 2 integrity failure.
    private var severity = 0

    init(options: Options) {
        self.options = options
    }

    /// Compiles one trivial list through exactly the code path the convert loop
    /// uses. Driving WKContentRuleListStore from an unbundled command-line tool by
    /// pumping the main run loop is the one dependency that cannot be checked on a
    /// machine without WebKit, so CI proves it works before the loop starts rather
    /// than 45 minutes later.
    func selfTest() throws -> JanusExit {
        precondition(Thread.isMainThread, "RuleListValidate must run on the main thread")
        let storeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("janus-rulelistvalidate-selftest", isDirectory: true)
        let compiler = try RuleListCompiler(storeDirectory: storeURL)
        defer { compiler.destroyStore() }
        let encoded = #"[{"trigger":{"url-filter":"^https://selftest-example/"},"action":{"type":"block"}}]"#
        let outcome = compiler.compile(identifier: "janus.selftest", encoded: encoded, timeoutMs: 60_000)
        try IO.printJSON([
            "tool": ToolInfo.name,
            "selfTest": outcome.succeeded,
            "compileMs": outcome.milliseconds,
            "message": outcome.failureMessage ?? "",
        ] as [String: Any])
        guard outcome.succeeded else {
            throw JanusError.internalFailure(
                "self-test-failed",
                "WKContentRuleListStore could not compile a one-rule list: "
                    + (outcome.failureMessage ?? "unknown failure")
            )
        }
        Log.info("self-test-ok", ["compileMs": outcome.milliseconds])
        return .ok
    }

    /// Decodes payloads this tool did not compress - the engine tar, the advanced
    /// texts and the aux JSON, all encoded by `compression_tool` on the same runner -
    /// through `NSData.decompressed(using: .lzfse)`, which is the exact API the
    /// device calls. Round-tripping a stream through the encoder that produced it
    /// cannot catch a container mismatch; this can.
    func verifyExternalLzfse() throws -> JanusExit {
        var checked: [[String: Any]] = []
        for pair in options.verifyLzfse {
            let label = URL(fileURLWithPath: pair.compressed).lastPathComponent
            let original: Data
            let compressed: Data
            do {
                original = try Data(contentsOf: URL(fileURLWithPath: pair.source))
                compressed = try Data(contentsOf: URL(fileURLWithPath: pair.compressed))
            } catch {
                throw JanusError.usage(
                    "verify-lzfse-unreadable",
                    "could not read " + pair.source + " / " + pair.compressed + ": "
                        + error.localizedDescription
                )
            }
            try Lzfse.verifyRoundTrip(compressed: compressed, original: original, label: label)
            checked.append([
                "file": label,
                "bytes": original.count,
                "compressedBytes": compressed.count,
                "sha256": Hash.sha256Hex(original),
            ] as [String: Any])
            Log.info("lzfse-verified", ["file": label, "bytes": original.count])
        }
        try IO.printJSON([
            "tool": ToolInfo.name,
            "verifyLzfse": checked.count,
            "payloads": checked,
        ] as [String: Any])
        return .ok
    }

    func run() throws -> JanusExit {
        precondition(Thread.isMainThread, "RuleListValidate must run on the main thread")

        let directory = URL(fileURLWithPath: options.dir, isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else {
            throw JanusError.usage("dir-missing", "--dir is not a directory: " + options.dir)
        }

        let bucketIds = try discoverBuckets(in: directory)
        guard !bucketIds.isEmpty else {
            throw JanusError.usage("no-buckets", "--dir contains no <bucketId>.json files: " + options.dir)
        }

        let storeURL = options.store.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.temporaryDirectory
                .appendingPathComponent("janus-rulelistvalidate-" + options.flavour, isDirectory: true)
        let compiler = try RuleListCompiler(storeDirectory: storeURL)
        defer { compiler.destroyStore() }

        let droppedPath = URL(fileURLWithPath: options.out)
            .deletingLastPathComponent()
            .appendingPathComponent("dropped-bisect.jsonl")
            .path
        let droppedLog = IO.LineWriter(path: droppedPath)

        Log.info("start", [
            "flavour": options.flavour,
            "dir": options.dir,
            "bucketCount": bucketIds.count,
            "softCap": options.softCap,
            "hardCap": options.hardCap,
            "compileBudgetMs": options.compileBudgetMs,
            "bisect": options.bisect,
        ])

        var records: [[String: Any]] = []
        var totalRules = 0
        var totalBytes = 0
        var totalCompileMs = 0
        var totalCompressedBytes = 0
        var totalDropped = 0
        var warnings = 0
        var errors = 0

        for bucketId in bucketIds {
            let record = try validate(
                bucketId: bucketId,
                in: directory,
                compiler: compiler,
                droppedLog: droppedLog
            )
            records.append(record.json)
            totalRules += record.ruleCount
            totalBytes += record.bytes
            totalCompileMs += record.compileMs
            totalCompressedBytes += record.compressedBytes
            totalDropped += record.droppedRules
            if record.warning != nil { warnings += 1 }
            if record.failed { errors += 1 }
        }

        let status: String
        switch severity {
        case 0: status = "ok"
        case 1: status = "budget"
        default: status = "failed"
        }

        let report: [String: Any] = [
            "tool": ToolInfo.name,
            "toolVersion": ToolInfo.version,
            "flavour": options.flavour,
            "dir": options.dir,
            "store": storeURL.lastPathComponent,
            "softCap": options.softCap,
            "hardCap": options.hardCap,
            "compileBudgetMs": options.compileBudgetMs,
            "bisect": options.bisect,
            "maxBisect": options.maxBisect,
            "compressed": options.compress != nil,
            "bucketCount": records.count,
            "status": status,
            "totals": [
                "ruleCount": totalRules,
                "bytes": totalBytes,
                "compileMs": totalCompileMs,
                "compressedBytes": totalCompressedBytes,
                "droppedRules": totalDropped,
                "warnings": warnings,
                "errors": errors,
            ],
            "buckets": records,
        ]

        try IO.writeJSON(report, to: options.out)
        try droppedLog.flush()

        Log.info("done", [
            "flavour": options.flavour,
            "status": status,
            "bucketCount": records.count,
            "ruleCount": totalRules,
            "compileMs": totalCompileMs,
            "droppedRules": totalDropped,
            "errors": errors,
        ])

        try IO.printJSON([
            "tool": ToolInfo.name,
            "flavour": options.flavour,
            "status": status,
            "bucketCount": records.count,
            "ruleCount": totalRules,
            "bytes": totalBytes,
            "compileMs": totalCompileMs,
            "compressedBytes": totalCompressedBytes,
            "droppedRules": totalDropped,
            "warnings": warnings,
            "errors": errors,
            "report": URL(fileURLWithPath: options.out).lastPathComponent,
        ] as [String: Any])

        switch severity {
        case 0: return .ok
        case 1: return .policy
        default: return .integrity
        }
    }

    // MARK: - One bucket

    private struct BucketRecord {
        var json: [String: Any]
        var ruleCount: Int
        var bytes: Int
        var compileMs: Int
        var compressedBytes: Int
        var droppedRules: Int
        var warning: String?
        var failed: Bool
    }

    private func validate(
        bucketId: String,
        in directory: URL,
        compiler: RuleListCompiler,
        droppedLog: IO.LineWriter
    ) throws -> BucketRecord {
        let fileURL = directory.appendingPathComponent(bucketId + ".json", isDirectory: false)

        // Read and hash off the main thread; only the compile itself belongs there.
        var (data, sha256) = try Validator.readAndHash(fileURL, bucketId: bucketId)
        var elements = try RuleListJSON.parse(data, bucketId: bucketId)
        var ruleCount = elements.count

        var record: [String: Any] = [
            "bucketId": bucketId,
            "file": fileURL.lastPathComponent,
        ]
        var warning: String?
        var failed = false
        var rewritten = false
        var droppedCount = 0

        if ruleCount > options.hardCap {
            escalate(1)
            record["hardCapExceeded"] = true
            Log.error("hard-cap-exceeded", [
                "bucketId": bucketId, "ruleCount": ruleCount, "hardCap": options.hardCap,
            ])
        } else if ruleCount > options.softCap {
            warning = "ruleCount " + String(ruleCount) + " is above the soft cap " + String(options.softCap)
            Log.warn("soft-cap-exceeded", [
                "bucketId": bucketId, "ruleCount": ruleCount, "softCap": options.softCap,
            ])
        }

        let timeoutMs = max(options.compileBudgetMs * 5, 300_000)
        guard var encoded = String(data: data, encoding: .utf8) else {
            throw JanusError.integrity(
                "bucket-not-utf8",
                "bucket " + bucketId + " is not valid UTF-8",
                ["bucketId": bucketId]
            )
        }

        var outcome = compiler.compile(identifier: bucketId, encoded: encoded, timeoutMs: timeoutMs)
        var compileMs = outcome.milliseconds

        if !outcome.succeeded {
            Log.error("compile-failed", [
                "bucketId": bucketId,
                "ruleCount": ruleCount,
                "compileMs": compileMs,
                "domain": outcome.errorDomain ?? "",
                "code": outcome.errorCode ?? 0,
                "message": outcome.failureMessage ?? "",
            ])

            if options.bisect {
                // Isolating one rule in a bucket of n needs about 2*log2(n)
                // compiles; a flat budget would give up after a handful of
                // halvings and drop a whole surviving range instead.
                let neededAttempts = 2 * Int(log2(Double(max(elements.count, 2))).rounded(.up)) + 4
                let bisector = Bisector(
                    compiler: compiler,
                    bucketId: bucketId,
                    timeoutMs: timeoutMs,
                    maxAttempts: max(options.maxBisect, neededAttempts)
                )
                let bisect = try bisector.locate(
                    in: elements,
                    firstMessage: outcome.failureMessage ?? "unknown compile failure"
                )

                var bisectReport: [String: Any] = [
                    "attempts": bisect.attempts,
                    "droppedRules": bisect.dropped.count,
                    "budgetExhausted": bisect.budgetExhausted,
                    "sizeFailure": bisect.sizeFailure,
                    "precise": bisect.dropped.allSatisfy({ $0.precise }),
                ]

                if bisect.sizeFailure {
                    // Every half compiles on its own: this is JSONTooManyRules, a
                    // bucketing budget problem that dropping rules would only hide.
                    escalate(1)
                    failed = true
                    bisectReport["action"] = "none"
                    record["bisect"] = bisectReport
                    record["error"] = outcome.reportFields
                    record["ruleCount"] = ruleCount
                    record["bytes"] = data.count
                    record["sha256"] = sha256
                    record["compileMs"] = compileMs
                    record["rewritten"] = false
                    if let warning { record["warning"] = warning }
                    return BucketRecord(
                        json: record,
                        ruleCount: ruleCount,
                        bytes: data.count,
                        compileMs: compileMs,
                        compressedBytes: 0,
                        droppedRules: 0,
                        warning: warning,
                        failed: true
                    )
                }

                let droppedIndices = Set(bisect.dropped.map { $0.index })
                for dropped in bisect.dropped.sorted(by: { $0.index < $1.index }) {
                    try droppedLog.append([
                        "flavour": options.flavour,
                        "bucketId": bucketId,
                        "index": dropped.index,
                        "precise": dropped.precise,
                        "message": dropped.message,
                        "rule": dropped.element,
                    ] as [String: Any])
                }
                droppedCount = droppedIndices.count

                elements = elements.enumerated()
                    .filter { !droppedIndices.contains($0.offset) }
                    .map { $0.element }
                ruleCount = elements.count
                guard ruleCount > 0 else {
                    escalate(2)
                    throw JanusError.integrity(
                        "bucket-emptied-by-bisect",
                        "every rule in bucket " + bucketId + " was dropped by the bisector",
                        ["bucketId": bucketId, "droppedRules": droppedCount]
                    )
                }

                // Rewrite the bucket, then compile the rewritten bytes.
                data = try RuleListJSON.encodeData(elements)
                sha256 = Hash.sha256Hex(data)
                try IO.writeAtomic(data, to: fileURL.path)
                rewritten = true
                guard let reencoded = String(data: data, encoding: .utf8) else {
                    throw JanusError.internalFailure(
                        "rewrite-not-utf8",
                        "the rewritten bucket " + bucketId + " was not valid UTF-8"
                    )
                }
                encoded = reencoded

                outcome = compiler.compile(identifier: bucketId, encoded: encoded, timeoutMs: timeoutMs)
                compileMs = outcome.milliseconds
                bisectReport["action"] = "dropped-and-rewritten"
                bisectReport["recompiled"] = outcome.succeeded
                record["bisect"] = bisectReport

                // PIPELINE 18: janus.active is all-or-nothing. Silently shipping it
                // without a surrogate redirect or a folded unbreak exception is
                // worse than not shipping at all.
                if bucketId == Validator.activeBucketId {
                    escalate(2)
                    failed = true
                    record["error"] = [
                        "domain": "JanusValidate",
                        "code": -2,
                        "message": "the bisector dropped " + String(droppedCount)
                            + " rule(s) from " + bucketId
                            + "; surrogates are all-or-nothing (PIPELINE 18)",
                    ] as [String: Any]
                    Log.error("active-bucket-bisected", [
                        "bucketId": bucketId, "droppedRules": droppedCount,
                    ])
                }
                // An imprecise drop removes a whole surviving range, not one bad
                // rule: hundreds of live rules would vanish with no record of why.
                if !bisect.dropped.allSatisfy({ $0.precise }) {
                    escalate(2)
                    failed = true
                    record["error"] = [
                        "domain": "JanusValidate",
                        "code": -3,
                        "message": "the bisector ran out of budget and dropped "
                            + String(droppedCount) + " rule(s) from " + bucketId + " as a block",
                    ] as [String: Any]
                    Log.error("bisect-imprecise", [
                        "bucketId": bucketId,
                        "droppedRules": droppedCount,
                        "attempts": bisect.attempts,
                    ])
                }

                Log.info("bisect-complete", [
                    "bucketId": bucketId,
                    "attempts": bisect.attempts,
                    "droppedRules": droppedCount,
                    "budgetExhausted": bisect.budgetExhausted,
                    "recompiled": outcome.succeeded,
                    "ruleCount": ruleCount,
                ])
            }
        }

        if outcome.succeeded {
            // `failed` may already be set by the bisect guards above; their error
            // record survives a successful recompile of the rewritten bucket.
            if !failed { record["error"] = NSNull() }
        } else {
            escalate(2)
            failed = true
            record["error"] = outcome.reportFields
        }

        if compileMs > options.compileBudgetMs {
            // DESIGN 3.4 treats runner compileMs as a regression signal and a cost
            // hint, never a release gate: a slow hosted runner is not bad data.
            // --compile-budget-fatal makes it fatal for a deliberate investigation;
            // CI does not pass it.
            record["compileBudgetExceeded"] = true
            if options.compileBudgetFatal {
                escalate(1)
                Log.error("compile-budget-exceeded", [
                    "bucketId": bucketId, "compileMs": compileMs, "compileBudgetMs": options.compileBudgetMs,
                ])
            } else {
                Log.warn("compile-budget-exceeded", [
                    "bucketId": bucketId, "compileMs": compileMs, "compileBudgetMs": options.compileBudgetMs,
                ])
            }
        }

        var compressedBytes = 0
        if let compressDirectory = options.compress, !failed {
            let fileName = bucketId + "." + options.flavour + ".json.lzfse"
            let target = URL(fileURLWithPath: compressDirectory, isDirectory: true)
                .appendingPathComponent(fileName, isDirectory: false)
            let compressed = try Lzfse.compress(data, label: fileName)
            try IO.writeAtomic(compressed, to: target.path)
            compressedBytes = compressed.count
            record["compressed"] = [
                "file": fileName,
                "size": compressed.count,
                "sha256": Hash.sha256Hex(compressed),
            ] as [String: Any]
            Log.info("compressed", [
                "bucketId": bucketId,
                "bytes": data.count,
                "compressedBytes": compressed.count,
            ])
        }

        record["ruleCount"] = ruleCount
        record["bytes"] = data.count
        record["sha256"] = sha256
        record["compileMs"] = compileMs
        record["rewritten"] = rewritten
        if let warning { record["warning"] = warning }
        if record["bisect"] == nil { record["bisect"] = NSNull() }

        Log.info("bucket", [
            "bucketId": bucketId,
            "ruleCount": ruleCount,
            "bytes": data.count,
            "compileMs": compileMs,
            "failed": failed,
        ])

        return BucketRecord(
            json: record,
            ruleCount: ruleCount,
            bytes: data.count,
            compileMs: compileMs,
            compressedBytes: compressedBytes,
            droppedRules: droppedCount,
            warning: warning,
            failed: failed
        )
    }

    // MARK: - Helpers

    /// The one bucket whose content is all-or-nothing (PIPELINE 18).
    static let activeBucketId = "janus.active"

    private func escalate(_ level: Int) {
        if level > severity { severity = level }
    }

    /// `<bucketId>.json`, excluding the `<bucketId>.conv.json` stats files the
    /// converter writes beside them.
    private func discoverBuckets(in directory: URL) throws -> [String] {
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        } catch {
            throw JanusError.usage(
                "dir-unreadable",
                "--dir could not be listed: " + error.localizedDescription
            )
        }
        var ids: [String] = []
        for name in names {
            guard !name.hasPrefix("."), name.hasSuffix(".json"), !name.hasSuffix(".conv.json") else { continue }
            ids.append(String(name.dropLast(".json".count)))
        }
        return ids.sorted(by: Validator.utf16Less)
    }

    /// Sorting is by UTF-16 code unit with an explicit comparator on the raw string,
    /// never by locale collation (PIPELINE.md section 3).
    static func utf16Less(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.utf16)
        let right = Array(rhs.utf16)
        for index in 0..<min(left.count, right.count) where left[index] != right[index] {
            return left[index] < right[index]
        }
        return left.count < right.count
    }

    private final class ReadBox {
        var data: Data?
        var sha256: String?
        var failure: Error?
    }

    /// Reads and hashes on a background queue: the main thread is reserved for the
    /// compile calls.
    private static func readAndHash(_ url: URL, bucketId: String) throws -> (Data, String) {
        let box = ReadBox()
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let data = try Data(contentsOf: url)
                box.data = data
                box.sha256 = Hash.sha256Hex(data)
            } catch {
                box.failure = error
            }
            semaphore.signal()
        }
        semaphore.wait()
        if let failure = box.failure {
            throw JanusError.usage(
                "bucket-unreadable",
                "bucket " + bucketId + " could not be read: " + failure.localizedDescription,
                ["bucketId": bucketId]
            )
        }
        guard let data = box.data, let sha256 = box.sha256 else {
            throw JanusError.internalFailure(
                "bucket-read-incomplete",
                "reading bucket " + bucketId + " produced no data"
            )
        }
        return (data, sha256)
    }
}
