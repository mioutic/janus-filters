// SPDX-License-Identifier: GPL-3.0-or-later
//
// Log.swift - os.Logger for a human watching `simctl launch --console-pty`, plus an
// append-only run.log in the run directory for the artifact.
//
// The log is evidence, not decoration: when a scenario times out, the runner copies the
// tail of run.log into the report (02-runner.md section 5.4) and that text is usually
// the only statement of where the run hung. Every line is stamped with milliseconds
// since launch, from a monotonic clock, so the stamps survive a simulator whose wall
// clock the host adjusts mid-run.

import Foundation
import os

/// One monotonic clock per process. `ms()` is what every duration in run.json is
/// measured with; `startedAt`/`endedAt` come from the wall clock and are only ever used
/// for the RFC 3339 stamps a human reads.
final class ProbeClock {
    let startedAt: Date
    private let origin: UInt64

    init() {
        startedAt = Date()
        origin = DispatchTime.now().uptimeNanoseconds
    }

    /// Milliseconds since the process started measuring.
    func ms() -> Int {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now > origin else { return 0 }
        return Int((now - origin) / 1_000_000)
    }

    /// Milliseconds since an earlier reading of `ms()`.
    func since(_ mark: Int) -> Int {
        max(0, ms() - mark)
    }

    static func rfc3339(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        return formatter.string(from: date)
    }

    /// Parses the RFC 3339 stamps the manifest carries (CONTRACT section 1: UTC, second
    /// precision, `Z` suffix). Anything else is rejected by the caller rather than
    /// guessed at.
    static func parseRFC3339(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        return formatter.date(from: value)
    }
}

final class Log {
    private let logger = Logger(subsystem: "io.github.mioutic.probehost", category: "probe")
    private let lock = NSLock()
    private let clock: ProbeClock
    private let verbose: Bool
    private var handle: FileHandle?

    /// Collected for `harness.warnings` and `harness.errors`. A warning is something the
    /// reader of a number must know (the SPI never fired, a bucket did not compile); an
    /// error is something that stopped a phase.
    private(set) var warnings: [String] = []
    private(set) var errors: [String] = []

    init(fileURL: URL?, verbose: Bool, clock: ProbeClock) {
        self.clock = clock
        self.verbose = verbose
        guard let fileURL = fileURL else { return }
        FileManager.default.createFile(atPath: fileURL.path, contents: Data(), attributes: nil)
        handle = try? FileHandle(forWritingTo: fileURL)
    }

    func line(_ message: String) {
        write("info", message)
        logger.log("\(message, privacy: .public)")
    }

    /// Extra detail behind -ProbeVerbose. It never changes what is measured.
    func detail(_ message: @autoclosure () -> String) {
        guard verbose else { return }
        let text = message()
        write("debug", text)
        logger.debug("\(text, privacy: .public)")
    }

    func warn(_ message: String) {
        lock.lock()
        warnings.append(message)
        lock.unlock()
        write("warn", message)
        logger.warning("\(message, privacy: .public)")
    }

    func error(_ message: String) {
        lock.lock()
        errors.append(message)
        lock.unlock()
        write("error", message)
        logger.error("\(message, privacy: .public)")
    }

    func close() {
        lock.lock()
        try? handle?.synchronize()
        try? handle?.close()
        handle = nil
        lock.unlock()
    }

    private func write(_ level: String, _ message: String) {
        let stamp = String(format: "%08d", clock.ms())
        let line = "[\(stamp)ms] \(level) \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        lock.lock()
        if let handle = handle {
            try? handle.write(contentsOf: data)
        }
        lock.unlock()
    }
}
