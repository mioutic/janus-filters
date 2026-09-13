// SPDX-License-Identifier: GPL-3.0-or-later
//
// main.swift - the app, the window scene, and the suite dispatch.
//
// ProbeHost is an instrument: one full-screen WKWebView, no chrome, no address bar, no
// control a human could press. A person who launches it from Simulator.app with the same
// `-Probe*` arguments sees exactly what CI sees, which is what makes a CI failure
// reproducible by hand (00-index.md section 1).
//
// The life cycle is UIScene, not the old UIApplicationDelegate window: an app linked
// against the iOS 26 SDK with no UIApplicationSceneManifest is terminated at launch, and
// a terminated app writes no run.json and no DONE, so the whole suite would report
// nothing. Info.plist declares one scene role whose delegate is ProbeSceneDelegate
// (exported to the Objective-C runtime under that exact name, so the plist needs no
// module prefix); the delegate builds the window and hands its root view to
// ProbeSession, which is where every line of the old begin() now lives. Nothing else in
// the harness is life-cycle aware.
//
// The exit code is mirrored into the record because `simctl launch` reports the launch
// result, not the app's status. The record is written first, closed and synced, and the
// zero-byte DONE sentinel is written last: the runner polls for DONE and may then read
// the record without guarding against a partial file.

import UIKit

/// One monotonic clock for the whole process; every duration in the record is measured
/// against it.
let probeClock = ProbeClock()

/// The run itself: argument parsing, dispatch to a suite, and the single place that
/// writes the record and exits. It is a singleton because the process runs exactly one
/// suite and UIApplicationSupportsMultipleScenes is false; begin() is idempotent so a
/// scene that reconnects cannot start a second run.
final class ProbeSession {
    static let shared = ProbeSession()

    private var log: Log?
    private var paths: RunPaths?
    private var record: RunRecord?
    private var scenarioRunner: ScenarioRunner?
    private var spikeRunner: SpikeRunner?
    private var started = false
    private var exited = false

    private init() {}

    // MARK: - Dispatch

    func begin(container: UIView) {
        guard !started else { return }
        started = true

        let arguments: Arguments
        do {
            arguments = try Arguments.parse()
        } catch let failure as ProbeFailure {
            reportUsageFailure(failure)
            return
        } catch {
            reportUsageFailure(
                ProbeFailure(.usage, "arguments", error.localizedDescription)
            )
            return
        }

        let recordName = arguments.suite == .spike ? "spike.json" : "run.json"
        let paths: RunPaths
        do {
            paths = try RunPaths(
                runId: arguments.runId, outPath: arguments.outPath, recordName: recordName
            )
        } catch let failure as ProbeFailure {
            // Nowhere to write a record, so the only thing left is the exit code and the
            // system log. The runner sees a missing DONE and reports the work item as a
            // harness failure, which is exactly what this is.
            NSLog("ProbeHost: %@", failure.message)
            exit(failure.exit.rawValue)
        } catch {
            exit(ProbeExit.cantCreate.rawValue)
        }
        self.paths = paths

        let log = Log(fileURL: paths.logURL, verbose: arguments.verbose, clock: probeClock)
        self.log = log
        log.line("ProbeHost \(arguments.suite.rawValue) run \(arguments.runId)")
        log.line("arguments: \(arguments.echo.joined(separator: " "))")

        let record = RunRecord(
            runId: arguments.runId, suite: arguments.suite.rawValue, startedAt: probeClock.startedAt
        )
        self.record = record

        switch arguments.suite {
        case .scenario:
            let runner = ScenarioRunner(
                arguments: arguments, paths: paths, log: log, clock: probeClock,
                record: record, container: container
            )
            scenarioRunner = runner
            runner.start { [weak self] code in
                self?.write(record.build(log: log), code: code)
            }
        case .spike:
            let runner = SpikeRunner(
                arguments: arguments, paths: paths, log: log, clock: probeClock,
                container: container
            )
            spikeRunner = runner
            runner.start { [weak self] code in
                self?.write(runner.spikeRecord, code: code)
            }
        }
    }

    // MARK: - Finishing

    private func write(_ value: JSONValue, code: ProbeExit) {
        guard !exited else { return }
        exited = true
        guard let paths = paths else { exit(code.rawValue) }

        var status = code
        do {
            try paths.writeRecord(value.data())
        } catch let failure as ProbeFailure {
            log?.error("could not write the record: \(failure.message)")
            status = failure.exit
        } catch {
            status = .cantCreate
        }
        log?.line("exit \(status.rawValue)")
        log?.close()
        paths.writeDone()
        exit(status.rawValue)
    }

    /// Section 5.1: run.json is written even on exit 64, with almost everything null, so
    /// the runner always has a machine-readable reason rather than a silent process.
    private func reportUsageFailure(_ failure: ProbeFailure) {
        let fallbackId = UserDefaults.standard.string(forKey: "ProbeRunId")
            .flatMap { Arguments.isValidRunId($0) ? $0 : nil } ?? "usage"
        let suite = UserDefaults.standard.string(forKey: "ProbeSuite") == "spike"
            ? "spike" : "scenario"
        let recordName = suite == "spike" ? "spike.json" : "run.json"
        NSLog("ProbeHost usage error: %@ (%@)", failure.message, failure.code)

        guard let paths = try? RunPaths(
            runId: fallbackId, outPath: "probe/out/\(fallbackId)", recordName: recordName
        ) else {
            exit(failure.exit.rawValue)
        }
        self.paths = paths
        let log = Log(fileURL: paths.logURL, verbose: false, clock: probeClock)
        log.error("\(failure.code): \(failure.message)")
        self.log = log

        let record = RunRecord(runId: fallbackId, suite: suite, startedAt: probeClock.startedAt)
        record.status = failure.exit.statusName
        record.exitCode = failure.exit.rawValue
        record.endedAt = Date()
        record.durationMs = probeClock.ms()
        write(record.build(log: log), code: failure.exit)
    }
}

// MARK: - Life cycle

final class ProbeAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        true
    }

    /// Named here as well as in Info.plist. The manifest is what UIKit reads at launch;
    /// this keeps the pairing visible in code and survives a regenerated plist.
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Probe", sessionRole: connectingSceneSession.role
        )
        configuration.delegateClass = ProbeSceneDelegate.self
        return configuration
    }
}

/// @objc(ProbeSceneDelegate) fixes the Objective-C class name, so Info.plist can name the
/// delegate without a $(PRODUCT_MODULE_NAME) prefix that a rename would break.
@objc(ProbeSceneDelegate)
final class ProbeSceneDelegate: NSObject, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        // The scene's own coordinate space, not UIScreen.main: the screen-wide bounds are
        // deprecated under the scene life cycle and are the wrong rectangle the moment a
        // scene is not full-screen. The record's viewport is measured from this view.
        let window = UIWindow(windowScene: windowScene)
        window.frame = windowScene.coordinateSpace.bounds
        let root = UIViewController()
        root.view.backgroundColor = .white
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.window = window

        // Start after the first run-loop turn, so the window is on screen and
        // takeSnapshot has something to draw before any measurement begins.
        DispatchQueue.main.async {
            ProbeSession.shared.begin(container: root.view)
        }
    }
}

_ = UIApplicationMain(
    CommandLine.argc,
    CommandLine.unsafeArgv,
    nil,
    NSStringFromClass(ProbeAppDelegate.self)
)
