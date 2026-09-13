# ProbeHost and the live suites — index

**Milestone M2c.** Normative for everything under `Tools/ProbeHost`, `Tools/ProbeRunner`,
`config/scenarios.json`, `.github/workflows/live.yml` and `.github/workflows/spike.yml`.

Governing specs, in precedence order: the app repo's design document (private), sections 9,
3 and 1.3; that repo's milestones M0 and M2c; `docs/CONTRACT.md` for everything ProbeHost
fetches. Where this document disagrees with the design document, the design document wins and
this document is wrong.

What M2c delivers: **measured proof that the published bundle blocks**, produced on free
hosted runners, in a public repo, with no secrets and no private app source.

---

## 1. The one decision: how ProbeHost is driven

**ProbeHost is driven by `xcrun simctl launch` with launch arguments, and results are read
out of the app's data container. It is not an XCTest target.**

Justification, in order of weight:

1. **One product, two suites, one build.** `xcodebuild build -sdk iphonesimulator` produces
   a single `ProbeHost.app` that both `live.yml` and `spike.yml` install. An XCTest driver
   needs a test host, a UI-test runner target, a scheme with a test plan, and `xcodebuild
   test` on every invocation — roughly double the macOS minutes against M2c's 35-minute
   budget (DESIGN 10.3), for no measurement we cannot otherwise take.
2. **Results are plain files.** `xcrun simctl get_app_container <udid> <bundle> data` hands
   the runner a directory; the JSON and the PNGs are copied out with `cp -R`. The XCTest
   route puts attachments inside an `.xcresult` bundle that must be parsed with
   `xcresulttool`, whose JSON output changed incompatibly in Xcode 16 and now needs
   `--legacy`. The toolchain here has to work on the **first** macos-26 run, with no Mac to
   iterate on; a format we do not have to parse is a format that cannot surprise us.
3. **Pass/fail is the wrong currency.** XCTest's natural output is an assertion result. M2c's
   output is a *measurement*: "23 requests blocked, 0 ad elements visible, 2 popups
   attempted". The harness must exit non-zero only when it failed to measure, never because
   a site blocked less than we hoped. Fighting XCTest's failure semantics to get that is
   more work than writing the JSON directly.
4. **Reproducible by hand.** The same `.app`, launched from Simulator.app with the same
   `-Probe*` arguments, reproduces a CI failure exactly. An XCTest run is reproducible only
   inside Xcode.

**What we give up, and what we do about it.** XCTest's one real advantage is
`XCUICoordinate.tap()`, which delivers a HID-level, *trusted* tap — the only kind that
satisfies WebKit's user-activation gate and therefore the only kind that provokes a real
popunder. ProbeHost's centre tap is therefore **synthetic** (`elementFromPoint` plus a
dispatched pointer/mouse/click sequence), and every run records `tap.method`,
`tap.trusted: false` and `tap.userActivationAfter`. Popup counts taken after a synthetic tap
are labelled **indicative** everywhere they appear (`docs/PROBEHOST.md` section 4) and are
never used as a pass criterion. Real popup enforcement is FLASH SUPPRESSANT's problem, it is
scheduled for M4, and it runs in the private probe (DESIGN 9.3). The hook for a future
`ProbeTap` XCUITest target, or the AXe CLI, is named in `02-runner.md` section 9 and is
deliberately not built here.

**Corollary: the app's exit code is not visible to the runner.** `simctl launch` exits as
soon as the app is launched and reports the launch result, not the app's status. ProbeHost
therefore mirrors its exit code into `run.json` (`harness.exitCode`) and writes a `DONE`
sentinel as its last act; the runner polls for the sentinel against a deadline. A missing
sentinel is a harness failure for that one scenario and nothing else. See `01-probehost.md`
section 3 and `02-runner.md` section 5.

**Corollary: the harness proves itself before it measures anything.** ProbeHost serves a
local fixture set from a Network.framework listener on `127.0.0.1` and every suite begins
with `selftest-local`, in which a known URL *must* be blocked and a known URL *must* load.
Without that gate, "0 requests blocked" on a live site is ambiguous between "the filters did
not block" and "the harness is not measuring". With it, the ambiguity is gone. The fixtures
are also what make `spike.yml` deterministic and offline.

---

## 2. Files, by owning group

Exactly three groups. Nothing outside this table is in M2c scope.

### 2.1 Group `app` — `Tools/ProbeHost/`

| Path | What it is |
|---|---|
| `Tools/ProbeHost/project.yml` | XcodeGen spec. iOS 17.0 deployment target, no packages, no third-party dependencies. |
| `Tools/ProbeHost/Sources/Info.plist` | Bundle id `io.github.mioutic.probehost`; `NSAllowsLocalNetworking`; no ATS relaxation beyond that. |
| `Tools/ProbeHost/Sources/ProbeHost/main.swift` | `UIApplicationMain`, window, root view, suite dispatch. |
| `.../Arguments.swift` | The launch contract of `01-probehost.md` section 2: parse, validate, exit 64 on misuse. |
| `.../Paths.swift` | Container layout (`Documents/probe/{in,out}`), run directory creation, `DONE`. |
| `.../Log.swift` | `OSLog` plus an append-only `run.log` in the run directory. |
| `.../Lzfse.swift` | `NSData.decompressed(using: .lzfse)` with the size guards of CONTRACT section 2. |
| `.../Manifest.swift` | `Codable` model of `manifest.json`, CONTRACT section 4. Unknown fields ignored. |
| `.../ContractVerifier.swift` | CONTRACT section 6 steps 1-15, each step recorded with its outcome. Pinned public key only. |
| `.../BundleLoader.swift` | Fetch from `latest/download` or a mirror, or load a bundle from disk; flavour and bucket selection (CONTRACT 8.1, 8.2). |
| `.../RuleListCompiler.swift` | `WKContentRuleListStore` in a per-run store directory; main-actor, one bucket at a time (CONTRACT 8.5). |
| `.../FixtureServer.swift` | ~150-line HTTP/1.1 listener on `127.0.0.1` (Network.framework, no dependency) serving `Resources/fixtures/`. |
| `.../ProbeDelegates.swift` | `WKNavigationDelegate` + `WKUIDelegate` + the two guarded SPI selectors; active action patterns (CONTRACT 8.6). |
| `.../ScenarioRunner.swift` | The step machine: load, settle, tap, scroll, count, snapshot, write. |
| `.../SpikeRunner.swift` | The six M0 probes of `04-spike.md`. |
| `.../RunRecord.swift` | The `run.json` schema of `01-probehost.md` section 5, as `Codable`, plus the writer. |
| `.../Resources/probe.js` | Document-start, all-frames page-world script: resource observer, DOM counter, overlay finder, console capture, synthetic tap. |
| `.../Resources/fixtures/*` | `selftest.html`, `blocked.js`, `allowed.js`, `redirect.html`, `media.html` — the offline fixture set. |

### 2.2 Group `runner` — `Tools/ProbeRunner/` + scenario data

| Path | What it is |
|---|---|
| `Tools/ProbeRunner/run.mjs` | CLI entry. Boots, installs, runs every scenario in both modes, writes `report.json`. |
| `Tools/ProbeRunner/lib/args.mjs` | Argument parsing and defaults for `run.mjs`. |
| `Tools/ProbeRunner/lib/simctl.mjs` | Every `xcrun simctl` call, JSON-parsed, with timeouts. The only place that shells out. |
| `Tools/ProbeRunner/lib/device.mjs` | Runtime and device-type selection, create/boot/bootstatus, status bar override, teardown. |
| `Tools/ProbeRunner/lib/scenarios.mjs` | Load and validate `config/scenarios.json`; resolve `urlFrom` env vars; expand to (scenario, mode, repeat) work items. |
| `Tools/ProbeRunner/lib/launch.mjs` | Stage inputs into the container, launch, poll for `DONE`, enforce deadlines, retry policy. |
| `Tools/ProbeRunner/lib/collect.mjs` | Pull `run.json`, PNGs and `run.log` out of the container into `build/probe/<runId>/`. |
| `Tools/ProbeRunner/lib/merge.mjs` | Merge every `run.json` into the combined report of `03-report.md` section 2. |
| `Tools/ProbeRunner/lib/log.mjs` | Runner logging; one line per work item, no ANSI in CI. |
| `config/scenarios.json` | The sites, per `02-runner.md` section 3. Data only — no code reads a URL from anywhere else. |
| `test/probe-scenarios.test.mjs` | Schema and invariant tests for `scenarios.json` (runs on ubuntu in `test.yml`). |
| `test/probe-merge.test.mjs` | Merge and delta arithmetic against fixture `run.json` files. |

### 2.3 Group `ci` — workflows, summary, trend, wiring

| Path | What it is |
|---|---|
| `.github/workflows/live.yml` | `workflow_dispatch` + weekly cron on `macos-26`. Builds, runs, summarises, uploads. |
| `.github/workflows/spike.yml` | `workflow_dispatch` on `macos-26`. The M0 probes of `04-spike.md`, per installed runtime. |
| `Tools/ProbeRunner/report.mjs` | CLI: `report.json` in, job-summary markdown and `trend.json` out. |
| `Tools/ProbeRunner/lib/summary.mjs` | The markdown of `03-report.md` section 3. |
| `Tools/ProbeRunner/lib/trend.mjs` | The trend record of `03-report.md` section 4, plus `--accumulate`. |
| `test/probe-summary.test.mjs` | Golden markdown and trend output from a fixture report. |
| `VERSIONS.json` | New `actions` and `toolchain` pins: XcodeGen release + sha256, probe budgets. |
| `scripts/pin-check.mjs` | Checks the XcodeGen pin like every other pin. |
| `package.json` | `probe`, `probe:spike`, `probe:report` scripts. |
| `README.md`, `docs/PROBEHOST.md` | Links and the reader's guide to the numbers. |

---

## 3. Interfaces between the groups

Three contracts. Each is owned by one group, consumed by another, and versioned by an
integer that appears in the file it describes.

| Interface | Owner | Consumer | Defined in |
|---|---|---|---|
| **Launch contract** — argv, container paths, `DONE`, exit codes | app | runner | `01-probehost.md` §2, §3 |
| **`run.json` schema** (`schemaVersion: 1`) | app | runner | `01-probehost.md` §5 |
| **`spike.json` schema** (`schemaVersion: 1`) | app | runner, ci | `04-spike.md` §2 |
| **`scenarios.json` schema** | runner | app (it is copied verbatim into the container) | `02-runner.md` §3 |
| **`report.json` schema** (`schemaVersion: 1`) | runner | ci | `03-report.md` §2 |
| **`run.mjs` CLI + exit codes** | runner | ci | `02-runner.md` §8 |
| **Artifact layout** `build/probe/<runId>/…` | runner | ci | `03-report.md` §5 |
| **`ProbeHost.app` path + bundle id** | app | runner, ci | `01-probehost.md` §1 |

Rules that keep the seams honest:

- The app never reads `config/scenarios.json` from the repo. The runner copies the **one**
  scenario it is about to run into `Documents/probe/in/scenario.json`. The app therefore has
  no opinion about which sites exist, and a scenario edit needs no rebuild.
- The runner never parses PNGs, HTML or log text to derive a number. Every number in
  `report.json` comes from a field in some `run.json`.
- `report.mjs` never reads a `run.json`. It reads `report.json` only, so the summary and the
  trend cannot disagree with the report.
- Nothing outside `Tools/ProbeHost` may import WebKit, and nothing outside
  `Tools/ProbeRunner` may shell out to `xcrun`.

---

## 4. End to end: workflow start to artifacts uploaded

`live.yml`, one job, `runs-on: macos-26`, `timeout-minutes: 45`,
`concurrency: probe-live` (no cancel-in-progress).

1. **Trigger.** `workflow_dispatch` (inputs: `runtime`, `repeats`, `scenarios`, `modes`,
   `strict`) or the weekly cron `23 5 * * 1`. Public repo, hosted runner, no cost.
2. **Checkout** at a pinned action SHA, `persist-credentials: false`. **No secrets are
   available to this workflow**; `permissions: contents: read`.
3. **Toolchain.** `sudo xcode-select -s /Applications/Xcode_26.6.app/Contents/Developer`,
   assert the major is 26, `xcodebuild -version` into the log. Node 24 via the pinned
   `setup-node`, `npm ci`.
4. **XcodeGen.** Download the pinned release zip, verify its sha256 against `VERSIONS.json`,
   `xcodegen generate --spec Tools/ProbeHost/project.yml`. No `brew install` (DESIGN 10.1).
5. **Build.** `actions/cache` on `DerivedData` keyed by Xcode version + hash of
   `project.yml` and `Tools/ProbeHost/Sources/**`; then `xcodebuild -project
   Tools/ProbeHost/ProbeHost.xcodeproj -scheme ProbeHost -configuration Release -sdk
   iphonesimulator -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build`.
   Output: `ProbeHost.app`.
6. **Device.** `run.mjs` reads `xcrun simctl list -j runtimes devicetypes devices`, picks a
   runtime and device type per `02-runner.md` §2, creates `janus-probe-<runtime>`, boots it,
   waits on `simctl bootstatus -b`, pins the status bar to 9:41 / 100 % for reproducible
   screenshots, and installs the app.
7. **Self-check.** `selftest-local` runs first, in both modes, against the in-app fixture
   server. If the blocked URL is not blocked, or the SPI callback never fires, the run stops
   here and the job fails: nothing measured afterwards would mean anything.
8. **Measure.** For each enabled scenario, for each repeat, for both modes in an alternating
   order: stage the scenario into the container, launch, poll for `DONE` against the
   scenario's deadline, pull `run.json` + PNGs + `run.log` out, move on. One retry per work
   item, harness failures only. A scenario that fails is recorded and the loop continues.
   The suite stops early and marks the rest `skipped: budget` when the wall budget expires.
9. **Merge.** `run.mjs` writes `build/probe/<runId>/report.json` and exits 0 unless the
   harness itself failed (`02-runner.md` §8).
10. **Summarise.** `report.mjs` appends the markdown of `03-report.md` §3 to
    `$GITHUB_STEP_SUMMARY` — per scenario: requests blocked, ad elements visible, popups
    attempted, and the blocked-vs-none delta — and writes `trend.json`.
11. **Upload.** `actions/upload-artifact` (pinned), `if: always()`:
    `probe-live-<run_id>-<run_attempt>` with `build/probe/<runId>/**` (14 days) and
    `probe-trend-<run_id>` with `trend.json` alone (90 days).
12. **Teardown.** `simctl shutdown <the exact UDID this job created>`. The runner never
    terminates a process by name and never touches a process it did not start.

`spike.yml` shares steps 1-5, then: for **each** installed iOS runtime with major ≥ 17, boot
a device, launch `-ProbeSuite spike`, collect `spike.json`, shut down. Merge into
`spike-report.json`, emit the probe × runtime verdict table, upload
`probe-spike-<run_id>`. Every probe reports `pass`, `fail`, `unknown` or `skipped`; a probe
that could not run reports `unknown` with its reason and never a guess (`04-spike.md` §4).

---

## 5. Hygiene invariants

These hold for every file in every group; CI and review both check them.

- **No secrets, ever.** Neither workflow declares an `environment`, and neither needs one.
  The signing key is not used here: ProbeHost verifies with the **public** key of CONTRACT
  section 5, which is already published.
- **No private app source.** ProbeHost is an independent consumer of the public bundle. It
  shares no file with the app repo (private) and must not be made to; where it re-implements
  contract logic, that is a feature — a second implementation is what proves the contract is
  writable from the document alone.
- **No local paths, names or addresses.** Repo-relative paths only, in code, docs, JSON and
  workflow logs.
- **Record, do not evade.** When the runner's Azure egress earns an interstitial, a login
  wall or a consent wall, the run records `pageState` and the evidence, and the summary says
  so. No user-agent forgery beyond the app's ordinary iPhone UA, no CAPTCHA handling, no
  proxying. Residential egress is explicitly out of scope for M2c.
- **Measurement never fails the job.** Blocking numbers, popup counts, compile *times* and
  page states are data. The job fails only when the harness could not measure, when the
  published bundle failed contract verification, or when `strict` is set and a scenario
  marked `stable: true` regressed.

---

## 6. Out of scope for M2c

Named here so the hooks stay where they belong and nobody builds them by accident: the
Ghostery reference diff (Tier B, `live/probe.mjs`), the video-fixture suites and the media
fixture server, the private integration probe (it lives in the app repo), trusted
taps and the popup torture suite (M4), residential egress via Tailscale, and any accumulation
store for the trend beyond the artifact (`03-report.md` §4.3 documents the route and ships
the code, but wires nothing).
