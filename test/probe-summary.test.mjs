// SPDX-License-Identifier: GPL-3.0-or-later
//
// docs/probehost/03-report.md sections 3 and 4, and 04-spike.md section 5.
//
// The golden here is the whole job summary, byte for byte. That is deliberate: the
// summary is the only artefact of M2c most people will ever read, and a formatting
// change that quietly drops a column or turns an absent measurement into a zero
// must fail a test rather than surprise a reader six weeks later.
//
// These suites run on ubuntu in test.yml with no simulator and no network: summary
// and trend are pure functions of a report object.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SUMMARY_MAX_BYTES,
  artifactName,
  dur,
  group,
  renderSummary,
  stateOf,
} from "../Tools/ProbeRunner/lib/summary.mjs";
import {
  accumulate,
  buildTrend,
  parseNdjson,
  toNdjson,
  trendScenario,
} from "../Tools/ProbeRunner/lib/trend.mjs";

// ---------------------------------------------------------------------------
// the fixture report (03-report.md section 2, trimmed to three scenarios)
// ---------------------------------------------------------------------------

const mode = (overrides) => ({
  runs: ["reddit-popular/blocked/1/run.json"],
  requestsObserved: 214,
  requestsBlocked: 37,
  blockedByFamily: { "net.ads": 28, "net.privacy": 9 },
  thirdPartyHosts: 23,
  adElementsMatched: 14,
  adElementsVisible: 0,
  overlays: 0,
  largestOverlayFraction: 0,
  popupsNative: 0,
  popupsJs: 0,
  dialogs: 0,
  consoleErrors: 3,
  loadMs: 6120,
  didFinish: true,
  ...overrides,
});

function fixtureReport() {
  return {
    schemaVersion: 1,
    suite: "scenario",
    runId: "20260915051022-a3f1",
    startedAt: "2026-09-15T05:10:22Z",
    endedAt: "2026-09-15T05:31:48Z",
    durationMs: 1286000,
    ci: {
      provider: "github-actions",
      repository: "mioutic/janus-filters",
      workflow: "live",
      runNumber: 42,
      runId: "1234567890",
      runAttempt: 1,
      sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
      ref: "refs/heads/main",
      event: "schedule",
    },
    environment: {
      runnerImage: "macos-26",
      macosVersion: "26.1",
      xcode: "26.6",
      runtime: "26.4",
      deviceType: "iPhone 16 Pro Max",
      viewport: { width: 440, height: 956, scale: 3 },
      node: "24.8.0",
      egress: { mode: "direct", datacentre: true, observedIp: null },
    },
    bundle: {
      source: "network",
      version: 2026091300,
      layoutVersion: 1,
      issuedAt: "2026-09-13T04:31:07Z",
      ageHours: 49,
      keyId: "d6ff9fb88ae9b930",
      contractVersion: 1,
      flavour: "ios26",
      contractOk: true,
      consistent: true,
    },
    compile: {
      buckets: 59,
      failed: 0,
      failedIds: [],
      totalMs: 41880,
      medianMs: 412,
      slowest: [{ id: "janus.net.ads.00", compileMs: 4188, ruleCount: 72311 }],
      ruleCountTotal: 512000,
    },
    gate: { id: "selftest-local", passed: true, blocked: 1, domVisible: 0, allowedLoaded: true, spiFired: true },
    scenarios: [
      {
        id: "reddit-popular",
        title: "Reddit r/popular",
        url: "https://www.reddit.com/r/popular/",
        stable: false,
        status: "ok",
        reason: null,
        attempts: 1,
        repeats: 1,
        pageState: { blocked: "ok", none: "ok", agree: true },
        modes: {
          blocked: mode({}),
          none: mode({
            requestsObserved: 361,
            requestsBlocked: 0,
            adElementsVisible: 11,
            overlays: 2,
            popupsNative: 1,
            consoleErrors: 2,
            loadMs: 8430,
          }),
        },
        flags: ["console-errors-higher-in-blocked"],
      },
      {
        id: "reddit-r-news",
        status: "ok",
        attempts: 1,
        repeats: 1,
        pageState: { blocked: "challenged", none: "challenged", agree: true },
        modes: {
          blocked: mode({
            requestsObserved: 31,
            requestsBlocked: 4,
            adElementsVisible: 0,
            overlays: 1,
            consoleErrors: 0,
            loadMs: 1980,
          }),
          none: mode({
            requestsObserved: 34,
            requestsBlocked: 0,
            adElementsVisible: 0,
            overlays: 1,
            consoleErrors: 0,
            loadMs: 2010,
          }),
        },
        flags: [],
      },
      {
        id: "gofile-file",
        status: "skipped",
        reason: "PROBE_GOFILE_URL not configured",
        attempts: 0,
        repeats: 1,
        modes: { blocked: null, none: null },
        flags: [],
      },
    ],
    totals: {
      scenariosRun: 3,
      scenariosOk: 2,
      scenariosFailed: 0,
      scenariosSkipped: 1,
      requestsBlocked: 41,
      adElementsVisibleBlocked: 0,
      adElementsVisibleNone: 11,
      popupsNativeBlocked: 0,
      popupsNativeNone: 1,
    },
    harness: {
      ok: true,
      failures: [],
      warnings: [],
      skipped: [{ scenario: "gofile-file", reason: "PROBE_GOFILE_URL not configured" }],
    },
  };
}

const GOLDEN_SUMMARY = [
  "## Live blocking suite — bundle 2026091300 (2 days old)",
  "",
  "**ios26**, 59 buckets, 512,000 rules, compiled in 41.9 s · runtime **iOS 26.4** on **iPhone 16 Pro Max** · Xcode 26.6 · egress **direct (datacentre)** · 1 repeat",
  "",
  "Harness self-check **passed** · contract verification **passed** · 2/3 scenarios measured",
  "",
  "| Scenario | State | Blocked | Requests b/n | Ads visible b/n | Popups b/n | Overlays b/n | Load ms b/n |",
  "|---|---|---:|---:|---:|---:|---:|---:|",
  "| reddit-popular | ok | **37** | 214 / 361 | **0 / 11** | 0 / 1 | 0 / 2 | 6120 / 8430 |",
  "| reddit-r-news | challenged | 4 | 31 / 34 | 0 / 0 | 0 / 0 | 1 / 1 | 1980 / 2010 |",
  "| gofile-file | skipped | — | — / — | — / — | — / — | — / — | — / — |",
  "",
  "`b/n` = mode **blocked** / mode **none**. Bold = the number M2c is about. `Blocked` is the",
  "count of distinct URLs the rule-list action callback reported as blocked in mode blocked;",
  "it is a lower bound, because cosmetic hides are never reported to the app. Popups are",
  "native plus JavaScript-opened windows **attempted** after a synthetic tap, which is",
  "indicative only: see `docs/PROBEHOST.md`.",
  "",
  "### Not measured",
  "",
  "| Scenario | Status | Reason | Evidence |",
  "|---|---|---|---|",
  "| gofile-file | skipped | PROBE_GOFILE_URL not configured | — |",
  "",
  "### Flags",
  "",
  "- `reddit-popular`: more console errors with the rules attached than without — possible breakage caused by our own rules.",
  "- `reddit-r-news`: page state **challenged** — a datacentre IP reaching a wall, not a blocking result.",
  "",
  "### Compile",
  "",
  "59 buckets, 0 failures, 41.9 s total, median 412 ms.",
  "Slowest: janus.net.ads.00 4188 ms (72,311 rules).",
  "*Simulator timings on a virtualised runner: relative cost only, never a phone estimate.*",
  "",
  "---",
  "",
  "Artifact `probe-live-1234567890-1` · how to read these numbers: `docs/PROBEHOST.md`",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// the summary
// ---------------------------------------------------------------------------

test("the live summary is the markdown of 03-report.md section 3, byte for byte", () => {
  assert.equal(renderSummary(fixtureReport()), GOLDEN_SUMMARY);
});

test("formatting follows section 3.5: counts grouped, durations rounded, ms columns bare", () => {
  assert.equal(group(512000), "512,000");
  assert.equal(dur(412), "412 ms");
  assert.equal(dur(41880), "41.9 s");
  // The Load ms column prints milliseconds, not a prose duration.
  assert.match(renderSummary(fixtureReport()), /\| 6120 \/ 8430 \|/);
});

test("a mode that produced no result is an em dash, never a zero", () => {
  const report = fixtureReport();
  report.scenarios[0].modes.none = null;
  const markdown = renderSummary(report);
  assert.match(markdown, /\| reddit-popular \| ok \| \*\*37\*\* \| 214 \/ — \| \*\*0 \/ —\*\* \| 0 \/ — \| 0 \/ — \| 6120 \/ — \|/);
});

test("a scenario the harness never measured carries no numbers at all", () => {
  const markdown = renderSummary(fixtureReport());
  assert.match(markdown, /\| gofile-file \| skipped \| — \| — \/ — \| — \/ — \| — \/ — \| — \/ — \| — \/ — \|/);
});

test("a failed contract verification is the first thing in the summary", () => {
  const report = fixtureReport();
  report.bundle.contractOk = false;
  report.bundle.contractFailure = { step: 7, reason: "manifest age 21 days exceeds 14" };
  const markdown = renderSummary(report);
  assert.ok(
    markdown.startsWith("**FAILED** — contract verification failed at step 7: manifest age 21 days exceeds 14."),
    markdown.slice(0, 160),
  );
  assert.match(markdown, /contract verification \*\*FAILED\*\*/);
});

test("a failed self-check says so even when the contract verified", () => {
  const report = fixtureReport();
  report.gate.passed = false;
  report.gate.reason = "the blocked fixture loaded";
  const markdown = renderSummary(report);
  assert.ok(markdown.startsWith("**FAILED** — the harness self-check failed: the blocked fixture loaded."));
  assert.match(markdown, /Harness self-check \*\*FAILED\*\*/);
});

test("an unrecorded self-check is 'not run', not 'passed'", () => {
  const report = fixtureReport();
  delete report.gate;
  delete report.bundle.contractOk;
  const markdown = renderSummary(report);
  assert.match(markdown, /Harness self-check \*\*not run\*\* · contract verification \*\*not recorded\*\*/);
});

test("the 'Not measured' section is present even when every scenario was measured", () => {
  const report = fixtureReport();
  report.scenarios = report.scenarios.slice(0, 2);
  report.harness.skipped = [];
  const markdown = renderSummary(report);
  assert.match(markdown, /### Not measured\n\nEvery scenario in the suite produced a measurement in both modes\./);
});

test("a bundle that changed mid-suite is flagged loudly", () => {
  const report = fixtureReport();
  report.bundle.consistent = false;
  assert.match(renderSummary(report), /\*\*The bundle changed mid-suite\.\*\*/);
});

test("page states that disagree keep the row advisory and unbolded", () => {
  const report = fixtureReport();
  report.scenarios[0].pageState = { blocked: "ok", none: "challenged", agree: false };
  report.scenarios[0].flags = ["page-state-disagree"];
  const markdown = renderSummary(report);
  assert.equal(stateOf(report.scenarios[0]), "ok/challenged");
  assert.match(markdown, /\| reddit-popular \| ok\/challenged \| 37 \|/);
  assert.doesNotMatch(markdown, /\*\*37\*\*/);
});

test("truncation keeps the header and the table", () => {
  const markdown = renderSummary(fixtureReport(), { maxBytes: 1400 });
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 1400);
  assert.ok(markdown.startsWith("## Live blocking suite"));
  assert.match(markdown, /\| Scenario \| State \| Blocked \|/);
  assert.ok(SUMMARY_MAX_BYTES === 1048576);
});

test("the summary leaks no URL, no query string and no local path", () => {
  const markdown = renderSummary(fixtureReport());
  assert.doesNotMatch(markdown, /https?:\/\//);
  assert.doesNotMatch(markdown, /\?[A-Za-z0-9_]+=/);
  assert.doesNotMatch(markdown, /[A-Za-z]:\\/);
  assert.doesNotMatch(markdown, /\/(?:Users|home)\//);
});

test("the artifact in the footer is derived from the CI identity, per suite", () => {
  assert.equal(artifactName(fixtureReport()), "probe-live-1234567890-1");
  assert.equal(artifactName({ suite: "spike", ci: { runId: "1234567890" } }), "probe-spike-1234567890");
  assert.equal(artifactName({ suite: "scenario", ci: {} }), null);
});

// ---------------------------------------------------------------------------
// the spike matrix (04-spike.md section 5)
// ---------------------------------------------------------------------------

function spikeReport() {
  const probe = (id, verdict, extra = {}) => ({ id, title: id, verdict, ms: 1200, evidence: {}, reason: null, ...extra });
  return {
    schemaVersion: 1,
    suite: "spike",
    runId: "spike-20260915",
    environment: { runnerImage: "macos-26", xcode: "26.6" },
    installedRuntimes: ["26.2", "26.4", "26.5"],
    ci: { runId: "1234567890", runAttempt: 1 },
    runtimes: [
      {
        runtime: "26.2",
        deviceType: "iPhone 16 Pro Max",
        probes: [
          probe("rule-list-action-callback", "pass"),
          probe("active-action-patterns", "pass"),
          probe("media-pref-next-navigation", "fail", { reason: "typeof ManagedMediaSource did not change across stops" }),
          probe("media-source-availability", "pass", {
            evidence: { mediaSource: false, managedMediaSource: false, nativeHls: "probably", av1: null },
          }),
        ],
      },
      {
        runtime: "26.5",
        deviceType: "iPhone 16 Pro Max",
        probes: [
          probe("rule-list-action-callback", "pass"),
          probe("active-action-patterns", "unknown", { reason: "the redirect fixture list did not compile" }),
          probe("media-pref-next-navigation", "fail", { reason: "typeof ManagedMediaSource did not change across stops" }),
          probe("media-source-availability", "skipped", { reason: "excluded by --probes" }),
        ],
      },
    ],
    harness: { status: "ok", exitCode: 0, errors: [], warnings: [] },
  };
}

test("the spike summary is a probe x runtime matrix with every probe present", () => {
  const markdown = renderSummary(spikeReport());
  assert.match(markdown, /## M0 capability spike — macos-26 \/ Xcode 26\.6/);
  assert.match(markdown, /Installed iOS runtimes: \*\*26\.2, 26\.4, 26\.5\*\* · device type \*\*iPhone 16 Pro Max\*\*/);
  assert.match(markdown, /\| Probe \| 26\.2 \| 26\.5 \|/);
  assert.match(markdown, /\| rule-list-action-callback \| pass \| pass \|/);
  assert.match(markdown, /\| active-action-patterns \| pass \| unknown \|/);
  assert.match(markdown, /\| media-source-availability \| pass \| skipped \|/);
});

test("every unknown and every fail carries its reason", () => {
  const markdown = renderSummary(spikeReport());
  assert.match(markdown, /- `active-action-patterns` on 26\.5 — unknown: the redirect fixture list did not compile/);
  assert.match(markdown, /- `media-pref-next-navigation` on 26\.2 — fail: typeof ManagedMediaSource did not change/);
  assert.match(
    markdown,
    /Capability report on 26\.2: mediaSource \*\*absent\*\*, managedMediaSource \*\*absent\*\*, nativeHls \*\*probably\*\*, av1 \*\*unknown\*\*\./,
  );
});

test("a spike that produced no verdict says so instead of printing an empty grid", () => {
  const report = spikeReport();
  report.runtimes = [];
  const markdown = renderSummary(report);
  assert.match(markdown, /No probe produced a verdict/);
});

test("the installed runtimes come from the runner-side probe as run.mjs writes it", () => {
  // run.mjs puts the installed-runtimes probe in `probes[0]` with structured
  // evidence, and does not repeat it as a flat list. Reading the probe is what
  // distinguishes "these runtimes exist" from "these runtimes were attempted".
  const report = spikeReport();
  delete report.installedRuntimes;
  report.probes = [
    {
      id: "installed-runtimes",
      verdict: "pass",
      evidence: {
        runtimes: [
          { version: "26.2", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2" },
          { version: "26.4", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4" },
          { version: "26.5", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5" },
        ],
      },
      reason: null,
    },
  ];
  const markdown = renderSummary(report);
  assert.match(markdown, /Installed iOS runtimes: \*\*26\.2, 26\.4, 26\.5\*\*/);
  assert.match(markdown, /Runner-side probe installed-runtimes: \*\*pass\*\*/);
});

test("a runtime that produced no spike.json is a row of dashes with its reason", () => {
  const report = spikeReport();
  report.runtimes[1] = {
    runtime: "26.5",
    runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    deviceType: "iPhone 16 Pro Max",
    status: "harness-failed",
    reason: "the device would not boot within 300000 ms",
    file: null,
    host: null,
    probes: null,
    harness: null,
  };
  const markdown = renderSummary(report);
  assert.match(markdown, /\| rule-list-action-callback \| pass \| — \|/);
  assert.match(markdown, /- runtime 26\.5 — harness-failed: the device would not boot within 300000 ms/);
});

// ---------------------------------------------------------------------------
// the trend (03-report.md section 4)
// ---------------------------------------------------------------------------

test("the trend record is the flat object of section 4.1", () => {
  assert.deepEqual(buildTrend(fixtureReport()), {
    schemaVersion: 1,
    runId: "20260915051022-a3f1",
    date: "2026-09-15",
    ts: "2026-09-15T05:31:48Z",
    bundleVersion: 2026091300,
    bundleIssuedAt: "2026-09-13T04:31:07Z",
    layoutVersion: 1,
    flavour: "ios26",
    contractOk: true,
    env: {
      runnerImage: "macos-26",
      xcode: "26.6",
      runtime: "26.4",
      deviceType: "iPhone 16 Pro Max",
      viewportWidth: 440,
      egress: "direct",
    },
    compile: { buckets: 59, failed: 0, ruleCountTotal: 512000, totalMs: 41880 },
    gate: { passed: true },
    scenarios: {
      "reddit-popular": {
        state: "ok",
        blocked: 37,
        observedB: 214,
        observedN: 361,
        adVisibleB: 0,
        adVisibleN: 11,
        overlaysB: 0,
        overlaysN: 2,
        popupsB: 0,
        popupsN: 1,
        dialogsB: 0,
        dialogsN: 0,
        consoleErrB: 3,
        consoleErrN: 2,
        loadMsB: 6120,
        loadMsN: 8430,
      },
      "reddit-r-news": {
        state: "challenged",
        blocked: 4,
        observedB: 31,
        observedN: 34,
        adVisibleB: 0,
        adVisibleN: 0,
        overlaysB: 1,
        overlaysN: 1,
        popupsB: 0,
        popupsN: 0,
        dialogsB: 0,
        dialogsN: 0,
        consoleErrB: 0,
        consoleErrN: 0,
        loadMsB: 1980,
        loadMsN: 2010,
      },
      "gofile-file": null,
    },
    ci: {
      runId: "1234567890",
      runAttempt: 1,
      sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
      event: "schedule",
    },
  });
});

test("a half-measured scenario is an explicit gap, not a carried-forward number", () => {
  const report = fixtureReport();
  report.scenarios[0].modes.none = null;
  assert.equal(buildTrend(report).scenarios["reddit-popular"], null);
  assert.equal(trendScenario({ modes: { blocked: mode({}) } }), null);
});

test("a number the harness did not observe is null in the trend, never 0", () => {
  const row = trendScenario({
    status: "ok",
    pageState: { blocked: "ok", none: "ok", agree: true },
    modes: { blocked: { requestsBlocked: 5 }, none: {} },
  });
  assert.equal(row.blocked, 5);
  assert.equal(row.observedB, null);
  assert.equal(row.popupsB, null);
  assert.equal(row.loadMsN, null);
});

test("the spike suite has no trend record", () => {
  assert.throws(() => buildTrend(spikeReport()), /no trend record/);
});

test("accumulate sorts by timestamp and de-duplicates on runId", () => {
  const records = [
    { runId: "b", ts: "2026-09-16T00:00:00Z", scenarios: {}, bundleVersion: 2 },
    { runId: "a", ts: "2026-09-15T00:00:00Z", scenarios: {}, bundleVersion: 1 },
    { runId: "b", ts: "2026-09-16T00:00:00Z", scenarios: {}, bundleVersion: 3 },
  ];
  const merged = accumulate(records);
  assert.deepEqual(
    merged.map((r) => [r.runId, r.bundleVersion]),
    [
      ["a", 1],
      ["b", 3],
    ],
  );
});

test("ndjson round-trips and ends with a newline so it appends cleanly", () => {
  const records = accumulate([buildTrend(fixtureReport())]);
  const text = toNdjson(records);
  assert.ok(text.endsWith("\n"));
  assert.equal(text.split("\n").filter(Boolean).length, 1);
  assert.deepEqual(parseNdjson(text), records);
  assert.deepEqual(parseNdjson(""), []);
  assert.throws(() => parseNdjson("{not json}\n"), /line 1 is not JSON/);
});
