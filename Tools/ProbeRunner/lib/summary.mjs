// SPDX-License-Identifier: GPL-3.0-or-later
//
// The job summary of docs/probehost/03-report.md section 3, and the spike matrix
// of docs/probehost/04-spike.md section 5.
//
// Input is a merged report object (report.json or spike-report.json) and nothing
// else: never a run.json, never a file on disk, never a number derived from a PNG
// or a log line. That is the seam of 00-index.md section 3 — the summary a human
// reads cannot disagree with the report the artifact carries, because it is a pure
// function of it.
//
// Two rules run through every renderer here:
//
//   * A number the harness did not observe is absent, not zero. Every cell goes
//     through `cell()`, which prints an em dash for null and undefined, and only
//     a real number is ever formatted.
//   * Bold marks relevance, not success. The blocked-request count and the
//     visible-ad count are bold because they are what M2c is about; a bad number
//     is bold in exactly the same way a good one is.

/** GitHub truncates a job summary above 1 MiB. Mirrored in VERSIONS.json budgets.probe. */
export const SUMMARY_MAX_BYTES = 1048576;

const DASH = "—";

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** Thousands separators without ICU: the output must not depend on the runner's locale. */
export function group(n) {
  if (!isNumber(n)) return DASH;
  const negative = n < 0;
  const [whole, fraction] = Math.abs(n).toString().split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/**
 * A duration in prose: whole milliseconds, or one decimal of a second above 10 s
 * (03-report.md section 3.5). The `Load ms` table column deliberately does not use
 * this — its header says ms and section 3.2 prints 14880 there literally.
 */
export function dur(ms) {
  if (!isNumber(ms)) return DASH;
  if (Math.abs(ms) >= 10000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/** A cell value: a number grouped, a string as it stands, anything absent an em dash. */
function cell(value) {
  if (value === null || value === undefined) return DASH;
  if (isNumber(value)) return group(value);
  return String(value);
}

/** `blocked / none`, with an em dash for a mode that produced no result. */
function pair(b, n, { strong = false } = {}) {
  const left = cell(b);
  const right = cell(n);
  const text = `${left} / ${right}`;
  return strong && (b !== null && b !== undefined) ? `**${text}**` : text;
}

/** Age of the bundle as a human reads it, or nothing at all when it was not recorded. */
function age(hours) {
  if (!isNumber(hours)) return "";
  if (hours < 24) return ` (${Math.round(hours)} h old)`;
  const days = Math.round(hours / 24);
  return ` (${days} ${days === 1 ? "day" : "days"} old)`;
}

/**
 * The `Load ms` column, in bare milliseconds and never grouped: its header says ms,
 * and 03-report.md section 3.2 prints 14880 there literally rather than 14.9 s.
 */
function pairMs(b, n) {
  const one = (v) => (isNumber(v) ? String(Math.round(v)) : DASH);
  return `${one(b)} / ${one(n)}`;
}

/** Markdown table cells may not contain a raw pipe or newline. */
function safe(text) {
  return String(text).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------------------
// per-scenario derivations
// ---------------------------------------------------------------------------

/**
 * What the State column says. `status` wins when the work item did not complete;
 * otherwise the page state, which is a single word when both modes agree and
 * `blocked/none` when they do not.
 */
export function stateOf(scenario) {
  if (!scenario) return DASH;
  if (scenario.status && scenario.status !== "ok") return scenario.status;
  const state = scenario.pageState ?? {};
  const b = state.blocked ?? null;
  const n = state.none ?? null;
  if (b && n) return b === n ? b : `${b}/${n}`;
  return b ?? n ?? "ok";
}

/** True when every number in the row is a measurement of blocking rather than of a wall. */
function rowIsClean(scenario) {
  const state = stateOf(scenario);
  return scenario?.status === "ok" && state === "ok";
}

/**
 * Popups attempted: native `window.open` requests WebKit handed to the UI delegate
 * plus the JavaScript-initiated ones the page script saw. Absent + absent stays
 * absent; one present is reported alone rather than silently counted as zero.
 */
function popups(mode) {
  if (!mode) return null;
  const parts = [mode.popupsNative, mode.popupsJs].filter(isNumber);
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

const modeOf = (scenario, name) => scenario?.modes?.[name] ?? null;

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

const FLAG_TEXT = {
  "mode-none-blocked-nonzero":
    "mode **none** reported blocked requests — the unfiltered control is not unfiltered, so this row is a harness bug, not a result.",
  "page-state-disagree":
    "the two modes saw different page states — a filtered page compared against a wall is not a measurement of blocking.",
  "zero-blocked-but-ads-visible":
    "nothing was blocked and ad elements were still visible — either no rule matched this site or the list did not attach.",
  "console-errors-higher-in-blocked":
    "more console errors with the rules attached than without — possible breakage caused by our own rules.",
  "overlay-appeared-in-blocked":
    "a large fixed overlay appeared only with the rules attached — possible anti-adblock.",
  "compile-failure": "at least one bucket failed to compile; the attached rule set was incomplete.",
  "truncated-requests": "the request log hit its cap, so request counts are a lower bound.",
  "partial-run":
    "at least one run stopped early (budget or a phase timeout), so its counts are partial — read the row as a lower bound.",
  "overlays-truncated":
    "more overlays met the threshold than were kept in the sample; the overlay counts come from `overlaysSummary.seen`, the list is a sample.",
  "spi-selector-absent":
    "this WebKit did not declare the rule-list action callback — the blocked count is not measurable on this runtime, whatever it reads.",
};

function flagLines(report) {
  const lines = [];
  if (report.bundle && report.bundle.consistent === false) {
    lines.push(
      "- **The bundle changed mid-suite.** Runs saw more than one bundle version or manifest hash, so scenarios in this report are not all comparable with each other.",
    );
  }
  for (const scenario of report.scenarios ?? []) {
    for (const flag of scenario.flags ?? []) {
      const text = FLAG_TEXT[flag];
      lines.push(`- \`${safe(scenario.id)}\`: ${text ?? `\`${safe(flag)}\``}`);
    }
    const state = stateOf(scenario);
    if (scenario.status === "ok" && state !== "ok" && !(scenario.flags ?? []).includes("page-state-disagree")) {
      lines.push(
        `- \`${safe(scenario.id)}\`: page state **${safe(state)}** — a datacentre IP reaching a wall, not a blocking result.`,
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// the scenario suite
// ---------------------------------------------------------------------------

function header(report) {
  const bundle = report.bundle ?? {};
  const env = report.environment ?? {};
  const compile = report.compile ?? {};
  const gate = report.gate ?? {};
  const out = [];

  const contractFailed = bundle.contractOk === false;
  const gateFailed = gate.passed === false;
  if (contractFailed || gateFailed) {
    const step = bundle.contractFailure?.step ?? bundle.contractStep ?? null;
    const reason =
      bundle.contractFailure?.reason ??
      bundle.contractReason ??
      gate.reason ??
      (report.harness?.failures ?? []).map((f) => f.reason).find(Boolean) ??
      "no reason recorded in report.json";
    const what = contractFailed
      ? `contract verification failed${isNumber(step) ? ` at step ${step}` : ""}`
      : "the harness self-check failed";
    out.push(`**FAILED** — ${what}: ${safe(reason)}. Every number below is unsafe to read as a blocking result.`, "");
  }

  const version = bundle.version ?? null;
  out.push(`## Live blocking suite${version ? ` — bundle ${version}${age(bundle.ageHours)}` : ""}`, "");

  const facts = [];
  const shape = [];
  if (bundle.flavour) shape.push(`**${safe(bundle.flavour)}**`);
  if (isNumber(compile.buckets)) shape.push(`${group(compile.buckets)} buckets`);
  if (isNumber(compile.ruleCountTotal)) shape.push(`${group(compile.ruleCountTotal)} rules`);
  if (isNumber(compile.totalMs)) shape.push(`compiled in ${dur(compile.totalMs)}`);
  if (shape.length > 0) facts.push(shape.join(", "));
  if (env.runtime) {
    facts.push(`runtime **iOS ${safe(env.runtime)}**${env.deviceType ? ` on **${safe(env.deviceType)}**` : ""}`);
  } else if (env.deviceType) {
    facts.push(`**${safe(env.deviceType)}**`);
  }
  if (env.xcode) facts.push(`Xcode ${safe(env.xcode)}`);
  if (env.egress?.mode) {
    const where = env.egress.datacentre === true ? " (datacentre)" : env.egress.datacentre === false ? " (residential)" : "";
    facts.push(`egress **${safe(env.egress.mode)}${where}**`);
  }
  const repeats = report.scenarios?.[0]?.repeats ?? report.repeats ?? null;
  if (isNumber(repeats)) facts.push(`${repeats} repeat${repeats === 1 ? "" : "s"}`);
  if (facts.length > 0) out.push(facts.join(" · "), "");

  const gateWord = gate.passed === true ? "**passed**" : gate.passed === false ? "**FAILED**" : "**not run**";
  const contractWord =
    bundle.contractOk === true ? "**passed**" : bundle.contractOk === false ? "**FAILED**" : "**not recorded**";
  const totals = report.totals ?? {};
  const ran = totals.scenariosRun ?? (report.scenarios ?? []).length;
  const measured = totals.scenariosOk ?? (report.scenarios ?? []).filter((s) => s.status === "ok").length;
  out.push(
    `Harness self-check ${gateWord} · contract verification ${contractWord} · ${measured}/${ran} scenarios measured`,
  );
  return out.join("\n");
}

function scenarioTable(report) {
  const rows = [
    "| Scenario | State | Blocked | Requests b/n | Ads visible b/n | Popups b/n | Overlays b/n | Load ms b/n |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  const scenarios = report.scenarios ?? [];
  for (const scenario of scenarios) {
    const b = modeOf(scenario, "blocked");
    const n = modeOf(scenario, "none");
    const clean = rowIsClean(scenario);
    const blocked = b?.requestsBlocked ?? null;
    rows.push(
      `| ${[
        safe(scenario.id ?? DASH),
        safe(stateOf(scenario)),
        blocked === null ? DASH : clean ? `**${group(blocked)}**` : group(blocked),
        pair(b?.requestsObserved ?? null, n?.requestsObserved ?? null),
        pair(b?.adElementsVisible ?? null, n?.adElementsVisible ?? null, { strong: clean }),
        pair(popups(b), popups(n)),
        pair(b?.overlays ?? null, n?.overlays ?? null),
        pairMs(b?.loadMs ?? null, n?.loadMs ?? null),
      ].join(" | ")} |`,
    );
  }
  if (scenarios.length === 0) {
    rows.push(`| ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`);
  }
  rows.push(
    "",
    "`b/n` = mode **blocked** / mode **none**. Bold = the number M2c is about. `Blocked` is the",
    "count of distinct URLs the rule-list action callback reported as blocked in mode blocked;",
    "it is a lower bound, because cosmetic hides are never reported to the app. Popups are",
    "native plus JavaScript-opened windows **attempted** after a synthetic tap, which is",
    "indicative only: see `docs/PROBEHOST.md`.",
  );
  return rows.join("\n");
}

function notMeasured(report) {
  const rows = [];
  const seen = new Set();
  for (const scenario of report.scenarios ?? []) {
    if (!scenario.status || scenario.status === "ok") continue;
    seen.add(scenario.id);
    const evidence = (scenario.evidence ?? []).map((e) => e.split("/").pop()).join(", ");
    rows.push(
      `| ${safe(scenario.id ?? DASH)} | ${safe(scenario.status)} | ${safe(scenario.reason ?? DASH)} | ${evidence ? safe(evidence) : DASH} |`,
    );
  }
  const harness = report.harness ?? {};
  for (const [list, status] of [
    [harness.skipped ?? [], "skipped"],
    [harness.failures ?? [], "harness-failed"],
  ]) {
    for (const entry of list) {
      if (!entry?.scenario || seen.has(entry.scenario)) continue;
      rows.push(`| ${safe(entry.scenario)} | ${status} | ${safe(entry.reason ?? DASH)} | ${DASH} |`);
    }
  }

  const out = ["### Not measured", ""];
  if (rows.length === 0) {
    // Always present, even when empty: an absent section reads as a claim that
    // nothing went wrong, which the summary is not entitled to make.
    out.push("Every scenario in the suite produced a measurement in both modes.");
    return out.join("\n");
  }
  out.push("| Scenario | Status | Reason | Evidence |", "|---|---|---|---|", ...rows);
  return out.join("\n");
}

function compileSection(report) {
  const compile = report.compile ?? {};
  if (!isNumber(compile.buckets) && !isNumber(compile.totalMs)) return "";
  const out = ["### Compile", ""];
  const bits = [];
  if (isNumber(compile.buckets)) bits.push(`${group(compile.buckets)} buckets`);
  if (isNumber(compile.failed)) bits.push(`${group(compile.failed)} failure${compile.failed === 1 ? "" : "s"}`);
  if (isNumber(compile.totalMs)) bits.push(`${dur(compile.totalMs)} total`);
  if (isNumber(compile.medianMs)) bits.push(`median ${dur(compile.medianMs)}`);
  out.push(`${bits.join(", ")}.`);
  const slowest = (compile.slowest ?? [])
    .slice(0, 3)
    .map((s) => `${safe(s.id)} ${dur(s.compileMs)}${isNumber(s.ruleCount) ? ` (${group(s.ruleCount)} rules)` : ""}`);
  if (slowest.length > 0) out.push(`Slowest: ${slowest.join(", ")}.`);
  if ((compile.failedIds ?? []).length > 0) {
    out.push(`Failed to compile: ${compile.failedIds.map((id) => `\`${safe(id)}\``).join(", ")}.`);
  }
  out.push(
    "*Simulator timings on a virtualised runner: relative cost only, never a phone estimate.*",
  );
  return out.join("\n");
}

function footer(report, artifact) {
  const name = artifact ?? artifactName(report);
  const parts = [];
  if (name) parts.push(`Artifact \`${safe(name)}\``);
  parts.push("how to read these numbers: `docs/PROBEHOST.md`");
  return ["---", "", parts.join(" · ")].join("\n");
}

/** The artifact this report was uploaded as, when the run knew its own CI identity. */
export function artifactName(report) {
  const ci = report.ci ?? {};
  if (!ci.runId) return null;
  if (report.suite === "spike") return `probe-spike-${ci.runId}`;
  return `probe-live-${ci.runId}-${ci.runAttempt ?? 1}`;
}

/** The live suite summary: 03-report.md sections 3.1 to 3.4. */
export function renderScenarioSummary(report, options = {}) {
  const blocks = [
    { keep: true, text: header(report) },
    { keep: true, text: scenarioTable(report) },
    { keep: true, text: notMeasured(report) },
  ];
  const flags = flagLines(report);
  if (flags.length > 0) blocks.push({ keep: false, text: ["### Flags", "", ...flags].join("\n") });
  const compile = compileSection(report);
  if (compile) blocks.push({ keep: false, text: compile });
  blocks.push({ keep: true, text: footer(report, options.artifact) });
  return assemble(blocks, options.maxBytes ?? SUMMARY_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// the spike suite
// ---------------------------------------------------------------------------

const VERDICTS = new Set(["pass", "fail", "unknown", "skipped"]);

/**
 * Every probe id seen anywhere, in the order the first runtime reported them.
 *
 * `installed-runtimes` is excluded: it is answered runner-side from `simctl list`
 * (run.mjs section 8) and rendered as its own line above the matrix. ProbeHost also
 * emits it per runtime, always as `skipped`, because a probe the app itself
 * cannot answer reports skipped rather than vanishing (04-spike.md section 4);
 * carrying that into the matrix would add a row of "skipped" under every column and
 * invite the reader to conclude the runtimes were not enumerated.
 */
const RUNNER_SIDE_PROBES = new Set(["installed-runtimes"]);

function probeIds(runtimes) {
  const ids = [];
  for (const runtime of runtimes) {
    for (const probe of runtime.probes ?? []) {
      if (RUNNER_SIDE_PROBES.has(probe.id)) continue;
      if (!ids.includes(probe.id)) ids.push(probe.id);
    }
  }
  return ids;
}

function verdictOf(runtime, id) {
  const probe = (runtime.probes ?? []).find((p) => p.id === id);
  if (!probe) return null;
  return VERDICTS.has(probe.verdict) ? probe.verdict : null;
}

/** The M0 matrix of 04-spike.md section 5. */
export function renderSpikeSummary(report, options = {}) {
  const env = report.environment ?? {};
  const runtimes = report.runtimes ?? [];
  const out = [];

  const title = ["## M0 capability spike"];
  const where = [env.runnerImage, env.xcode ? `Xcode ${env.xcode}` : null].filter(Boolean).join(" / ");
  if (where) title.push(` — ${where}`);
  out.push(title.join(""), "");

  // The runner-side probe is the authority on what is installed; the per-runtime
  // list is only what was actually attempted, which is the same thing until a
  // device fails to create.
  const installedProbe = (report.probes ?? []).find((p) => p.id === "installed-runtimes");
  const fromProbe = (installedProbe?.evidence?.runtimes ?? [])
    .map((r) => (typeof r === "string" ? r : r?.version))
    .filter(Boolean);
  const installed =
    fromProbe.length > 0
      ? fromProbe
      : (report.installedRuntimes ?? runtimes.map((r) => r.runtime).filter(Boolean));
  const facts = [];
  if (installed.length > 0) facts.push(`Installed iOS runtimes: **${installed.map(safe).join(", ")}**`);
  const deviceTypes = [...new Set(runtimes.map((r) => r.deviceType).filter(Boolean))];
  if (deviceTypes.length === 1) facts.push(`device type **${safe(deviceTypes[0])}**`);
  else if (deviceTypes.length > 1) facts.push(`device types **${deviceTypes.map(safe).join(", ")}**`);
  if (facts.length > 0) out.push(facts.join(" · "), "");

  if (installedProbe) {
    const reason = installedProbe.reason ? ` — ${safe(installedProbe.reason)}` : "";
    out.push(`Runner-side probe installed-runtimes: **${safe(installedProbe.verdict ?? "unknown")}**${reason}`, "");
  }

  const ids = probeIds(runtimes);
  if (runtimes.length === 0 || ids.length === 0) {
    out.push("No probe produced a verdict: nothing was measured on this run. See the runner log in the artifact.", "");
  } else {
    out.push(
      `| Probe | ${runtimes.map((r) => safe(r.runtime ?? "?")).join(" | ")} |`,
      `|---|${runtimes.map(() => ":--:").join("|")}|`,
    );
    for (const id of ids) {
      const cells = runtimes.map((r) => verdictOf(r, id) ?? DASH);
      out.push(`| ${safe(id)} | ${cells.join(" | ")} |`);
    }
    out.push("");
  }

  const detail = [];
  for (const runtime of runtimes) {
    // A runtime that never produced a spike.json is a row of dashes in the matrix;
    // it gets a line of its own so the gap is explained rather than merely visible.
    if (runtime.status && runtime.status !== "ok") {
      detail.push(
        `- runtime ${safe(runtime.runtime ?? "?")} — ${safe(runtime.status)}: ${safe(runtime.reason ?? "no reason recorded")}`,
      );
    }
  }
  for (const runtime of runtimes) {
    for (const probe of runtime.probes ?? []) {
      if (probe.verdict !== "unknown" && probe.verdict !== "fail") continue;
      const reason = probe.reason ?? "no reason recorded";
      detail.push(`- \`${safe(probe.id)}\` on ${safe(runtime.runtime ?? "?")} — ${safe(probe.verdict)}: ${safe(reason)}`);
    }
  }
  out.push("**unknown** and **fail** in detail", "");
  out.push(
    detail.length > 0
      ? detail.join("\n")
      : "- none: every probe on every runtime reached a `pass` or was deliberately `skipped`.",
  );
  out.push("");

  // The capability probe's evidence is printed verbatim rather than summarised:
  // these are the fields DESIGN 1.3 wants quoted back, and inventing a shape for
  // them here is how a spike starts reporting something it did not measure.
  for (const runtime of runtimes) {
    const probe = (runtime.probes ?? []).find((p) => p.id === "media-source-availability");
    const evidence = probe?.evidence;
    if (!evidence || typeof evidence !== "object") continue;
    const render = (value) =>
      typeof value === "boolean" ? (value ? "present" : "absent") : value === null ? "unknown" : String(value);
    // ProbeHost nests every codec and media API answer inside `report`, so the
    // flat map this used to be rendered the one field worth reading as
    // "[object Object]": a summary that is green and says nothing. Arrays stay
    // stringified rather than expanded - no evidence field is an array today,
    // and inventing a shape for one here is how a spike starts reporting
    // something it did not measure.
    const pairs = [];
    for (const [key, value] of Object.entries(evidence)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [inner, innerValue] of Object.entries(value)) {
          pairs.push(`${safe(inner)} **${safe(render(innerValue))}**`);
        }
        continue;
      }
      pairs.push(`${safe(key)} **${safe(render(value))}**`);
    }
    if (pairs.length > 0) out.push(`Capability report on ${safe(runtime.runtime ?? "?")}: ${pairs.join(", ")}.`);
  }
  if (out[out.length - 1] !== "") out.push("");
  out.push(
    "*A codec or a media API missing on a virtualised runner is a fact about the runner, not about the phone.*",
    "",
  );

  const harness = report.harness ?? {};
  for (const error of harness.errors ?? []) out.push(`- harness: ${safe(error.reason ?? error)}`);

  const name = options.artifact ?? artifactName(report);
  out.push(
    "---",
    "",
    `${name ? `Artifact \`${safe(name)}\` · ` : ""}verdict meanings: \`docs/probehost/04-spike.md\` section 4`,
  );
  return assemble([{ keep: true, text: out.join("\n") }], options.maxBytes ?? SUMMARY_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/**
 * Join the blocks, dropping the droppable ones from the end until the result fits.
 * The header, the table, the "not measured" section and the footer are never
 * dropped: a truncated summary that hides what was not measured would be worse
 * than no summary at all.
 */
function assemble(blocks, maxBytes) {
  const render = (list) => `${list.map((b) => b.text).filter(Boolean).join("\n\n")}\n`;
  let current = blocks.slice();
  let text = render(current);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  for (let i = current.length - 1; i >= 0 && Buffer.byteLength(text, "utf8") > maxBytes; i -= 1) {
    if (current[i].keep) continue;
    current = current.filter((_, index) => index !== i);
    text = render([...current, { text: "*Detail sections omitted: the summary hit GitHub's 1 MiB cap. The full data is in the artifact.*" }]);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const note = "\n\n*Truncated at GitHub's 1 MiB cap. The full data is in the artifact.*\n";
    const room = maxBytes - Buffer.byteLength(note, "utf8");
    text = `${Buffer.from(text, "utf8").subarray(0, Math.max(0, room)).toString("utf8")}${note}`;
  }
  return text;
}

/** Dispatch on the report's own `suite` field. Anything else is a caller error. */
export function renderSummary(report, options = {}) {
  if (!report || typeof report !== "object") throw new TypeError("renderSummary: report must be an object");
  if (report.suite === "spike") return renderSpikeSummary(report, options);
  return renderScenarioSummary(report, options);
}
