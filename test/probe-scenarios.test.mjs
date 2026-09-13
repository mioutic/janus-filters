// SPDX-License-Identifier: GPL-3.0-or-later
//
// config/scenarios.json and the runner's pure parts (docs/probehost/02-runner.md
// sections 3, 4, 5, 7 and 8). Everything here runs on ubuntu in seconds, so a bad
// scenario edit or a broken launch contract fails in the pull request instead of
// ten minutes into a macOS job.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { UsageError, parseArgs } from "../Tools/ProbeRunner/lib/args.mjs";
import {
  artifactDirFor,
  buildLaunchArgs,
  deadlineMsFor,
  retryItem,
  shouldRetry,
} from "../Tools/ProbeRunner/lib/launch.mjs";
import {
  BUILT_IN_DEFAULTS,
  buildWorkItems,
  checkUrl,
  expandSelectors,
  loadScenarioDoc,
  materialiseScenario,
  modeOrderForRepeat,
  selectScenarios,
  validateScenarioDoc,
} from "../Tools/ProbeRunner/lib/scenarios.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const SCENARIOS = path.join(ROOT, "config", "scenarios.json");

/**
 * Every host the live suite is allowed to touch. Adding a site is a review item
 * (02-runner.md section 3.2), and this list is what makes the reviewer look:
 * a new URL fails here until it is added deliberately, in the same change.
 */
const REVIEWED_HOSTS = new Set([
  "canyoublockit.com",
  "www.reddit.com",
  "old.reddit.com",
  "gofile.io",
  "www.dailymail.co.uk",
  "www.accuweather.com",
  "www.merriam-webster.com",
]);

const baseDoc = () => ({
  schemaVersion: 1,
  commonSelectors: [".ad-unit"],
  pageState: { challenged: { text: ["verify you are human"], selectors: [] } },
  scenarios: [
    {
      id: "selftest-local",
      title: "Gate",
      url: "fixture:/selftest.html",
      gate: true,
      stable: true,
      selectors: ["#ad-slot"],
      expect: { blockedMin: 1, domVisibleMax: 0, allowedMustLoad: true },
    },
    { id: "site-a", title: "Site A", url: "https://example.com/", selectors: ["@common"] },
  ],
});

function problemsOf(doc) {
  try {
    validateScenarioDoc(doc, { source: "test" });
    return null;
  } catch (error) {
    assert.ok(error instanceof UsageError, "validation must throw a UsageError (exit 2)");
    return error.details.problems ?? [];
  }
}

const hasProblem = (problems, fragment) => {
  assert.ok(Array.isArray(problems), `expected validation to fail for: ${fragment}`);
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem mentioning "${fragment}", got:\n  ${problems.join("\n  ")}`,
  );
};

test("the shipped config/scenarios.json is valid", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  assert.equal(doc.schemaVersion, 1);
  assert.ok(doc.scenarios.length >= 8, "M2c asks for reddit, old.reddit, gofile and three ad-heavy pages");
  assert.ok(doc.commonSelectors.length > 0);
});

test("every scenario URL is https or a fixture, on a reviewed host, with no credentials", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  for (const scenario of doc.scenarios) {
    if (!scenario.url) {
      assert.ok(scenario.urlFrom, `${scenario.id} needs url or urlFrom`);
      assert.equal(scenario.optional, true, `${scenario.id} reads a variable and must be optional`);
      continue;
    }
    assert.deepEqual(checkUrl(scenario.url), { ok: true }, `${scenario.id}: ${scenario.url}`);
    if (scenario.url.startsWith("fixture:")) continue;
    const url = new URL(scenario.url);
    assert.ok(
      REVIEWED_HOSTS.has(url.hostname),
      `${url.hostname} is not in the reviewed host list; adding a site is a review item`,
    );
  }
});

test("ids are unique and the gate is hoisted to the front", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  const ids = doc.scenarios.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);

  const ordered = selectScenarios(doc, {});
  assert.equal(ordered[0].gate, true, "a gate scenario runs first");
  assert.equal(ordered[0].id, "selftest-local");
  assert.equal(ordered[0].url.startsWith("fixture:"), true, "the gate must not depend on the network");

  // --only never drops the gate: the suite must always prove it can measure.
  const restricted = selectScenarios(doc, { only: ["reddit-popular"] });
  assert.deepEqual(
    restricted.map((scenario) => scenario.id),
    ["selftest-local", "reddit-popular"],
  );
  assert.throws(() => selectScenarios(doc, { only: ["no-such-site"] }), UsageError);
});

test("the file carries no local path, address or non-https URL", async () => {
  const text = await readFile(SCENARIOS, "utf8");
  assert.ok(!/[A-Za-z]:\\/.test(text), "no Windows path");
  assert.ok(!/\/(Users|home)\//.test(text), "no home directory path");
  assert.ok(!/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), "no email address");
  assert.ok(!/http:\/\//.test(text), "no plaintext http URL");
});

test("@common expands once, in place, without duplicates", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  const scenario = doc.scenarios.find((entry) => entry.id === "reddit-popular");
  const expanded = expandSelectors(scenario.selectors, doc.commonSelectors);
  assert.ok(!expanded.includes("@common"), "the app receives a flat array");
  assert.equal(new Set(expanded).size, expanded.length, "no duplicate selectors");
  assert.ok(expanded.includes("shreddit-ad-post"));
  assert.ok(expanded.includes(doc.commonSelectors[0]));
});

test("defaults cascade: built-in, then file defaults, then the scenario", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  const gate = materialiseScenario(
    doc.scenarios.find((entry) => entry.id === "selftest-local"),
    doc,
    {},
  );
  assert.equal(gate.payload.waitIdleMs, 800, "the scenario wins");
  assert.equal(gate.payload.budgetMs, doc.defaults.budgetMs, "the file default applies");
  assert.equal(gate.payload.scroll.dy, doc.defaults.scroll.dy);
  assert.equal(gate.payload.screenshots, BUILT_IN_DEFAULTS.screenshots);
  assert.deepEqual(gate.payload.pageState, doc.pageState, "the matchers travel with the scenario");
});

test("urlFrom resolves from the environment, and an unset variable skips instead of failing", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  const scenario = doc.scenarios.find((entry) => entry.id === "gofile-file");

  const unset = materialiseScenario(scenario, doc, {});
  assert.equal(unset.status, "skipped");
  assert.match(unset.reason, /PROBE_GOFILE_URL/);

  const set = materialiseScenario(scenario, doc, { PROBE_GOFILE_URL: "https://gofile.io/d/abc123" });
  assert.equal(set.status, "ready");
  assert.equal(set.payload.url, "https://gofile.io/d/abc123");

  const bad = materialiseScenario(scenario, doc, { PROBE_GOFILE_URL: "http://gofile.io/d/abc123" });
  assert.equal(bad.status, "skipped");
  assert.match(bad.reason, /https/);
});

test("checkUrl refuses http, credentials, IP literals and junk", () => {
  assert.equal(checkUrl("https://example.com/").ok, true);
  assert.equal(checkUrl("fixture:/selftest.html").ok, true);
  assert.equal(checkUrl("http://example.com/").ok, false);
  assert.equal(checkUrl("https://user:pass@example.com/").ok, false);
  assert.equal(checkUrl("https://127.0.0.1/").ok, false);
  assert.equal(checkUrl("https://localhost/").ok, false);
  assert.equal(checkUrl("not a url").ok, false);
  assert.equal(checkUrl("fixture:/../../etc/passwd").ok, false);
});

test("the validator names every problem it finds", () => {
  hasProblem(problemsOf({ ...baseDoc(), schemaVersion: 2 }), "schemaVersion must be 1");

  const duplicate = baseDoc();
  duplicate.scenarios[1].id = "selftest-local";
  hasProblem(problemsOf(duplicate), "is a duplicate");

  const both = baseDoc();
  both.scenarios[1].urlFrom = "PROBE_X_URL";
  hasProblem(problemsOf(both), "exactly one of url or urlFrom");

  const neither = baseDoc();
  delete neither.scenarios[1].url;
  hasProblem(problemsOf(neither), "exactly one of url or urlFrom");

  const insecure = baseDoc();
  insecure.scenarios[1].url = "http://example.com/";
  hasProblem(problemsOf(insecure), "must be https");

  const unknownKey = baseDoc();
  unknownKey.scenarios[1].tapCenter = true; // a typo for tapCentre
  hasProblem(problemsOf(unknownKey), "tapCenter is unknown");

  const noSelectors = baseDoc();
  noSelectors.scenarios[1].selectors = [];
  hasProblem(problemsOf(noSelectors), "non-empty array of strings");

  const badExpect = baseDoc();
  badExpect.scenarios[1].expect = { blockedMax: 3 };
  hasProblem(problemsOf(badExpect), "expect.blockedMax is unknown");

  const outOfRange = baseDoc();
  outOfRange.scenarios[1].timeoutMs = 999_999;
  hasProblem(problemsOf(outOfRange), "timeoutMs must be a whole number");

  const optionalMissing = baseDoc();
  delete optionalMissing.scenarios[1].url;
  optionalMissing.scenarios[1].urlFrom = "PROBE_X_URL";
  hasProblem(problemsOf(optionalMissing), "must therefore be optional: true");

  const networkGate = baseDoc();
  networkGate.scenarios[0].url = "https://example.com/";
  hasProblem(problemsOf(networkGate), "must use a fixture: URL");

  const noGate = baseDoc();
  noGate.scenarios[0].gate = false;
  hasProblem(problemsOf(noGate), "no gate scenario");

  const reservedState = baseDoc();
  reservedState.pageState.ok = { text: ["hello"], selectors: [] };
  hasProblem(problemsOf(reservedState), "decided by the app");

  assert.equal(problemsOf(baseDoc()), null, "the base document is valid");
});

test("work items alternate the mode order and keep a scenario's modes adjacent", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  const materialised = selectScenarios(doc, { only: ["reddit-popular"] }).map((scenario) =>
    materialiseScenario(scenario, doc, {}),
  );
  const items = buildWorkItems(materialised, { repeats: 2, modes: ["blocked", "none"] });

  assert.equal(items.length, 2 * 2 * 2, "2 scenarios x 2 repeats x 2 modes");
  const first = items.filter((item) => item.scenarioId === items[0].scenarioId);
  assert.deepEqual(
    first.map((item) => `${item.mode}-${item.repeat}`),
    ["blocked-1", "none-1", "none-2", "blocked-2"],
    "the first scenario keeps repeat parity",
  );
  // reddit-popular is the second ready scenario, so its whole pair is reversed: at
  // repeats=1 the repeat parity flips nothing, and without the scenario index `blocked`
  // would be the cold first load in every single scheduled run.
  const reddit = items.filter((item) => item.scenarioId === "reddit-popular");
  assert.deepEqual(
    reddit.map((item) => `${item.mode}-${item.repeat}`),
    ["none-1", "blocked-1", "blocked-2", "none-2"],
  );
  assert.deepEqual(modeOrderForRepeat(["blocked", "none"], 1), ["blocked", "none"]);
  assert.deepEqual(modeOrderForRepeat(["blocked", "none"], 2), ["none", "blocked"]);
  assert.deepEqual(modeOrderForRepeat(["blocked", "none"], 1, 1), ["none", "blocked"]);
  assert.deepEqual(modeOrderForRepeat(["blocked", "none"], 2, 1), ["blocked", "none"]);
  assert.equal(first[0].runId, `${items[0].scenarioId}-blocked-1`);
  assert.deepEqual(first[0].order, ["blocked", "none"]);

  // The real shipped configuration: one repeat, and the order must not be constant.
  const single = buildWorkItems(materialised, { repeats: 1, modes: ["blocked", "none"] });
  const firstModes = single.filter((item) => item.repeat === 1).map((item) => item.order[0]);
  assert.equal(new Set(firstModes).size, 2, "at repeats=1 each mode goes first somewhere");
});

test("a skipped scenario produces no work item but is never dropped", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  const materialised = selectScenarios(doc, {}).map((scenario) => materialiseScenario(scenario, doc, {}));
  const skipped = materialised.find((scenario) => scenario.id === "gofile-file");
  assert.equal(skipped.status, "skipped");
  const items = buildWorkItems(materialised, { repeats: 1, modes: ["blocked", "none"] });
  assert.equal(
    items.some((item) => item.scenarioId === "gofile-file"),
    false,
  );
});

test("the launch contract argv is exactly what 01-probehost.md section 2.1 declares", async () => {
  const doc = await loadScenarioDoc(SCENARIOS);
  const scenario = materialiseScenario(
    doc.scenarios.find((entry) => entry.id === "selftest-local"),
    doc,
    {},
  );
  const [item] = buildWorkItems([scenario], { repeats: 1, modes: ["blocked"] });

  assert.deepEqual(buildLaunchArgs(item, {}), [
    "-ProbeSuite",
    "scenario",
    "-ProbeRunId",
    "selftest-local-blocked-1",
    "-ProbeMode",
    "blocked",
    "-ProbeScenario",
    "probe/in/scenario.json",
    "-ProbeOut",
    "probe/out/selftest-local-blocked-1",
    "-ProbeStepTimeoutMs",
    "15000",
    "-ProbeBudgetMs",
    "240000",
    "-ProbeScreenshots",
    "1",
  ]);

  const offline = buildLaunchArgs(item, { bundleDir: "build/bundle" });
  assert.ok(offline.includes("-ProbeBundleDir"));
  assert.equal(offline[offline.indexOf("-ProbeBundleDir") + 1], "probe/in/bundle");
  assert.ok(!offline.includes("-ProbeManifestUrl"), "the two are mutually exclusive");

  const network = buildLaunchArgs(item, { manifestUrl: "https://mioutic.github.io/janus-filters/latest/manifest.json" });
  assert.equal(
    network[network.indexOf("-ProbeManifestUrl") + 1],
    "https://mioutic.github.io/janus-filters/latest/manifest.json",
  );

  const spike = buildLaunchArgs({ suite: "spike", runId: "spike-26-4" }, {});
  assert.deepEqual(spike, ["-ProbeSuite", "spike", "-ProbeRunId", "spike-26-4", "-ProbeOut", "probe/out/spike-26-4"]);

  assert.equal(deadlineMsFor(item, {}), 240_000 + 45_000, "the runner deadline is the app budget plus slack");
  assert.equal(artifactDirFor(item), "selftest-local/blocked/1");
  assert.equal(artifactDirFor(retryItem(item)), "selftest-local/blocked/1/attempt-2");
  assert.equal(retryItem(item).runId, "selftest-local-blocked-1-r2");
});

test("retry exactly once, and only when the harness failed (section 7)", () => {
  const at = (status, exitCode = null, attempt = 1) => ({ status, exitCode, attempt });

  assert.equal(shouldRetry(at("timeout")), true);
  assert.equal(shouldRetry(at("missing")), true);
  assert.equal(shouldRetry(at("unparseable")), true);
  assert.equal(shouldRetry(at("harness-failed")), true);
  assert.equal(shouldRetry(at("ok", 70)), true, "70 internal");
  assert.equal(shouldRetry(at("ok", 75)), true, "75 tempfail");

  assert.equal(shouldRetry(at("ok", 0)), false, "a completed measurement is never retried");
  assert.equal(shouldRetry(at("ok", 64)), false, "64 usage is a runner bug and must fail loudly");
  assert.equal(shouldRetry(at("ok", 65)), false, "65 bundle must not be hidden by a second attempt");
  assert.equal(shouldRetry(at("ok", 73)), false, "73 cantcreate is a staging bug");
  assert.equal(shouldRetry(at("timeout", null, 2)), false, "exactly once");
});

test("the CLI defaults and refusals of section 8", () => {
  const opts = parseArgs(["--app", "build/ProbeHost.app", "--run-id", "t1"]);
  assert.equal(opts.suite, "scenario");
  assert.equal(opts.runtime, "newest");
  assert.equal(opts.repeats, 1);
  assert.deepEqual([...opts.modes], ["blocked", "none"]);
  assert.equal(opts.budgetMin, 30);
  assert.equal(opts.outDir, "build/probe/t1");
  assert.equal(opts.scenariosPath, "config/scenarios.json");
  assert.equal(opts.bundleId, "io.github.mioutic.probehost");
  assert.equal(opts.strict, false);

  const refusals = [
    [[], /--app is required/],
    [["--app", "x"], /must point at a \.app/],
    [["--app", "x.app", "--runtime", "all"], /spike suite only/],
    [["--app", "x.app", "--runtime", "nightly"], /newest, all, or a version/],
    [["--app", "x.app", "--modes", "blocked,everything"], /only blocked and none/],
    [["--app", "x.app", "--repeats", "0"], /between 1 and 20/],
    [["--app", "x.app", "--only", "Reddit Popular"], /invalid scenario id/],
    [["--app", "x.app", "--bundle-dir", "b", "--manifest-url", "https://github.com/mioutic/janus-filters/x"], /mutually exclusive/],
    [["--app", "x.app", "--manifest-url", "https://example.com/manifest.json"], /allowlist/],
    [["--app", "x.app", "--run-id", "../escape"], /run-id must match/],
    [["--typo"], /unknown option/],
  ];
  for (const [argv, pattern] of refusals) {
    assert.throws(() => parseArgs(argv), pattern, argv.join(" "));
    try {
      parseArgs(argv);
    } catch (error) {
      assert.equal(error.code, 2, "every usage refusal is exit 2");
    }
  }

  const spike = parseArgs(["--app", "x.app", "--suite", "spike", "--runtime", "all"]);
  assert.equal(spike.runtime, "all");
});
