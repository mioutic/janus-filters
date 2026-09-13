// SPDX-License-Identifier: GPL-3.0-or-later
//
// The trend record of docs/probehost/03-report.md section 4: one small, flat
// object per suite run, plus the merge that turns a directory of them into
// newline-delimited JSON.
//
// What is deliberately NOT here: any store. M2c writes trend records and ships
// the code that merges them, and wires no write path (03-report.md section 4.3).
// The record leaves this process as a file in an artifact; what a later, reviewed
// change does with it is that change's business.
//
// What is deliberately NOT in the record: anything that will not still be
// comparable in six months. No request lists, no screenshot paths, no per-bucket
// compile times, no URLs. A trend that carries everything is a trend nobody plots.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const TREND_SCHEMA_VERSION = 1;

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** A number the harness observed, or null. Never 0 as a stand-in for "not seen". */
const numOrNull = (v) => (isNumber(v) ? v : null);

/**
 * Popups attempted, native plus JavaScript-opened. Absent on both sides stays
 * absent: the trend must show a gap where the harness saw nothing.
 */
function popups(mode) {
  const parts = [mode?.popupsNative, mode?.popupsJs].filter(isNumber);
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

/**
 * One scenario's row, or null when it did not produce both modes. A half-measured
 * scenario is an explicit gap rather than a number that looks like a measurement.
 */
export function trendScenario(scenario) {
  const b = scenario?.modes?.blocked ?? null;
  const n = scenario?.modes?.none ?? null;
  if (!b || !n) return null;
  const state =
    scenario.status && scenario.status !== "ok"
      ? scenario.status
      : scenario.pageState?.blocked && scenario.pageState.blocked === scenario.pageState.none
        ? scenario.pageState.blocked
        : scenario.pageState?.agree === false
          ? "disagree"
          : (scenario.pageState?.blocked ?? "ok");
  return {
    state,
    blocked: numOrNull(b.requestsBlocked),
    observedB: numOrNull(b.requestsObserved),
    observedN: numOrNull(n.requestsObserved),
    adVisibleB: numOrNull(b.adElementsVisible),
    adVisibleN: numOrNull(n.adElementsVisible),
    overlaysB: numOrNull(b.overlays),
    overlaysN: numOrNull(n.overlays),
    popupsB: popups(b),
    popupsN: popups(n),
    dialogsB: numOrNull(b.dialogs),
    dialogsN: numOrNull(n.dialogs),
    consoleErrB: numOrNull(b.consoleErrors),
    consoleErrN: numOrNull(n.consoleErrors),
    loadMsB: numOrNull(b.loadMs),
    loadMsN: numOrNull(n.loadMs),
  };
}

/** ISO day of an ISO timestamp, or null when there is no timestamp to take it from. */
function dayOf(ts) {
  if (typeof ts !== "string") return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * The trend record for one scenario-suite report. Section 4.2's comparability keys
 * (runtime, deviceType, viewportWidth, egress, flavour, layoutVersion) are all in
 * the record precisely so grouping two records is mechanical, not a judgement.
 */
export function buildTrend(report) {
  if (!report || typeof report !== "object") throw new TypeError("buildTrend: report must be an object");
  if (report.suite === "spike") {
    throw new TypeError("buildTrend: the spike suite has no trend record; its verdicts are not a time series");
  }
  const bundle = report.bundle ?? {};
  const env = report.environment ?? {};
  const compile = report.compile ?? {};
  const ci = report.ci ?? {};
  const ts = report.endedAt ?? report.startedAt ?? null;

  const scenarios = {};
  for (const scenario of report.scenarios ?? []) {
    if (!scenario?.id) continue;
    scenarios[scenario.id] = trendScenario(scenario);
  }

  return {
    schemaVersion: TREND_SCHEMA_VERSION,
    runId: report.runId ?? null,
    date: dayOf(ts),
    ts,
    bundleVersion: bundle.version ?? null,
    bundleIssuedAt: bundle.issuedAt ?? null,
    layoutVersion: bundle.layoutVersion ?? null,
    flavour: bundle.flavour ?? null,
    contractOk: typeof bundle.contractOk === "boolean" ? bundle.contractOk : null,
    env: {
      runnerImage: env.runnerImage ?? null,
      xcode: env.xcode ?? null,
      runtime: env.runtime ?? null,
      deviceType: env.deviceType ?? null,
      viewportWidth: numOrNull(env.viewport?.width),
      egress: env.egress?.mode ?? null,
    },
    compile: {
      buckets: numOrNull(compile.buckets),
      failed: numOrNull(compile.failed),
      ruleCountTotal: numOrNull(compile.ruleCountTotal),
      totalMs: numOrNull(compile.totalMs),
    },
    gate: { passed: typeof report.gate?.passed === "boolean" ? report.gate.passed : null },
    scenarios,
    ci: {
      runId: ci.runId ?? null,
      runAttempt: ci.runAttempt ?? null,
      sha: ci.sha ?? null,
      event: ci.event ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// accumulation
// ---------------------------------------------------------------------------

/**
 * Sort by `ts`, de-duplicate on `runId` keeping the last one seen for that id.
 * A re-run of the same suite overwrites its own earlier record rather than
 * appearing twice; two different runs on the same day are two records.
 */
export function accumulate(records) {
  const byRunId = new Map();
  let anonymous = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const key = record.runId ?? `anonymous-${(anonymous += 1)}`;
    byRunId.set(key, record);
  }
  return [...byRunId.values()].sort((a, b) => {
    const at = String(a.ts ?? "");
    const bt = String(b.ts ?? "");
    if (at !== bt) return at < bt ? -1 : 1;
    return String(a.runId ?? "") < String(b.runId ?? "") ? -1 : 1;
  });
}

/** Newline-delimited JSON: the format that appends without rewriting. */
export function toNdjson(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

/** Parses ndjson, skipping blank lines. A malformed line is an error, not a silent drop. */
export function parseNdjson(text) {
  const records = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`line ${i + 1} is not JSON: ${err.message}`);
    }
  }
  return records;
}

/**
 * Every trend record under `dir`: `*.json` files that look like a trend record,
 * one level of subdirectory deep as well, because `gh run download` unpacks each
 * artifact into its own folder.
 */
export async function readTrendDir(dir) {
  const found = [];
  const visit = async (current, depth) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await visit(full, depth - 1);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      if (entry.name.endsWith("report.json")) continue; // a full report is not a trend record
      let parsed;
      try {
        parsed = JSON.parse(await readFile(full, "utf8"));
      } catch (err) {
        throw new Error(`${full}: ${err.message}`);
      }
      if (parsed && typeof parsed === "object" && "scenarios" in parsed && "bundleVersion" in parsed) {
        found.push(parsed);
      }
    }
  };
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  await visit(dir, 2);
  return found;
}

/**
 * Merge a directory of trend records into ndjson, folding in whatever `existing`
 * ndjson text already holds so that running this twice is idempotent.
 */
export async function accumulateDir(dir, { existing = "" } = {}) {
  const previous = existing ? parseNdjson(existing) : [];
  const found = await readTrendDir(dir);
  const merged = accumulate([...previous, ...found]);
  return { records: merged, ndjson: toNdjson(merged), added: found.length, total: merged.length };
}
