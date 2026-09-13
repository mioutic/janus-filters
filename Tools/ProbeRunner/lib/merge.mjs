// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every run.json into one report.json (docs/probehost/03-report.md section 2).
//
// Three rules this module exists to keep:
//   1. `null` means "not measured" and `0` means "measured, and it was zero".
//      A field the harness could not observe is null or absent, never zero.
//   2. A delta needs both halves. blocked minus none, computed only when both
//      modes produced a result; otherwise null, because a fabricated delta is
//      worse than no delta.
//   3. Across repeats the merge takes the median, not the mean: one challenged
//      load or one slow CDN must not move the number, and every contributing
//      run.json path stays in runs[] so the raw data is one hop away.

export const REPORT_SCHEMA_VERSION = 1;

/** The delta fields of 03-report.md section 2, in the order the summary reads them. */
export const DELTA_FIELDS = [
  "requestsBlocked",
  "requestsObserved",
  "thirdPartyHosts",
  "transferBytesLowerBound",
  "adElementsVisible",
  "overlays",
  "popupsNative",
  "dialogs",
  "consoleErrors",
  "loadMs",
];

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value) => (typeof value === "boolean" ? value : null);

/** Median of the values that exist; null when none do. Even counts take the mean of the middle pair. */
export function median(values) {
  const present = (values ?? []).map(num).filter((value) => value !== null);
  if (present.length === 0) return null;
  const sorted = [...present].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Sum of the values that exist; null when none do. */
export function sumOrNull(values) {
  const present = (values ?? []).map(num).filter((value) => value !== null);
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0);
}

/** The numbers one run.json contributes. Anything absent stays null. */
export function modeNumbersFromRun(run) {
  const overlays = Array.isArray(run?.overlays) ? run.overlays : null;
  // WebKit calls the rule-list action delegate once per matching list per load, and the
  // bundle is ~59 overlapping shards, so blocked.total counts actions, not requests.
  // The headline uses blocked.distinctUrls - distinct query-stripped URLs whose load was
  // actually stopped - and keeps the action count beside it under its own name.
  const distinct = num(run?.blocked?.distinctUrls);
  // overlaysSummary.seen counts every overlay that met the threshold; the array is a
  // capped sample, so its length made 25 overlays and 10 overlays look identical.
  const overlaysSeen = num(run?.overlaysSummary?.seen);
  return {
    requestsObserved: num(run?.requests?.observed),
    requestsBlocked: distinct ?? num(run?.blocked?.total),
    ruleListActions: num(run?.blocked?.total),
    thirdPartyHosts: num(run?.requests?.thirdPartyHosts),
    transferBytesLowerBound: num(run?.requests?.transferBytesLowerBound),
    // unique* de-duplicates elements that matched several of the @common selectors and
    // discounts frames the page itself has hidden; the per-selector sums stay available.
    adElementsMatched: num(run?.dom?.uniqueMatched) ?? num(run?.dom?.totalMatched),
    adElementsVisible: num(run?.dom?.uniqueVisible) ?? num(run?.dom?.totalVisible),
    adElementsVisibleBySelector: num(run?.dom?.totalVisible),
    overlays: overlaysSeen ?? (overlays ? overlays.length : null),
    largestOverlayFraction: overlays
      ? overlays.reduce((max, entry) => Math.max(max, num(entry?.areaFraction) ?? 0), 0)
      : null,
    popupsNative: num(run?.popups?.nativeCount),
    popupsJs: num(run?.popups?.jsCount),
    dialogs: Array.isArray(run?.dialogs) ? run.dialogs.length : null,
    consoleErrors: num(run?.consoleErrors),
    loadMs: num(run?.navigation?.loadMs),
    didFinish: bool(run?.navigation?.didFinish),
  };
}

const NUMERIC_FIELDS = Object.keys(modeNumbersFromRun({})).filter((key) => key !== "didFinish");

/**
 * A run the app itself says is incomplete: it stopped for its own budget, a phase timed
 * out, or it exited non-ok. Its partial counts must not be averaged in beside a complete
 * repeat, and the reader must be told when every repeat was like this.
 */
export function runIsComplete(run) {
  if (!run) return false;
  if (run.harness?.status && run.harness.status !== "ok") return false;
  const timeouts = run.harness?.timeouts ?? run.timeouts;
  if (Array.isArray(timeouts) && timeouts.length > 0) return false;
  return true;
}

/**
 * One mode, merged across repeats.
 * @param {object[]} results work-item results for this mode that produced a run.json
 */
export function mergeMode(results) {
  const all = results.filter((result) => result?.runJson);
  if (all.length === 0) return null;

  // A run the app calls incomplete contributes partial counts. Drop those from the
  // median whenever a complete repeat exists; when every repeat was incomplete, keep
  // them and say so, because dropping them all would report nothing at all.
  const complete = all.filter((result) => runIsComplete(result.runJson));
  const usable = complete.length > 0 ? complete : all;
  const excluded = all.length - usable.length;

  const perRun = usable.map((result) => modeNumbersFromRun(result.runJson));
  const merged = {};
  for (const field of NUMERIC_FIELDS) merged[field] = median(perRun.map((entry) => entry[field]));

  // The representative run supplies everything that is not a number to take a median
  // of: the breakdown maps, the screenshots and the page state. With an even number of
  // repeats the median can be the mean of two values and match no run, so this is the
  // run *nearest* the median rather than an exact match - the old findIndex returned -1
  // there and silently fell back to run 0, whose count differed from the headline.
  const targetBlocked = merged.requestsBlocked;
  let representativeIndex = usable.length - 1;
  let representativeIsMedian = false;
  if (targetBlocked !== null) {
    let bestDistance = Infinity;
    perRun.forEach((entry, index) => {
      const value = num(entry.requestsBlocked);
      if (value === null) return;
      const distance = Math.abs(value - targetBlocked);
      if (distance < bestDistance) {
        bestDistance = distance;
        representativeIndex = index;
      }
    });
    representativeIsMedian = bestDistance === 0;
  }
  const representative = usable[representativeIndex];
  const run = representative.runJson;

  return {
    runs: usable.map((result) => `${result.dir}/run.json`),
    representative: `${representative.dir}/run.json`,
    representativeIsMedian,
    repeats: usable.length,
    repeatsExcludedIncomplete: excluded,
    complete: complete.length > 0,
    ...merged,
    didFinish: bool(run?.navigation?.didFinish),
    pageState: run?.pageState?.state ?? null,
    blockedByFamily: run?.blocked?.byFamily ?? null,
    blockedByAction: run?.blocked?.byAction ?? null,
    blockedByHost: run?.blocked?.byHost ?? null,
    requestsByType: run?.requests?.byType ?? null,
    requestsTruncated: bool(run?.requests?.truncated),
    overlaysTruncated: bool(run?.overlaysSummary?.truncated),
    // Two facts, deliberately separate: selectorPresent is "this WebKit still declares
    // the callback" (true in mode none too), fired is "something matched in this run".
    spiSelectorPresent: bool(run?.blocked?.spi?.selectorPresent),
    spiFired: bool(run?.blocked?.spi?.fired) ?? bool(run?.blocked?.spi?.available),
    // css-display-none fires no rule-list action, so byFamily can never contain a
    // cos.* family and the blocked count is a lower bound on what the lists did.
    spiCoversCosmetic: bool(run?.blocked?.spi?.coversCosmetic) ?? false,
    fixtureAllowedReachedServer: bool(run?.fixture?.allowedRequestReachedServer),
    fixtureBlockedReachedServer: bool(run?.fixture?.blockedRequestReachedServer),
    fixturePageAllowed: bool(run?.fixture?.page?.allowed),
    tap: run?.tap ? { requested: bool(run.tap.requested), performed: bool(run.tap.performed), trusted: bool(run.tap.trusted), method: run.tap.method ?? null } : null,
    harnessStatus: run?.harness?.status ?? null,
    exitCode: num(run?.harness?.exitCode),
    screenshots: Array.isArray(run?.screenshots)
      ? run.screenshots.filter((shot) => shot?.file).map((shot) => `${representative.dir}/${shot.file}`)
      : [],
  };
}

/** blocked − none, per field, and only where both sides were measured. */
export function computeDelta(blocked, none) {
  if (!blocked || !none) return null;
  const delta = {};
  for (const field of DELTA_FIELDS) {
    const left = num(blocked[field]);
    const right = num(none[field]);
    if (left === null || right === null) continue;
    delta[field] = left - right;
  }
  return Object.keys(delta).length > 0 ? delta : null;
}

/** Cheap, named observations a reader should not have to derive (03-report.md section 2.1). */
export function scenarioFlags({ modes, runs = [] }) {
  const flags = [];
  const blocked = modes.blocked;
  const none = modes.none;

  if (none && num(none.requestsBlocked) !== null && none.requestsBlocked > 0) {
    flags.push("mode-none-blocked-nonzero");
  }
  if (blocked?.pageState && none?.pageState && blocked.pageState !== none.pageState) {
    flags.push("page-state-disagree");
  }
  if (blocked && blocked.requestsBlocked === 0 && num(blocked.adElementsVisible) > 0) {
    flags.push("zero-blocked-but-ads-visible");
  }
  if (
    blocked &&
    none &&
    num(blocked.consoleErrors) !== null &&
    num(none.consoleErrors) !== null &&
    blocked.consoleErrors > none.consoleErrors
  ) {
    flags.push("console-errors-higher-in-blocked");
  }
  if (
    blocked &&
    none &&
    num(blocked.overlays) !== null &&
    num(none.overlays) !== null &&
    blocked.overlays > none.overlays
  ) {
    flags.push("overlay-appeared-in-blocked");
  }
  if (runs.some((run) => num(run?.compile?.failed) > 0)) flags.push("compile-failure");
  if (runs.some((run) => run?.requests?.truncated === true)) flags.push("truncated-requests");
  // The app's own verdict on its run. A run that hit its budget mid-scroll, or whose
  // load phase timed out, used to be printed exactly like a complete one as long as
  // pageState had already resolved to ok.
  if (runs.length > 0 && runs.some((run) => !runIsComplete(run))) flags.push("partial-run");
  if (blocked?.overlaysTruncated === true || none?.overlaysTruncated === true) {
    flags.push("overlays-truncated");
  }
  if (blocked?.spiSelectorPresent === false) flags.push("spi-selector-absent");
  return flags;
}

/**
 * `expect` is advisory except under --strict, and even then only for stable
 * scenarios. `met` is null when the number an expectation needs was not measured:
 * an unmet expectation and an unmeasured one are different facts.
 */
export function evaluateExpect(expect, blocked) {
  if (!expect) return { declared: null, met: null, misses: [] };
  if (!blocked) return { declared: expect, met: null, misses: [], reason: "mode blocked produced no run" };
  // A bot wall, a login wall or a consent gate is not a filter regression: the page
  // under test was never served, so the expectation is unmeasurable rather than missed.
  // Under --strict this is the difference between a red job and an honest one.
  if (blocked.pageState && blocked.pageState !== "ok") {
    return { declared: expect, met: null, misses: [], reason: `page state ${blocked.pageState}` };
  }
  const misses = [];
  let measurable = true;

  const check = (key, value, ok, describe) => {
    if (value === null) {
      measurable = false;
      return;
    }
    if (!ok) misses.push(describe);
  };

  if (expect.blockedMin !== undefined) {
    const value = num(blocked.requestsBlocked);
    check("blockedMin", value, value >= expect.blockedMin, `blocked ${value} < blockedMin ${expect.blockedMin}`);
  }
  if (expect.domVisibleMax !== undefined) {
    const value = num(blocked.adElementsVisible);
    check(
      "domVisibleMax",
      value,
      value <= expect.domVisibleMax,
      `ad elements visible ${value} > domVisibleMax ${expect.domVisibleMax}`,
    );
  }
  if (expect.popupsNativeMax !== undefined) {
    const value = num(blocked.popupsNative);
    check(
      "popupsNativeMax",
      value,
      value <= expect.popupsNativeMax,
      `native popups ${value} > popupsNativeMax ${expect.popupsNativeMax}`,
    );
  }
  if (expect.overlaysMax !== undefined) {
    const value = num(blocked.overlays);
    check("overlaysMax", value, value <= expect.overlaysMax, `overlays ${value} > overlaysMax ${expect.overlaysMax}`);
  }
  if (expect.allowedMustLoad === true) {
    // The control request, not the document: fixture.allowedRequestReachedServer and the
    // page's own flag say whether /allowed.js got through, and didFinish is the fallback
    // only for a scenario with no fixture block.
    const value = allowedControlLoaded(blocked);
    if (value === null) measurable = false;
    else if (value !== true) misses.push("the allowed control request did not load");
  }

  if (!measurable && misses.length === 0) return { declared: expect, met: null, misses: [] };
  return { declared: expect, met: misses.length === 0, misses };
}

/** One scenario row of report.scenarios[]. */
export function mergeScenario({ scenario, results, modes = ["blocked", "none"] }) {
  if (scenario.status === "skipped") {
    return {
      id: scenario.id,
      title: scenario.title,
      url: scenario.url,
      stable: scenario.stable === true,
      status: "skipped",
      reason: scenario.reason,
      attempts: 0,
      repeats: 0,
      pageState: { blocked: null, none: null, agree: null },
      modes: { blocked: null, none: null },
      delta: null,
      expect: { declared: scenario.payload?.expect ?? null, met: null },
      flags: [],
      evidence: [],
    };
  }

  const byMode = {};
  for (const mode of modes) {
    // The last successful attempt of each repeat supplies that repeat's numbers.
    const perRepeat = new Map();
    for (const result of results) {
      if (result.mode !== mode || result.status !== "ok" || !result.runJson) continue;
      perRepeat.set(result.repeat, result);
    }
    byMode[mode] = mergeMode([...perRepeat.values()]);
  }

  const failures = results.filter((result) => result.status !== "ok");
  const runJsons = results.filter((result) => result.runJson).map((result) => result.runJson);
  const attempts = results.reduce((max, result) => Math.max(max, result.attempt ?? 1), 0);
  const repeats = new Set(results.map((result) => result.repeat)).size;

  let status = "ok";
  let reason = null;
  if (failures.length > 0) {
    const worst =
      failures.find((result) => result.status === "timeout") ??
      failures.find((result) => result.status === "unparseable") ??
      failures[0];
    status = worst.status === "missing" ? "harness-failed" : worst.status;
    reason = `${worst.runId}: ${worst.reason ?? worst.status}`;
  }

  const modesOut = { blocked: byMode.blocked ?? null, none: byMode.none ?? null };
  const pageState = {
    blocked: modesOut.blocked?.pageState ?? null,
    none: modesOut.none?.pageState ?? null,
    agree:
      modesOut.blocked?.pageState && modesOut.none?.pageState
        ? modesOut.blocked.pageState === modesOut.none.pageState
        : null,
  };

  const expectResult = evaluateExpect(scenario.payload?.expect ?? null, modesOut.blocked);

  return {
    id: scenario.id,
    title: scenario.title,
    url: scenario.url,
    stable: scenario.stable === true,
    gate: scenario.gate === true,
    status,
    reason,
    attempts,
    repeats,
    pageState,
    modes: modesOut,
    delta: computeDelta(modesOut.blocked, modesOut.none),
    expect: { declared: expectResult.declared, met: expectResult.met, misses: expectResult.misses },
    flags: scenarioFlags({ modes: modesOut, runs: runJsons }),
    evidence: failures.flatMap((result) => (result.files ?? []).map((file) => `${result.dir}/${file}`)),
  };
}

/** The bundle every run saw, and whether they all saw the same one. */
export function mergeBundle(runJsons) {
  const withBundle = runJsons.filter((run) => run?.bundle);
  if (withBundle.length === 0) return null;
  const first = withBundle[0].bundle;
  const versions = new Set(withBundle.map((run) => run.bundle?.version ?? null));
  const hashes = new Set(withBundle.map((run) => run.bundle?.manifestSha256 ?? null));
  const contractOk = runJsons.filter((run) => run?.contract).every((run) => run.contract.ok === true);
  const failed = runJsons.find((run) => run?.contract && run.contract.ok !== true);
  return {
    source: first.source ?? null,
    origin: first.origin ?? null,
    version: first.version ?? null,
    layoutVersion: first.layoutVersion ?? null,
    issuedAt: first.issuedAt ?? null,
    ageHours: num(first.ageHours),
    keyId: first.keyId ?? null,
    contractVersion: first.contractVersion ?? null,
    flavour: first.flavour ?? null,
    manifestSha256: first.manifestSha256 ?? null,
    contractOk: runJsons.some((run) => run?.contract) ? contractOk : null,
    failedStep: failed?.contract?.failedStep ?? null,
    failureReason: failed?.contract?.failureReason ?? null,
    // False when a filters publish landed mid-suite: the comparison is then
    // across two bundles, and the summary says so loudly.
    consistent: versions.size <= 1 && hashes.size <= 1,
  };
}

/**
 * Compile numbers are identical between modes by construction (the bundle is
 * fetched, verified and compiled in mode none too), so one run supplies them.
 */
export function mergeCompile(runJsons) {
  // A run that actually compiled: mode none downloads and verifies the payloads but
  // hands none of them to WebKit, so its buckets carry no compileMs at all.
  const candidate =
    runJsons.find(
      (run) =>
        Array.isArray(run?.compile?.buckets) &&
        run.compile.buckets.some((bucket) => bucket?.compiled !== false),
    ) ?? runJsons.find((run) => Array.isArray(run?.compile?.buckets) && run.compile.buckets.length > 0) ?? null;
  if (!candidate) return null;
  // The gate's blocked run is usually the first with buckets, and it compiles an extra
  // synthetic probe.selftest.local list. Counting it in the header's bucket and rule
  // totals would describe a bundle nobody published.
  const buckets = candidate.compile.buckets.filter((bucket) => bucket?.synthetic !== true);
  const syntheticBuckets = candidate.compile.buckets.length - buckets.length;
  const failedIds = buckets.filter((bucket) => bucket?.ok === false).map((bucket) => bucket.id);
  const slowest = [...buckets]
    .filter((bucket) => num(bucket?.compileMs) !== null)
    .sort((a, b) => b.compileMs - a.compileMs)
    .slice(0, 3)
    .map((bucket) => ({ id: bucket.id, compileMs: bucket.compileMs, ruleCount: num(bucket.ruleCount) }));
  return {
    buckets: buckets.length,
    syntheticBuckets,
    attached: buckets.filter((bucket) => bucket?.attached === true).length,
    failed: failedIds.length,
    failedIds,
    totalMs: num(candidate.compile.totalMs),
    medianMs: median(buckets.map((bucket) => bucket.compileMs)),
    slowest,
    ruleCountTotal: sumOrNull(buckets.map((bucket) => bucket.ruleCount)),
    note: "Simulator timings on a virtualised runner. Relative cost only, never a phone estimate.",
  };
}

/**
 * The self-check. Without it, "0 requests blocked" on a live site is ambiguous
 * between "the filters did not block" and "the harness is not measuring"
 * (00-index.md section 1).
 */
export function mergeGate(row) {
  if (!row) return null;
  const blocked = row.modes?.blocked ?? null;
  const none = row.modes?.none ?? null;
  const spiFired = blocked ? blocked.spiFired : null;
  // The control request, from the fixture server's own hit counts rather than from
  // "the document finished loading". A rule set that over-blocked /allowed.js used to
  // pass this gate as long as the navigation finished - exactly the "the harness is not
  // measuring" case the gate exists to rule out. didFinish is the fallback only when
  // the run carries no fixture block at all.
  const allowedReached = blocked ? allowedControlLoaded(blocked) : null;
  const blockedReached = blocked ? blocked.fixtureBlockedReachedServer : null;
  const passed =
    row.status === "ok" &&
    row.expect?.met === true &&
    allowedReached === true &&
    blockedReached !== true &&
    spiFired === true
      ? true
      : row.status === "ok" && (row.expect?.met === null || spiFired === null || allowedReached === null)
        ? null
        : false;
  return {
    id: row.id,
    passed,
    blocked: blocked ? num(blocked.requestsBlocked) : null,
    ruleListActions: blocked ? num(blocked.ruleListActions) : null,
    blockedInModeNone: none ? num(none.requestsBlocked) : null,
    domVisible: blocked ? num(blocked.adElementsVisible) : null,
    allowedRequestReachedServer: allowedReached,
    blockedRequestReachedServer: blockedReached,
    navigationDidFinish: blocked ? bool(blocked.didFinish) : null,
    spiFired,
    spiSelectorPresent: blocked ? blocked.spiSelectorPresent : null,
    misses: row.expect?.misses ?? [],
  };
}

/**
 * Did the one URL that must load actually load? The fixture server's hit count and the
 * page's own flag are the evidence; a run without a fixture block falls back to "the
 * navigation finished", which is all there is for a live scenario.
 */
export function allowedControlLoaded(blocked) {
  if (!blocked) return null;
  const reached = bool(blocked.fixtureAllowedReachedServer);
  const pageFlag = bool(blocked.fixturePageAllowed);
  if (reached === null && pageFlag === null) return bool(blocked.didFinish);
  if (reached === false || pageFlag === false) return false;
  return reached === true || pageFlag === true;
}

/** The public GitHub Actions context. Repo variables are public; no secret is read. */
export function ciContext(env = process.env) {
  if (!env.GITHUB_ACTIONS) return null;
  return {
    provider: "github-actions",
    repository: env.GITHUB_REPOSITORY ?? null,
    workflow: env.GITHUB_WORKFLOW ?? null,
    runNumber: env.GITHUB_RUN_NUMBER ? Number(env.GITHUB_RUN_NUMBER) : null,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : null,
    sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    event: env.GITHUB_EVENT_NAME ?? null,
    runnerImage: env.ImageOS ?? null,
  };
}

/** The viewport is measured by the app; it is copied, never derived from a device name. */
export function viewportFrom(runJsons) {
  const found = runJsons.find((run) => run?.host?.viewport);
  return found ? found.host.viewport : null;
}

/** A row whose blocked-mode page really was the page under test. */
function rowIsClean(row) {
  const state = row.modes?.blocked?.pageState ?? null;
  return row.status === "ok" && (state === null || state === "ok");
}

function totalsFrom(rows) {
  const measured = rows.filter((row) => row.status !== "skipped");
  // Aggregates are computed over clean rows only. Summing a Cloudflare wall, a consent
  // gate and a real page produced one number that could be quoted as a blocking result
  // and was partly neither.
  const clean = measured.filter(rowIsClean);
  const modeValue = (row, mode, field) => row.modes?.[mode]?.[field] ?? null;
  return {
    scenariosRun: measured.length,
    scenariosClean: clean.length,
    scenariosWalled: measured.length - clean.length,
    totalsBasis: "clean rows only: status ok and blocked-mode pageState ok",
    scenariosOk: rows.filter((row) => row.status === "ok").length,
    scenariosFailed: rows.filter((row) => !["ok", "skipped"].includes(row.status)).length,
    scenariosSkipped: rows.filter((row) => row.status === "skipped").length,
    requestsBlocked: sumOrNull(clean.map((row) => modeValue(row, "blocked", "requestsBlocked"))),
    ruleListActions: sumOrNull(clean.map((row) => modeValue(row, "blocked", "ruleListActions"))),
    adElementsVisibleBlocked: sumOrNull(clean.map((row) => modeValue(row, "blocked", "adElementsVisible"))),
    adElementsVisibleNone: sumOrNull(clean.map((row) => modeValue(row, "none", "adElementsVisible"))),
    popupsNativeBlocked: sumOrNull(clean.map((row) => modeValue(row, "blocked", "popupsNative"))),
    popupsNativeNone: sumOrNull(clean.map((row) => modeValue(row, "none", "popupsNative"))),
  };
}

/**
 * The whole report. Takes already-merged scenario rows so that every number in it
 * came from a run.json field and nothing was parsed out of a log or a PNG.
 */
export function buildReport({
  suite = "scenario",
  runId,
  startedAt,
  endedAt,
  environment,
  ci = ciContext(),
  rows,
  runJsons = [],
  harness,
  order = null,
}) {
  const gateRow = rows.find((row) => row.gate === true) ?? null;
  const viewport = viewportFrom(runJsons);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite,
    runId,
    startedAt,
    endedAt,
    durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
    ci,
    environment: { ...environment, viewport: environment?.viewport ?? viewport },
    order,
    bundle: mergeBundle(runJsons),
    compile: mergeCompile(runJsons),
    gate: mergeGate(gateRow),
    scenarios: rows,
    totals: totalsFrom(rows),
    harness,
  };
}

/**
 * --strict: a stable scenario that declared an expectation and missed it.
 * A scenario whose expectation could not be evaluated is never a strict failure.
 */
export function strictViolations(rows) {
  return rows
    .filter((row) => row.stable === true && row.expect?.declared && row.expect.met === false)
    .map((row) => ({ scenario: row.id, misses: row.expect.misses ?? [] }));
}
