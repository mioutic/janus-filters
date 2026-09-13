#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The step runner (docs/probehost/02-runner.md). Chooses an installed runtime and
// device type, boots one simulator, installs ProbeHost, gates on selftest-local,
// runs every (scenario, repeat, mode) work item, and merges the result into
// build/probe/<runId>/report.json.
//
// What it never does: build the app (the workflow does), upload anything (the
// workflow does), decide whether a blocking number is good (report.mjs and a
// human do), download a simulator runtime, or touch a process it did not start.
//
// Exit codes (02-runner.md section 8): 0 the suite ran, 1 a strict expectation
// missed, 2 usage, 3 harness failure, 4 the published bundle failed contract
// verification. A blocking result never changes the exit code.

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { EXIT, USAGE, UsageError, parseArgs } from "./lib/args.mjs";
import { stageBundleDir } from "./lib/collect.mjs";
import {
  HarnessError,
  environmentInfo,
  prepareDevice,
  resolveEgress,
  selectDeviceType,
  selectRuntimes,
  teardownDevice,
} from "./lib/device.mjs";
import { containerPaths, isInternalFailure, retryItem, runWorkItem, shouldRetry } from "./lib/launch.mjs";
import { createRunnerLog, relativise } from "./lib/log.mjs";
import { buildReport, ciContext, mergeGate, mergeScenario, strictViolations } from "./lib/merge.mjs";
import { createSimctl, macosVersion } from "./lib/simctl.mjs";
import { buildWorkItems, loadScenarioDoc, materialiseScenario, selectScenarios } from "./lib/scenarios.mjs";

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertAppBundle(appPath) {
  try {
    const info = await stat(appPath);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new UsageError(`--app is not a readable .app bundle: ${error.code ?? error.message}`, {
      app: relativise(appPath),
    });
  }
}

/**
 * Run a list of work items against one booted device, retrying once and only for
 * harness failures. Records, never throws: a scenario failure is a row in the
 * report (02-runner.md section 9).
 */
async function runItems(items, ctx) {
  for (const item of items) {
    if (ctx.aborted) {
      ctx.skipped.set(item.scenarioId, ctx.aborted);
      continue;
    }
    if (Date.now() >= ctx.budgetAt) {
      // The suite stops itself so the job's own timeout is never what ends a run:
      // a workflow timeout uploads no artifacts (02-runner.md section 6).
      ctx.skipped.set(item.scenarioId, "budget");
      continue;
    }

    let result = await runWorkItem({
      simctl: ctx.simctl,
      udid: ctx.udid,
      bundleId: ctx.opts.bundleId,
      dataContainer: ctx.dataContainer,
      item,
      opts: ctx.opts,
      outRoot: ctx.outRoot,
      log: ctx.log,
    });
    ctx.log.item(result.runId, result.status, {
      mode: result.mode,
      repeat: result.repeat,
      exit: result.exitCode,
      page: result.pageState,
      // The same numbers the report headlines: distinct blocked URLs, not rule-list
      // action callbacks, and de-duplicated visible ad elements.
      blocked: result.runJson?.blocked?.distinctUrls ?? result.runJson?.blocked?.total ?? null,
      adsVisible: result.runJson?.dom?.uniqueVisible ?? result.runJson?.dom?.totalVisible ?? null,
      ms: result.durationMs,
      reason: result.reason ?? undefined,
    });

    if (shouldRetry(result)) {
      ctx.log.warn("retrying once", { runId: result.runId, reason: result.reason ?? result.status });
      const retry = await runWorkItem({
        simctl: ctx.simctl,
        udid: ctx.udid,
        bundleId: ctx.opts.bundleId,
        dataContainer: ctx.dataContainer,
        item: retryItem(item),
        opts: ctx.opts,
        outRoot: ctx.outRoot,
        log: ctx.log,
      });
      ctx.log.item(retry.runId, retry.status, { attempt: 2, exit: retry.exitCode, ms: retry.durationMs });
      // The first attempt keeps its evidence but never supplies numbers.
      ctx.extraEvidence.push(
        ...(result.files ?? []).map((file) => ({ scenarioId: item.scenarioId, file: `${result.dir}/${file}` })),
      );
      result = retry;
    }

    ctx.results.push(result);

    if (isInternalFailure(result)) {
      ctx.consecutiveInternal += 1;
      if (ctx.consecutiveInternal >= 3) {
        // A persistently sick simulator makes every later number meaningless.
        ctx.aborted = "three consecutive harness failures";
        ctx.log.error("aborting the suite", { reason: ctx.aborted });
      }
    } else {
      ctx.consecutiveInternal = 0;
    }
  }
}

function rowsFor(materialised, ctx, modes) {
  return materialised.map((scenario) => {
    const results = ctx.results.filter((result) => result.scenarioId === scenario.id);
    const skippedReason = ctx.skipped.get(scenario.id);
    const effective =
      results.length === 0 && scenario.status === "ready"
        ? { ...scenario, status: "skipped", reason: skippedReason ?? "not run" }
        : scenario;
    const row = mergeScenario({ scenario: effective, results, modes });
    const extra = ctx.extraEvidence
      .filter((entry) => entry.scenarioId === scenario.id)
      .map((entry) => entry.file);
    if (extra.length > 0) row.evidence = [...new Set([...row.evidence, ...extra])];
    if (results.length > 0 && skippedReason) {
      // Some work items ran and some did not: the row keeps its numbers and says
      // so, because a half-measured scenario must not read as a whole one.
      row.reason = row.reason ?? `partially skipped: ${skippedReason}`;
      if (!row.flags.includes("partially-skipped")) row.flags.push("partially-skipped");
    }
    return row;
  });
}

function harnessFrom(rows, ctx) {
  const failures = rows
    .filter((row) => !["ok", "skipped"].includes(row.status))
    .map((row) => ({ scenario: row.id, reason: row.reason ?? row.status }));
  const warnings = [];
  for (const row of rows) {
    for (const flag of row.flags ?? []) {
      if (flag === "mode-none-blocked-nonzero") {
        warnings.push({
          scenario: row.id,
          reason: `blocked count non-zero in mode none (${row.modes?.none?.requestsBlocked})`,
        });
      } else if (flag === "page-state-disagree") {
        warnings.push({
          scenario: row.id,
          reason: `page state differs between modes (${row.pageState.blocked} vs ${row.pageState.none})`,
        });
      } else {
        warnings.push({ scenario: row.id, reason: flag });
      }
    }
  }
  const skipped = rows
    .filter((row) => row.status === "skipped")
    .map((row) => ({ scenario: row.id, reason: row.reason ?? "skipped" }));
  return {
    ok: ctx.harnessOk,
    reason: ctx.harnessReason,
    failures,
    warnings,
    skipped,
    aborted: ctx.aborted,
  };
}

async function runScenarioSuite({ opts, doc, simctl, list, log, outRoot, startedAt }) {
  const runtime = selectRuntimes(list, opts.runtime)[0];
  const deviceType = selectDeviceType(runtime, list, opts.deviceTypeId);
  const appPath = path.resolve(opts.app);

  const device = await prepareDevice(simctl, {
    list,
    runtime,
    deviceType,
    appPath,
    bundleId: opts.bundleId,
    log,
  });

  const ctx = {
    simctl,
    log,
    opts,
    outRoot,
    udid: device.udid,
    dataContainer: device.dataContainer,
    results: [],
    extraEvidence: [],
    skipped: new Map(),
    consecutiveInternal: 0,
    aborted: null,
    harnessOk: true,
    harnessReason: null,
    budgetAt: Date.now() + opts.budgetMs,
  };

  let materialised = [];
  try {
    if (opts.bundleDir) {
      const paths = containerPaths(device.dataContainer, "stage");
      const copied = await stageBundleDir(path.resolve(opts.bundleDir), paths.bundleDir);
      log.info("offline bundle staged", { files: copied });
    }

    materialised = selectScenarios(doc, { only: opts.only, onlyStable: opts.onlyStable }).map((scenario) =>
      materialiseScenario(scenario, doc, process.env),
    );
    for (const scenario of materialised) {
      if (scenario.status === "skipped") {
        log.warn("scenario skipped", { scenario: scenario.id, reason: scenario.reason });
      }
    }

    const items = buildWorkItems(materialised, { repeats: opts.repeats, modes: [...opts.modes] });
    const gateItems = items.filter((item) => item.gate);
    const restItems = items.filter((item) => !item.gate);
    log.info("suite", {
      scenarios: materialised.filter((scenario) => scenario.status === "ready").length,
      items: items.length,
      repeats: opts.repeats,
      modes: opts.modes.join(","),
      budgetMin: opts.budgetMin,
    });

    // 1. The gate. Without it, "0 requests blocked" on a live site is ambiguous
    //    between "the filters did not block" and "the harness is not measuring".
    log.section("gate");
    await runItems(gateItems, ctx);

    const gateScenario = materialised.find((scenario) => scenario.gate);
    let gate = null;
    if (gateScenario) {
      const gateRow = mergeScenario({
        scenario: gateScenario,
        results: ctx.results.filter((result) => result.scenarioId === gateScenario.id),
        modes: [...opts.modes],
      });
      gate = mergeGate(gateRow);
      if (!opts.modes.includes("blocked")) {
        log.warn("gate not enforced", { reason: "mode blocked was not requested" });
      } else if (gate?.passed !== true) {
        ctx.harnessOk = false;
        ctx.harnessReason = `gate ${gate?.id ?? "selftest"} did not pass: ${
          (gate?.misses ?? []).join("; ") || `blocked=${gate?.blocked} spiFired=${gate?.spiFired}`
        }`;
        ctx.aborted = "gate failed";
        log.error("gate failed", { reason: ctx.harnessReason });
      } else {
        log.info("gate passed", {
          blocked: gate.blocked,
          domVisible: gate.domVisible,
          spiFired: gate.spiFired,
        });
      }
    }

    // 2. Everything else, in scenario order, both modes adjacent per repeat.
    log.section("scenarios");
    await runItems(restItems, ctx);
  } finally {
    await teardownDevice(simctl, device.udid, { ephemeral: opts.ephemeral, log });
  }

  const rows = rowsFor(materialised, ctx, [...opts.modes]);
  const runJsons = ctx.results.filter((result) => result.runJson).map((result) => result.runJson);
  if (runJsons.length === 0) {
    ctx.harnessOk = false;
    ctx.harnessReason = ctx.harnessReason ?? "no work item produced a result";
  }

  const environment = await environmentInfo(simctl, {
    runtime,
    deviceType,
    egress: await resolveEgress({ recordEgress: opts.recordEgress }),
  });
  environment.macosVersion = await macosVersion();

  const endedAt = nowIso();
  const report = buildReport({
    suite: "scenario",
    runId: opts.runId,
    startedAt,
    endedAt,
    environment,
    ci: ciContext(),
    rows,
    runJsons,
    // What the suite actually did, not what it would do with other options: at
    // repeats=1 the repeat parity flips nothing, so the alternation is carried by the
    // scenario index instead. docs/PROBEHOST.md section 4 leans on this to call the
    // blocked-minus-none delta trustworthy, so it must describe the real run.
    order: {
      modes: [...opts.modes],
      repeats: opts.repeats,
      alternatesByRepeat: opts.repeats > 1,
      alternatesByScenario: true,
      note:
        opts.repeats > 1
          ? "mode order reverses on even repeats and on odd-indexed scenarios"
          : "repeats=1: mode order reverses on odd-indexed scenarios only",
    },
    harness: harnessFrom(rows, ctx),
  });
  await writeJson(path.join(outRoot, "report.json"), report);

  const bundleBroken = ctx.results.some((result) => result.exitCode === 65);
  const violations = opts.strict ? strictViolations(rows) : [];
  for (const violation of violations) {
    log.error("strict expectation missed", { scenario: violation.scenario, misses: violation.misses.join("; ") });
  }

  log.info("report written", {
    file: relativise(path.join(outRoot, "report.json")),
    scenariosOk: report.totals.scenariosOk,
    scenariosFailed: report.totals.scenariosFailed,
    scenariosSkipped: report.totals.scenariosSkipped,
    requestsBlocked: report.totals.requestsBlocked,
  });

  if (bundleBroken) return EXIT.BUNDLE;
  if (!report.harness.ok) return EXIT.HARNESS;
  if (violations.length > 0) return EXIT.STRICT;
  return EXIT.OK;
}

/**
 * 04-spike.md: one device per installed runtime, in ascending order, each booted,
 * probed and shut down before the next is created. `installed-runtimes` is the one
 * probe that runs here rather than in the app.
 */
async function runSpikeSuite({ opts, simctl, list, log, outRoot, startedAt }) {
  const runtimes = selectRuntimes(list, opts.runtime);
  const appPath = path.resolve(opts.app);
  const iphoneTypes = (list.devicetypes ?? []).filter((type) => /iPhone/.test(String(type.name ?? "")));
  const xcode = await simctl.xcodeVersion();

  const installedRuntimes = {
    id: "installed-runtimes",
    title: "Which simulator runtimes and iPhone device types exist on this image?",
    verdict: runtimes.length > 0 && iphoneTypes.length > 0 ? "pass" : "fail",
    evidence: {
      runtimes: runtimes.map((runtime) => ({
        version: runtime.version,
        identifier: runtime.identifier,
        buildversion: runtime.buildversion ?? null,
        supportedIphoneDeviceTypes: (runtime.supportedDeviceTypes ?? [])
          .filter((type) => /iPhone/.test(String(type.name ?? "")))
          .map((type) => type.identifier),
      })),
      iphoneDeviceTypes: iphoneTypes.map((type) => type.identifier),
      xcode: xcode.version,
      xcodeBuild: xcode.build,
      runnerImage: process.env.ImageOS ?? null,
    },
    reason: null,
  };

  const perRuntime = [];
  let ok = true;
  for (const runtime of runtimes) {
    const slug = String(runtime.version).replace(/\./g, "-");
    const deviceType = selectDeviceType(runtime, list, opts.deviceTypeId);
    let device = null;
    try {
      device = await prepareDevice(simctl, { list, runtime, deviceType, appPath, bundleId: opts.bundleId, log });
      const item = {
        suite: "spike",
        scenarioId: "spike",
        mode: slug,
        repeat: 1,
        attempt: 1,
        runId: `spike-${slug}`,
        scenario: null,
      };
      let result = await runWorkItem({
        simctl,
        udid: device.udid,
        bundleId: opts.bundleId,
        dataContainer: device.dataContainer,
        item,
        opts,
        outRoot,
        log,
      });
      if (shouldRetry(result)) {
        log.warn("retrying spike once", { runtime: runtime.version, reason: result.reason ?? result.status });
        result = await runWorkItem({
          simctl,
          udid: device.udid,
          bundleId: opts.bundleId,
          dataContainer: device.dataContainer,
          item: retryItem(item),
          opts,
          outRoot,
          log,
        });
      }
      log.item(result.runId, result.status, { runtime: runtime.version, ms: result.durationMs });
      if (result.status !== "ok") ok = false;
      perRuntime.push({
        runtime: runtime.version,
        runtimeId: runtime.identifier,
        deviceType: deviceType.name ?? deviceType.identifier,
        status: result.status,
        reason: result.reason,
        file: `${result.dir}/spike.json`,
        host: result.runJson?.host ?? null,
        probes: result.runJson?.probes ?? null,
        harness: result.runJson?.harness ?? null,
      });
    } catch (error) {
      ok = false;
      log.error("spike runtime failed", { runtime: runtime.version, reason: error.message });
      perRuntime.push({
        runtime: runtime.version,
        runtimeId: runtime.identifier,
        deviceType: deviceType?.name ?? null,
        status: "harness-failed",
        reason: error.message,
        file: null,
        host: null,
        probes: null,
        harness: null,
      });
    } finally {
      if (device) await teardownDevice(simctl, device.udid, { ephemeral: opts.ephemeral, log });
    }
  }

  const report = {
    schemaVersion: 1,
    suite: "spike",
    runId: opts.runId,
    startedAt,
    endedAt: nowIso(),
    ci: ciContext(),
    environment: {
      runnerImage: process.env.ImageOS ?? null,
      macosVersion: await macosVersion(),
      xcode: xcode.version,
      xcodeBuild: xcode.build,
      node: process.versions.node,
    },
    probes: [installedRuntimes],
    runtimes: perRuntime,
    harness: { ok: ok && installedRuntimes.verdict === "pass", failures: perRuntime.filter((entry) => entry.status !== "ok") },
  };
  await writeJson(path.join(outRoot, "spike-report.json"), report);
  log.info("spike report written", {
    file: relativise(path.join(outRoot, "spike-report.json")),
    runtimes: perRuntime.length,
  });
  return report.harness.ok ? EXIT.OK : EXIT.HARNESS;
}

async function main() {
  const startedAt = nowIso();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    for (const problem of error.details?.problems ?? []) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write(`\n${USAGE}\n`);
    return EXIT.USAGE;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  const outRoot = path.resolve(opts.outDir);
  await mkdir(outRoot, { recursive: true });
  const log = createRunnerLog({ filePath: path.join(outRoot, "run.log"), quiet: opts.quiet });
  log.info("probe runner", {
    runId: opts.runId,
    suite: opts.suite,
    out: relativise(outRoot),
    node: process.versions.node,
  });

  const simctl = createSimctl({ log });
  try {
    await assertAppBundle(path.resolve(opts.app));
    const doc = opts.suite === "scenario" ? await loadScenarioDoc(path.resolve(opts.scenariosPath)) : null;

    const list = await simctl.list();
    // Only the two domains 03-report.md section 5 asks for, and only the named fields
    // of each. The devices domain was excluded because it carries container paths from
    // whichever machine ran the suite - but a downloaded runtime's `runtimeRoot` and
    // `bundlePath` sit under the developer's home directory too, and this file is
    // uploaded to a public repository. Projecting the fields is the fix; spreading the
    // raw objects was how a local path could have got out.
    await writeJson(path.join(outRoot, "environment.json"), {
      runtimes: (list.runtimes ?? []).map((runtime) => ({
        name: runtime?.name ?? null,
        version: runtime?.version ?? null,
        identifier: runtime?.identifier ?? null,
        buildversion: runtime?.buildversion ?? null,
        platform: runtime?.platform ?? null,
        isAvailable: runtime?.isAvailable ?? null,
        supportedDeviceTypes: (runtime?.supportedDeviceTypes ?? []).map((type) => ({
          name: type?.name ?? null,
          identifier: type?.identifier ?? null,
        })),
      })),
      devicetypes: (list.devicetypes ?? []).map((type) => ({
        name: type?.name ?? null,
        identifier: type?.identifier ?? null,
        productFamily: type?.productFamily ?? null,
      })),
    });

    return opts.suite === "spike"
      ? await runSpikeSuite({ opts, simctl, list, log, outRoot, startedAt })
      : await runScenarioSuite({ opts, doc, simctl, list, log, outRoot, startedAt });
  } catch (error) {
    if (error instanceof UsageError) {
      log.error(error.message, error.details);
      for (const problem of error.details?.problems ?? []) process.stderr.write(`  - ${problem}\n`);
      return EXIT.USAGE;
    }
    const reason = error instanceof HarnessError ? error.message : `unexpected: ${error.message}`;
    log.error("harness failure", { reason });
    // A harness failure still leaves an artifact saying what failed.
    await writeJson(path.join(outRoot, "report.json"), {
      schemaVersion: 1,
      suite: opts.suite,
      runId: opts.runId,
      startedAt,
      endedAt: nowIso(),
      ci: ciContext(),
      environment: null,
      scenarios: [],
      totals: null,
      harness: { ok: false, reason, failures: [], warnings: [], skipped: [] },
    }).catch(() => {});
    return EXIT.HARNESS;
  }
}

const code = await main();
process.exitCode = code;
