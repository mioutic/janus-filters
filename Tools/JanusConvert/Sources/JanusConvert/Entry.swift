// SPDX-License-Identifier: GPL-3.0-or-later
//
// Entry.swift - the JanusConvert root command and the process entry point.
//
// The entry point is hand-written rather than ArgumentParser's own `main()` so the
// process exit codes are exactly the ones PIPELINE.md section 3 defines for every
// tool in this repository (in particular: a usage error is 2, not ArgumentParser's
// default 64).

import ArgumentParser
import Foundation

struct JanusConvertCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "JanusConvert",
        abstract: "Convert Janus filter buckets into WKContentRuleList JSON with SafariConverterLib.",
        version: ToolInfo.version,
        subcommands: [ConvertCommand.self, EngineCommand.self, VersionCommand.self]
    )
}

@main
enum JanusConvertMain {
    static func main() {
        do {
            var command = try JanusConvertCommand.parseAsRoot()
            try command.run()
            exit(JanusExit.ok.rawValue)
        } catch {
            exit(exitCode(for: error))
        }
    }

    /// Maps every error to this pipeline's exit codes and reports it once.
    static func exitCode(for error: Error) -> Int32 {
        if let janus = error as? JanusError {
            var fields = janus.fields
            fields["message"] = janus.message
            Log.error(stage: "janusconvert", event: janus.event, fields)
            return janus.exit.rawValue
        }

        let parserCode = JanusConvertCommand.exitCode(for: error)
        let message = JanusConvertCommand.fullMessage(for: error)

        // `--help` and `--version` arrive here as a clean exit carrying their text.
        if parserCode == ExitCode.success {
            if !message.isEmpty {
                FileHandle.standardOutput.write(Data((message + "\n").utf8))
            }
            return JanusExit.ok.rawValue
        }

        if !message.isEmpty {
            FileHandle.standardError.write(Data((message + "\n").utf8))
        }
        if parserCode.rawValue == ExitCode.validationFailure.rawValue {
            Log.error(stage: "janusconvert", event: "usage-error", ["message": message])
            return JanusExit.usage.rawValue
        }
        Log.error(stage: "janusconvert", event: "internal-error", ["message": message])
        return JanusExit.internalError.rawValue
    }
}
