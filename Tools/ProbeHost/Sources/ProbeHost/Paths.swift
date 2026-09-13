// SPDX-License-Identifier: GPL-3.0-or-later
//
// Paths.swift - the container layout of docs/probehost/01-probehost.md section 2.2.
//
// Everything the runner reads or writes lives under the app's data container, which it
// resolves once with `simctl get_app_container <udid> <bundle id> data`. The record is
// written and closed first, and only then is the zero-byte DONE sentinel created, so
// the runner may treat DONE as "the record is complete and parseable" without a retry
// loop on half-written JSON (00-index.md section 1).

import Foundation

/// The directories and files of one launch.
final class RunPaths {
    let documents: URL
    let probeDir: URL
    let inDir: URL
    let outDir: URL
    let storeDir: URL
    let runId: String
    let recordName: String

    var recordURL: URL { outDir.appendingPathComponent(recordName) }
    var logURL: URL { outDir.appendingPathComponent("run.log") }
    var doneURL: URL { outDir.appendingPathComponent("DONE") }

    /// Creating the output directory is the first thing a run does, because a run that
    /// cannot write its record cannot report anything at all: that is exit 73, and it
    /// is almost always a container-staging bug on the runner side.
    init(runId: String, outPath: String, recordName: String) throws {
        guard let documents = FileManager.default.urls(
            for: .documentDirectory, in: .userDomainMask
        ).first else {
            throw ProbeFailure(.cantCreate, "no-documents", "the Documents directory could not be resolved")
        }
        self.documents = documents
        self.runId = runId
        self.recordName = recordName
        self.probeDir = documents.appendingPathComponent("probe", isDirectory: true)
        self.inDir = probeDir.appendingPathComponent("in", isDirectory: true)
        self.outDir = RunPaths.resolve(outPath, under: documents)
        self.storeDir = probeDir
            .appendingPathComponent("store", isDirectory: true)
            .appendingPathComponent(runId, isDirectory: true)

        do {
            try FileManager.default.createDirectory(
                at: outDir, withIntermediateDirectories: true, attributes: nil
            )
        } catch {
            throw ProbeFailure(
                .cantCreate, "out-dir",
                "could not create \(outPath): \(error.localizedDescription)"
            )
        }
    }

    /// Resolves a container-relative path (already validated by Arguments) against the
    /// Documents directory.
    static func resolve(_ relative: String, under root: URL) -> URL {
        var url = root
        for component in relative.split(separator: "/") {
            url = url.appendingPathComponent(String(component), isDirectory: false)
        }
        return url
    }

    func containerURL(_ relative: String) -> URL {
        RunPaths.resolve(relative, under: documents)
    }

    /// `<runId>-<name>.png`, per section 2.2.
    func screenshotURL(name: String) -> URL {
        outDir.appendingPathComponent("\(runId)-\(name).png")
    }

    func screenshotFileName(name: String) -> String {
        "\(runId)-\(name).png"
    }

    /// Writes the record, flushes it to disk, and only then creates DONE. Any failure
    /// here is exit 73: the measurement may have succeeded, but nobody can read it.
    func writeRecord(_ data: Data) throws {
        do {
            try data.write(to: recordURL, options: [.atomic])
            let handle = try FileHandle(forUpdating: recordURL)
            try handle.synchronize()
            try handle.close()
        } catch let failure as ProbeFailure {
            throw failure
        } catch {
            throw ProbeFailure(
                .cantCreate, "record-write",
                "could not write \(recordName): \(error.localizedDescription)"
            )
        }
    }

    /// The sentinel. Zero bytes, written last, synced before the process exits.
    func writeDone() {
        FileManager.default.createFile(atPath: doneURL.path, contents: Data(), attributes: nil)
        if let handle = try? FileHandle(forUpdating: doneURL) {
            try? handle.synchronize()
            try? handle.close()
        }
    }

    /// A fresh rule-list store per run is the default, so `compile.compileMs` always
    /// measures a cold compile and never a lookup of something an earlier run left
    /// behind (-ProbeKeepStore turns this off deliberately).
    func prepareStore(keepExisting: Bool) throws -> URL {
        if !keepExisting, FileManager.default.fileExists(atPath: storeDir.path) {
            try? FileManager.default.removeItem(at: storeDir)
        }
        do {
            try FileManager.default.createDirectory(
                at: storeDir, withIntermediateDirectories: true, attributes: nil
            )
        } catch {
            throw ProbeFailure(
                .cantCreate, "store-dir",
                "could not create the rule-list store directory: \(error.localizedDescription)"
            )
        }
        return storeDir
    }

    func removeStore() {
        try? FileManager.default.removeItem(at: storeDir)
    }

    static func fileSize(_ url: URL) -> Int? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber
        else { return nil }
        return size.intValue
    }
}
