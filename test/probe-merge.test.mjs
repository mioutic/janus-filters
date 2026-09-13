// SPDX-License-Identifier: GPL-3.0-or-later
//
// The merge and the delta arithmetic of docs/probehost/03-report.md section 2,
// against run.json fixtures shaped exactly like 01-probehost.md section 5.
//
// The three properties under test, because they are the ones that would let the
// report lie: null means "not measured" and 0 means "measured, and it was zero";
// a delta exists only when both modes produced a result; and repeats are merged
// with a median, so one challenged load cannot move a number.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReport,
  ciContext,
  computeDelta,
  evaluateExpect,
  median,
  mergeBundle,
  mergeCompile,
  mergeGate,
  mergeMode,
  mergeScenario,
  modeNumbersFromRun,
  scenarioFlags,
  strictViolations,
  sumOrNull,
  viewportFrom,
} from "../Tools/ProbeRunner/lib/merge.mjs";

const SHA = "a".repeat(64);

/** A run.json with the fields report.json reads, and nothing the merge ignores. */
function makeRun(overrides = {}) {
  const {
    blocked = 37,
    observed = 214,
    visible = 0,
    matched = 14,
    overlays = 0,
    popupsNative = 0,
    popupsJs = 0,
    dialogs = 0,
    consoleErrors = 3,
    loadMs = 6120,
    didFinish = true,
    pageState = "ok",
    truncated = false,
    compileFailed = 0,
    version = 2026091300,
    manifestSha256 = SHA,
    spi = true,
    contractOk = true,
    thirdPartyHosts = 23,
    transferBytes = 3_120_044,
  } = overrides;
  return {
    schemaVersion: 1,
    run: { id: "fixture", suite: "scenario" },
    host: { osVersion: "26.4", viewport: { width: 440, height: 956, scale: 3 } },
    bundle: {
      source: "network",
      origin: "release",
      version,
      layoutVersion: 1,
      issuedAt: "2026-09-13T04:31:07Z",
      ageHours: 49,
      keyId: "d6ff9fb88ae9b930",
      contractVersion: 1,
      flavour: "ios26",
      manifestSha256,
    },
    contract: { ok: contractOk, failedStep: contractOk ? null : 13, failureReason: contractOk ? null : "hash" },
    compile: {
      attached: 59,
      failed: compileFailed,
      totalMs: 41_880,
      buckets: [
        { id: "janus.net.ads.00", compileMs: 4188, ruleCount: 72_311, ok: compileFailed === 0 },
        { id: "janus.net.privacy.00", compileMs: 412, ruleCount: 21_004, ok: true },
        { id: "janus.cos.generic.01", compileMs: 2210, ruleCount: 40_112, ok: true },
      ],
    },
    navigation: { didFinish, loadMs, commitMs: 1840 },
    pageState: { state: pageState, matched: [], title: "fixture", httpStatus: 200 },
    requests: {
      observed,
      truncated,
      transferBytesLowerBound: transferBytes,
      thirdPartyHosts,
      byType: { script: 61, img: 88 },
    },
    blocked: {
      total: blocked,
      spi: { available: spi, selector: "_webView:contentRuleListWithIdentifier:performedAction:forURL:" },
      byAction: { blockedLoad: blocked },
      byFamily: { "net.ads": blocked },
      byHost: { "doubleclick.net": blocked },
    },
    dom: { totalMatched: matched, totalVisible: visible, selectors: [], frames: 7 },
    overlays: Array.from({ length: overlays }, (_, index) => ({ tag: "div", areaFraction: 0.5 + index / 10 })),
    popups: { native: [], js: [], nativeCount: popupsNative, jsCount: popupsJs },
    dialogs: Array.from({ length: dialogs }, () => ({ kind: "alert", message: "x" })),
    consoleErrors,
    screenshots: [{ name: "settle", file: "fixture-settle.png", bytes: 184_220 }],
    harness: { status: "ok", exitCode: 0, timeouts: [], warnings: [], errors: [] },
  };
}

const okResult = (scenarioId, mode, repeat, run, extra = {}) => ({
  runId: `${scenarioId}-${mode}-${repeat}`,
  scenarioId,
  mode,
  repeat,
  attempt: 1,
  status: "ok",
  dir: `${scenarioId}/${mode}/${repeat}`,
  files: ["run.json", "fixture-settle.png"],
  runJson: run,
  exitCode: 0,
  pageState: run.pageState.state,
  reason: null,
  ...extra,
});

const failedResult = (scenarioId, mode, repeat, status, reason, extra = {}) => ({
  runId: `${scenarioId}-${mode}-${repeat}`,
  scenarioId,
  mode,
  repeat,
  attempt: extra.attempt ?? 2,
  status,
  dir: `${scenarioId}/${mode}/${repeat}`,
  files: ["timeout.png", "run.log"],
  runJson: null,
  exitCode: null,
  pageState: null,
  reason,
  ...extra,
});

const scenarioStub = (overrides = {}) => ({
  id: "reddit-popular",
  title: "Reddit r/popular (new UI)",
  url: "https://www.reddit.com/r/popular/",
  gate: false,
  stable: false,
  status: "ready",
  reason: null,
  payload: { expect: null },
  ...overrides,
});

test("median ignores what was not measured and never invents a value", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 2]), 3);
  assert.equal(median([7]), 7);
  assert.equal(median([null, 9, undefined]), 9);
  assert.equal(median([null, undefined]), null, "nothing measured stays null, never 0");
  assert.equal(median([]), null);
  assert.equal(sumOrNull([null, 2, 3]), 5);
  assert.equal(sumOrNull([null]), null);
});

test("a run.json with a section missing yields null, and a measured zero yields 0", () => {
  const full = modeNumbersFromRun(makeRun({ blocked: 0, visible: 0, overlays: 0 }));
  assert.equal(full.requestsBlocked, 0, "measured zero");
  assert.equal(full.adElementsVisible, 0);
  assert.equal(full.overlays, 0);

  const empty = modeNumbersFromRun({});
  assert.equal(empty.requestsBlocked, null);
  assert.equal(empty.adElementsVisible, null);
  assert.equal(empty.overlays, null);
  assert.equal(empty.largestOverlayFraction, null);
  assert.equal(empty.didFinish, null);
});

test("repeats merge to the median and the representative run supplies the breakdowns", () => {
  const results = [
    okResult("s", "blocked", 1, makeRun({ blocked: 10, observed: 100 })),
    okResult("s", "blocked", 2, makeRun({ blocked: 37, observed: 214 })),
    okResult("s", "blocked", 3, makeRun({ blocked: 40, observed: 220 })),
  ];
  const merged = mergeMode(results);
  assert.equal(merged.requestsBlocked, 37);
  assert.equal(merged.requestsObserved, 214);
  assert.equal(merged.repeats, 3);
  assert.deepEqual(merged.runs, ["s/blocked/1/run.json", "s/blocked/2/run.json", "s/blocked/3/run.json"]);
  assert.equal(merged.representative, "s/blocked/2/run.json", "the median run supplies the maps");
  assert.deepEqual(merged.blockedByFamily, { "net.ads": 37 });
  assert.deepEqual(merged.screenshots, ["s/blocked/2/fixture-settle.png"]);
  assert.equal(mergeMode([]), null, "a mode with no run is null, not an empty object");
});

test("delta is blocked minus none, with the sign printed literally", () => {
  const blocked = mergeMode([okResult("s", "blocked", 1, makeRun({ blocked: 37, observed: 214, visible: 0 }))]);
  const none = mergeMode([okResult("s", "none", 1, makeRun({ blocked: 0, observed: 361, visible: 11 }))]);
  const delta = computeDelta(blocked, none);

  assert.equal(delta.requestsBlocked, 37);
  assert.equal(delta.requestsObserved, -147, "blocking removes requests: the sign stays negative");
  assert.equal(delta.adElementsVisible, -11);
  assert.equal(computeDelta(blocked, null), null, "a delta needs both halves");
  assert.equal(computeDelta(null, none), null);

  const partial = computeDelta({ requestsBlocked: 5, loadMs: null }, { requestsBlocked: 0, loadMs: 10 });
  assert.equal(partial.requestsBlocked, 5);
  assert.equal("loadMs" in partial, false, "an unmeasurable field is absent, never zero");
});

test("a scenario row carries both modes, the delta and the page-state agreement", () => {
  const results = [
    okResult("reddit-popular", "blocked", 1, makeRun({ blocked: 37, observed: 214, visible: 0 })),
    okResult("reddit-popular", "none", 1, makeRun({ blocked: 0, observed: 361, visible: 11, consoleErrors: 2 })),
  ];
  const row = mergeScenario({ scenario: scenarioStub(), results });

  assert.equal(row.status, "ok");
  assert.equal(row.attempts, 1);
  assert.equal(row.repeats, 1);
  assert.equal(row.modes.blocked.requestsBlocked, 37);
  assert.equal(row.modes.none.requestsBlocked, 0);
  assert.equal(row.delta.adElementsVisible, -11);
  assert.deepEqual(row.pageState, { blocked: "ok", none: "ok", agree: true });
  assert.ok(row.flags.includes("console-errors-higher-in-blocked"));
});

test("one failed mode is a row, not an exception, and the delta is null", () => {
  const results = [
    failedResult("reddit-popular", "blocked", 1, "timeout", "no DONE sentinel after 285000 ms"),
    okResult("reddit-popular", "none", 1, makeRun({ blocked: 0, observed: 361, visible: 11 })),
  ];
  const row = mergeScenario({ scenario: scenarioStub(), results });

  assert.equal(row.status, "timeout");
  assert.match(row.reason, /no DONE sentinel/);
  assert.equal(row.modes.blocked, null);
  assert.equal(row.modes.none.requestsObserved, 361, "the mode that did work still reports its numbers");
  assert.equal(row.delta, null);
  assert.deepEqual(row.pageState, { blocked: null, none: "ok", agree: null });
  assert.deepEqual(row.evidence, [
    "reddit-popular/blocked/1/timeout.png",
    "reddit-popular/blocked/1/run.log",
  ]);
});

test("a skipped scenario keeps its row with null numbers", () => {
  const row = mergeScenario({
    scenario: scenarioStub({ id: "gofile-file", status: "skipped", reason: "PROBE_GOFILE_URL not configured" }),
    results: [],
  });
  assert.equal(row.status, "skipped");
  assert.equal(row.reason, "PROBE_GOFILE_URL not configured");
  assert.deepEqual(row.modes, { blocked: null, none: null });
  assert.equal(row.delta, null);
  assert.equal(row.attempts, 0);
});

test("flags name what a reader should not have to derive", () => {
  const blocked = mergeMode([okResult("s", "blocked", 1, makeRun({ blocked: 0, visible: 4, overlays: 2, pageState: "challenged" }))]);
  const none = mergeMode([okResult("s", "none", 1, makeRun({ blocked: 3, visible: 4, overlays: 1, pageState: "ok" }))]);
  const flags = scenarioFlags({
    modes: { blocked, none },
    runs: [makeRun({ truncated: true, compileFailed: 1 })],
  });

  assert.ok(flags.includes("mode-none-blocked-nonzero"), "a blocked count in mode none is a harness bug");
  assert.ok(flags.includes("page-state-disagree"));
  assert.ok(flags.includes("zero-blocked-but-ads-visible"));
  assert.ok(flags.includes("overlay-appeared-in-blocked"));
  assert.ok(flags.includes("compile-failure"));
  assert.ok(flags.includes("truncated-requests"));

  const clean = scenarioFlags({
    modes: {
      blocked: mergeMode([okResult("s", "blocked", 1, makeRun({ blocked: 37, visible: 0, consoleErrors: 1 }))]),
      none: mergeMode([okResult("s", "none", 1, makeRun({ blocked: 0, visible: 9, consoleErrors: 4 }))]),
    },
    runs: [makeRun()],
  });
  assert.deepEqual(clean, []);
});

test("expect is met, missed, or unmeasurable, and the three are different facts", () => {
  const blocked = mergeMode([okResult("s", "blocked", 1, makeRun({ blocked: 41, visible: 0 }))]);
  assert.equal(evaluateExpect({ blockedMin: 20, domVisibleMax: 0 }, blocked).met, true);

  const missed = evaluateExpect({ blockedMin: 50 }, blocked);
  assert.equal(missed.met, false);
  assert.match(missed.misses[0], /blocked 41 < blockedMin 50/);

  const unmeasured = evaluateExpect({ blockedMin: 1 }, { requestsBlocked: null });
  assert.equal(unmeasured.met, null, "an unmeasured expectation is not a missed one");

  assert.deepEqual(evaluateExpect(null, blocked), { declared: null, met: null, misses: [] });
  assert.equal(evaluateExpect({ blockedMin: 1 }, null).met, null);
});

test("the bundle block reports consistency across every run", () => {
  const same = mergeBundle([makeRun(), makeRun()]);
  assert.equal(same.version, 2026091300);
  assert.equal(same.contractOk, true);
  assert.equal(same.consistent, true);

  const mixed = mergeBundle([makeRun(), makeRun({ version: 2026091400, manifestSha256: "b".repeat(64) })]);
  assert.equal(mixed.consistent, false, "a publish landing mid-suite must be visible");

  const broken = mergeBundle([makeRun({ contractOk: false })]);
  assert.equal(broken.contractOk, false);
  assert.equal(broken.failedStep, 13);
});

test("compile numbers come from one run because both modes compile the same bundle", () => {
  const compile = mergeCompile([makeRun({ compileFailed: 1 })]);
  assert.equal(compile.buckets, 3);
  assert.equal(compile.failed, 1);
  assert.deepEqual(compile.failedIds, ["janus.net.ads.00"]);
  assert.equal(compile.medianMs, 2210);
  assert.equal(compile.ruleCountTotal, 133_427);
  assert.equal(compile.slowest[0].id, "janus.net.ads.00");
  assert.match(compile.note, /Relative cost only/);
  assert.equal(mergeCompile([{}]), null);
});

test("the gate passes only when it blocked, showed nothing, loaded and the SPI fired", () => {
  const gateScenario = scenarioStub({
    id: "selftest-local",
    gate: true,
    stable: true,
    url: "fixture:/selftest.html",
    payload: { expect: { blockedMin: 1, domVisibleMax: 0, allowedMustLoad: true } },
  });

  const passing = mergeGate(
    mergeScenario({
      scenario: gateScenario,
      results: [
        okResult("selftest-local", "blocked", 1, makeRun({ blocked: 1, visible: 0, observed: 3 })),
        okResult("selftest-local", "none", 1, makeRun({ blocked: 0, visible: 1, observed: 4 })),
      ],
    }),
  );
  assert.equal(passing.passed, true);
  assert.equal(passing.blocked, 1);
  assert.equal(passing.domVisible, 0);
  assert.equal(passing.spiFired, true);
  assert.equal(passing.blockedInModeNone, 0);

  const noBlocking = mergeGate(
    mergeScenario({
      scenario: gateScenario,
      results: [okResult("selftest-local", "blocked", 1, makeRun({ blocked: 0, visible: 1 }))],
    }),
  );
  assert.equal(noBlocking.passed, false, "0 blocked on the fixture means the harness is not measuring");

  const noSpi = mergeGate(
    mergeScenario({
      scenario: gateScenario,
      results: [okResult("selftest-local", "blocked", 1, makeRun({ blocked: 1, visible: 0, spi: null }))],
    }),
  );
  assert.equal(noSpi.passed, null, "an unknown SPI is not a pass");
});

test("the report totals, viewport and strict violations", () => {
  const rows = [
    mergeScenario({
      scenario: scenarioStub({ id: "canyoublockit-extreme", stable: true, payload: { expect: { blockedMin: 20 } } }),
      results: [
        okResult("canyoublockit-extreme", "blocked", 1, makeRun({ blocked: 41, visible: 0, popupsNative: 0 })),
        okResult("canyoublockit-extreme", "none", 1, makeRun({ blocked: 0, visible: 18, popupsNative: 3 })),
      ],
    }),
    mergeScenario({
      scenario: scenarioStub({ id: "gofile-file", status: "skipped", reason: "unconfigured" }),
      results: [],
    }),
    mergeScenario({
      scenario: scenarioStub({ id: "reddit-popular" }),
      results: [failedResult("reddit-popular", "blocked", 1, "timeout", "no DONE sentinel")],
    }),
  ];

  const report = buildReport({
    runId: "20260915051022-a3f1",
    startedAt: "2026-09-15T05:10:22Z",
    endedAt: "2026-09-15T05:31:48Z",
    environment: { runtime: "26.4", deviceType: "iPhone 16 Pro Max" },
    ci: null,
    rows,
    runJsons: [makeRun()],
    harness: { ok: true, failures: [], warnings: [], skipped: [] },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.durationMs, 1_286_000);
  assert.deepEqual(report.environment.viewport, { width: 440, height: 956, scale: 3 });
  assert.equal(report.totals.scenariosRun, 2, "a skipped scenario was not run");
  assert.equal(report.totals.scenariosOk, 1);
  assert.equal(report.totals.scenariosFailed, 1);
  assert.equal(report.totals.scenariosSkipped, 1);
  assert.equal(report.totals.requestsBlocked, 41);
  assert.equal(report.totals.adElementsVisibleBlocked, 0);
  assert.equal(report.totals.adElementsVisibleNone, 18);
  assert.equal(report.totals.popupsNativeNone, 3);
  assert.equal(report.harness.ok, true, "a scenario failure never flips harness.ok");

  assert.deepEqual(strictViolations(rows), [], "an expectation that was met is not a violation");
  const missed = mergeScenario({
    scenario: scenarioStub({ id: "canyoublockit-extreme", stable: true, payload: { expect: { blockedMin: 99 } } }),
    results: [okResult("canyoublockit-extreme", "blocked", 1, makeRun({ blocked: 41 }))],
  });
  assert.equal(strictViolations([missed]).length, 1);
  assert.equal(strictViolations([{ ...missed, stable: false }]).length, 0, "only stable scenarios gate");
});

test("the CI context is the public GitHub Actions fields, and absent off CI", () => {
  assert.equal(ciContext({}), null);
  const ci = ciContext({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "mioutic/janus-filters",
    GITHUB_WORKFLOW: "live",
    GITHUB_RUN_ID: "1234567890",
    GITHUB_RUN_NUMBER: "42",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "schedule",
  });
  assert.equal(ci.provider, "github-actions");
  assert.equal(ci.repository, "mioutic/janus-filters");
  assert.equal(ci.runNumber, 42);
  assert.equal(ci.event, "schedule");
  assert.equal(viewportFrom([{}]), null);
});
