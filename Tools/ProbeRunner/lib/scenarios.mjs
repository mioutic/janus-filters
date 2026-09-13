// SPDX-License-Identifier: GPL-3.0-or-later
//
// config/scenarios.json: load, validate, expand, and turn into work items
// (docs/probehost/02-runner.md sections 3 and 4).
//
// The file is data and this module is the only code that reads it. ProbeHost
// never sees it: the runner writes the one scenario it is about to run into
// Documents/probe/in/scenario.json, so the app has no opinion about which sites
// exist and a scenario edit needs no rebuild (00-index.md section 3).
//
// Validation is deliberately strict and deliberately collects every problem
// before throwing: a bad edit should fail in seconds on ubuntu, listing all of
// its mistakes, rather than after ten macOS minutes listing one.

import { readFile } from "node:fs/promises";

import { UsageError } from "./args.mjs";

export const SCENARIOS_SCHEMA_VERSION = 1;

/** Applied under the file's own `defaults`, which are applied under each scenario. */
export const BUILT_IN_DEFAULTS = Object.freeze({
  waitIdleMs: 2500,
  timeoutMs: 45_000,
  budgetMs: 240_000,
  tapCentre: false,
  screenshots: true,
  scroll: Object.freeze({ times: 0, dy: 800, pauseMs: 700 }),
});

const RANGES = {
  waitIdleMs: [100, 60_000],
  timeoutMs: [1000, 180_000],
  budgetMs: [10_000, 900_000],
  "scroll.times": [0, 50],
  "scroll.dy": [1, 5000],
  "scroll.pauseMs": [0, 10_000],
};

const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const FIXTURE_URL = /^fixture:\/[A-Za-z0-9._/-]{1,120}$/;
const PAGE_STATE_ID = /^[a-z][a-z-]{1,30}$/;

/** The app owns these three: a matcher may not redefine what the app decides. */
const RESERVED_PAGE_STATES = new Set(["ok", "error", "unknown"]);

const SCENARIO_KEYS = new Set([
  "id",
  "title",
  "url",
  "urlFrom",
  "gate",
  "stable",
  "optional",
  "tapCentre",
  "screenshots",
  "scroll",
  "waitIdleMs",
  "timeoutMs",
  "budgetMs",
  "selectors",
  "expect",
  "notes",
]);

const EXPECT_KEYS = new Set([
  "blockedMin",
  "domVisibleMax",
  "allowedMustLoad",
  "popupsNativeMax",
  "overlaysMax",
]);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A URL a measurement may point at. https only (no http: downgrade, no
 * credentials, no bare IP literal), or the offline fixture scheme.
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "not a string" };
  if (raw.startsWith("fixture:")) {
    // The app resolves a fixture path inside its own Resources directory, so a
    // traversal segment is rejected here rather than discovered there.
    if (raw.includes("..")) return { ok: false, reason: "fixture: path may not traverse" };
    return FIXTURE_URL.test(raw) ? { ok: true } : { ok: false, reason: "malformed fixture: path" };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "must be https" };
  if (url.username || url.password) return { ok: false, reason: "must not carry credentials" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(":")) {
    return { ok: false, reason: "must not be an IP literal" };
  }
  if (!url.hostname.includes(".") || url.hostname.endsWith(".localhost")) {
    return { ok: false, reason: "must be a public hostname" };
  }
  return { ok: true };
}

function checkNumber(problems, where, key, value, [min, max]) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${where}.${key} must be a whole number between ${min} and ${max}`);
  }
}

function checkScroll(problems, where, scroll) {
  if (scroll === undefined) return;
  if (!isObject(scroll)) {
    problems.push(`${where}.scroll must be an object`);
    return;
  }
  for (const key of Object.keys(scroll)) {
    if (!["times", "dy", "pauseMs"].includes(key)) problems.push(`${where}.scroll.${key} is unknown`);
  }
  checkNumber(problems, `${where}.scroll`, "times", scroll.times, RANGES["scroll.times"]);
  checkNumber(problems, `${where}.scroll`, "dy", scroll.dy, RANGES["scroll.dy"]);
  checkNumber(problems, `${where}.scroll`, "pauseMs", scroll.pauseMs, RANGES["scroll.pauseMs"]);
}

function checkStringArray(problems, where, value, { allowCommon = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${where} must be a non-empty array of strings`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      problems.push(`${where}[${index}] must be a non-empty string`);
      return;
    }
    if (!allowCommon && entry === "@common") problems.push(`${where}[${index}] may not be @common`);
  });
}

/**
 * Throws UsageError (exit 2) listing every problem found.
 * @returns {object} the document, unchanged but proven
 */
export function validateScenarioDoc(doc, { source = "config/scenarios.json" } = {}) {
  const problems = [];
  if (!isObject(doc)) throw new UsageError(`${source} must contain a JSON object`);
  if (doc.schemaVersion !== SCENARIOS_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SCENARIOS_SCHEMA_VERSION}`);
  }

  if (doc.defaults !== undefined) {
    if (!isObject(doc.defaults)) problems.push("defaults must be an object");
    else {
      checkNumber(problems, "defaults", "waitIdleMs", doc.defaults.waitIdleMs, RANGES.waitIdleMs);
      checkNumber(problems, "defaults", "timeoutMs", doc.defaults.timeoutMs, RANGES.timeoutMs);
      checkNumber(problems, "defaults", "budgetMs", doc.defaults.budgetMs, RANGES.budgetMs);
      checkScroll(problems, "defaults", doc.defaults.scroll);
    }
  }

  checkStringArray(problems, "commonSelectors", doc.commonSelectors);

  if (!isObject(doc.pageState)) problems.push("pageState must be an object of matchers");
  else {
    for (const [state, matcher] of Object.entries(doc.pageState)) {
      if (!PAGE_STATE_ID.test(state)) problems.push(`pageState.${state} is not a valid state id`);
      if (RESERVED_PAGE_STATES.has(state)) {
        problems.push(`pageState.${state} is decided by the app and may not be redefined`);
      }
      if (!isObject(matcher)) {
        problems.push(`pageState.${state} must be an object`);
        continue;
      }
      const text = matcher.text ?? [];
      const selectors = matcher.selectors ?? [];
      if (!Array.isArray(text) || !Array.isArray(selectors)) {
        problems.push(`pageState.${state} needs array "text" and "selectors"`);
        continue;
      }
      if (text.length === 0 && selectors.length === 0) {
        problems.push(`pageState.${state} matches nothing`);
      }
      for (const entry of [...text, ...selectors]) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          problems.push(`pageState.${state} holds an empty matcher`);
        }
      }
    }
  }

  if (!Array.isArray(doc.scenarios) || doc.scenarios.length === 0) {
    problems.push("scenarios must be a non-empty array");
    throw new UsageError(`${source} is invalid`, { problems });
  }

  const seen = new Set();
  let gates = 0;
  doc.scenarios.forEach((scenario, index) => {
    const where = `scenarios[${index}]`;
    if (!isObject(scenario)) {
      problems.push(`${where} must be an object`);
      return;
    }
    for (const key of Object.keys(scenario)) {
      if (!SCENARIO_KEYS.has(key)) problems.push(`${where}.${key} is unknown`);
    }
    const id = scenario.id;
    if (typeof id !== "string" || !SCENARIO_ID.test(id)) {
      problems.push(`${where}.id must match ${SCENARIO_ID}`);
    } else if (seen.has(id)) {
      problems.push(`${where}.id "${id}" is a duplicate`);
    } else {
      seen.add(id);
    }
    const name = typeof id === "string" ? id : where;

    if (typeof scenario.title !== "string" || scenario.title.trim().length === 0) {
      problems.push(`${name}.title is required`);
    }

    const hasUrl = typeof scenario.url === "string";
    const hasUrlFrom = typeof scenario.urlFrom === "string";
    if (hasUrl === hasUrlFrom) {
      problems.push(`${name} needs exactly one of url or urlFrom`);
    }
    if (hasUrl) {
      const verdict = checkUrl(scenario.url);
      if (!verdict.ok) problems.push(`${name}.url ${verdict.reason}`);
    }
    if (hasUrlFrom) {
      if (!ENV_NAME.test(scenario.urlFrom)) {
        problems.push(`${name}.urlFrom must be an environment variable name`);
      }
      if (scenario.optional !== true) {
        // An unset variable must never be able to stop the suite.
        problems.push(`${name} uses urlFrom and must therefore be optional: true`);
      }
    }

    for (const key of ["gate", "stable", "optional", "tapCentre", "screenshots"]) {
      if (scenario[key] !== undefined && typeof scenario[key] !== "boolean") {
        problems.push(`${name}.${key} must be a boolean`);
      }
    }
    checkNumber(problems, name, "waitIdleMs", scenario.waitIdleMs, RANGES.waitIdleMs);
    checkNumber(problems, name, "timeoutMs", scenario.timeoutMs, RANGES.timeoutMs);
    checkNumber(problems, name, "budgetMs", scenario.budgetMs, RANGES.budgetMs);
    checkScroll(problems, name, scenario.scroll);
    checkStringArray(problems, `${name}.selectors`, scenario.selectors, { allowCommon: true });

    if (scenario.expect !== undefined) {
      if (!isObject(scenario.expect)) problems.push(`${name}.expect must be an object`);
      else {
        for (const [key, value] of Object.entries(scenario.expect)) {
          if (!EXPECT_KEYS.has(key)) {
            problems.push(`${name}.expect.${key} is unknown`);
            continue;
          }
          if (key === "allowedMustLoad") {
            if (typeof value !== "boolean") problems.push(`${name}.expect.${key} must be a boolean`);
          } else if (!Number.isInteger(value) || value < 0) {
            problems.push(`${name}.expect.${key} must be a whole number >= 0`);
          }
        }
      }
    }
    if (scenario.notes !== undefined && typeof scenario.notes !== "string") {
      problems.push(`${name}.notes must be a string`);
    }

    if (scenario.gate === true) {
      gates += 1;
      if (scenario.stable !== true) problems.push(`${name} is a gate and must be stable: true`);
      if (!hasUrl || !String(scenario.url).startsWith("fixture:")) {
        // A gate that depends on the network cannot prove the harness works when
        // the network is what failed (00-index.md section 1).
        problems.push(`${name} is a gate and must use a fixture: URL`);
      }
      if (!isObject(scenario.expect)) problems.push(`${name} is a gate and must declare expect`);
    }
  });

  if (gates === 0) {
    problems.push("no gate scenario: the suite would measure without proving it can measure");
  }

  if (problems.length > 0) throw new UsageError(`${source} is invalid`, { problems });
  return doc;
}

/** Read and validate. Any failure here is exit 2, before a simulator is touched. */
export async function loadScenarioDoc(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read the scenarios file: ${error.code ?? error.message}`, {
      path: filePath,
    });
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`the scenarios file is not JSON: ${error.message}`, { path: filePath });
  }
  return validateScenarioDoc(doc, { source: filePath });
}

/** `@common` expands in place, order preserved, duplicates removed. */
export function expandSelectors(selectors, commonSelectors) {
  const out = [];
  for (const entry of selectors) {
    if (entry === "@common") out.push(...commonSelectors);
    else out.push(entry);
  }
  return [...new Set(out.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/** File order, with every gate hoisted to the front; `only` restricts and reorders. */
export function selectScenarios(doc, { only = null, onlyStable = false } = {}) {
  let list = [...doc.scenarios];
  if (only) {
    const byId = new Map(list.map((scenario) => [scenario.id, scenario]));
    const missing = only.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new UsageError("--only names unknown scenarios", { missing });
    list = only.map((id) => byId.get(id));
    // A gate is not optional: it is re-added even when --only left it out.
    for (const scenario of doc.scenarios) {
      if (scenario.gate === true && !list.includes(scenario)) list.unshift(scenario);
    }
  }
  if (onlyStable) list = list.filter((scenario) => scenario.stable === true || scenario.gate === true);
  const gates = list.filter((scenario) => scenario.gate === true);
  const rest = list.filter((scenario) => scenario.gate !== true);
  return [...gates, ...rest];
}

/**
 * One scenario, defaults merged, selectors flattened, URL resolved, ready to be
 * written into the container. A scenario that cannot run is returned with
 * `status: "skipped"` and a reason; it is never dropped, because a scenario that
 * vanishes from the report is indistinguishable from one nobody wrote.
 */
export function materialiseScenario(scenario, doc, env = process.env) {
  const defaults = { ...BUILT_IN_DEFAULTS, ...(doc.defaults ?? {}) };
  const scroll = {
    ...BUILT_IN_DEFAULTS.scroll,
    ...(doc.defaults?.scroll ?? {}),
    ...(scenario.scroll ?? {}),
  };

  let url = scenario.url ?? null;
  let status = "ready";
  let reason = null;
  if (!url && scenario.urlFrom) {
    const raw = (env[scenario.urlFrom] ?? "").trim();
    if (raw.length === 0) {
      status = "skipped";
      reason = `${scenario.urlFrom} not configured`;
    } else {
      const verdict = checkUrl(raw);
      if (!verdict.ok) {
        status = "skipped";
        reason = `${scenario.urlFrom} ${verdict.reason}`;
      } else {
        url = raw;
      }
    }
  }

  const payload = {
    schemaVersion: SCENARIOS_SCHEMA_VERSION,
    id: scenario.id,
    title: scenario.title,
    url,
    gate: scenario.gate === true,
    stable: scenario.stable === true,
    tapCentre: scenario.tapCentre ?? defaults.tapCentre,
    screenshots: scenario.screenshots ?? defaults.screenshots,
    waitIdleMs: scenario.waitIdleMs ?? defaults.waitIdleMs,
    timeoutMs: scenario.timeoutMs ?? defaults.timeoutMs,
    budgetMs: scenario.budgetMs ?? defaults.budgetMs,
    scroll,
    selectors: expandSelectors(scenario.selectors, doc.commonSelectors),
    pageState: doc.pageState,
    expect: scenario.expect ?? null,
  };

  return {
    id: scenario.id,
    title: scenario.title,
    url,
    gate: payload.gate,
    stable: payload.stable,
    optional: scenario.optional === true,
    status,
    reason,
    notes: scenario.notes ?? null,
    payload,
  };
}

/**
 * Odd repeats run the modes in the given order, even repeats reversed.
 * Warm DNS, warm TLS and warm CDN caches otherwise bias the second mode
 * systematically, and the blocked-minus-none delta is what M2c exists to produce.
 *
 * At repeats=1 - the cron's setting and the workflow default - parity on the repeat
 * alone never flips anything, so `blocked` was always the cold first load and `none`
 * always the warm second one in every scheduled run. The scenario index carries the
 * alternation instead: odd-indexed scenarios run the modes reversed, so across a suite
 * each mode goes first about half the time and the bias cancels in the aggregate rather
 * than in each pair.
 */
export function modeOrderForRepeat(modes, repeat, scenarioIndex = 0) {
  const flips = (repeat % 2 === 0 ? 1 : 0) + (scenarioIndex % 2 === 1 ? 1 : 0);
  return flips % 2 === 1 ? [...modes].reverse() : [...modes];
}

/**
 * (scenario, repeat, mode) work items, a scenario's own modes kept adjacent so a
 * delta is never taken across twenty minutes of unrelated traffic. The order each
 * scenario actually ran in is on every item and is copied into report.order, so the
 * report can never claim a control it did not exercise.
 */
export function buildWorkItems(materialised, { repeats = 1, modes = ["blocked", "none"] } = {}) {
  const items = [];
  let readyIndex = -1;
  for (const scenario of materialised) {
    if (scenario.status !== "ready") continue;
    readyIndex += 1;
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const order = modeOrderForRepeat(modes, repeat, readyIndex);
      for (const mode of order) {
        items.push({
          scenarioId: scenario.id,
          gate: scenario.gate,
          mode,
          repeat,
          order,
          attempt: 1,
          runId: `${scenario.id}-${mode}-${repeat}`,
          scenario,
        });
      }
    }
  }
  return items;
}
