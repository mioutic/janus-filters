// SPDX-License-Identifier: GPL-3.0-or-later
//
// One work item: stage the scenario into the app container, launch ProbeHost
// detached, wait for the DONE sentinel against a deadline, collect, clean
// (docs/probehost/02-runner.md sections 5, 6 and 7).
//
// `simctl launch` exits as soon as the app is launched and reports the launch
// result, not the app's exit status (00-index.md section 1). The app therefore
// mirrors its exit code into run.json (`harness.exitCode`) and writes DONE as its
// last act, after run.json is closed and synced. Polling for DONE is the whole
// completion protocol: there is no partial JSON to guard against.

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { collectRun, cleanContainerRun, tailLines } from "./collect.mjs";

/** 02-runner.md section 5 step 3. */
export const POLL_INTERVAL_MS = 250;

/** 02-runner.md section 6: the runner's deadline is the app's budget plus slack. */
export const RUNNER_SLACK_MS = 45_000;

const CONTAINER_ROOT = "Documents/probe";
const IN_SCENARIO = "probe/in/scenario.json";
const IN_BUNDLE = "probe/in/bundle";

/** Host-side paths inside the app data container. */
export function containerPaths(dataContainer, runId) {
  const root = path.join(dataContainer, CONTAINER_ROOT);
  return {
    root,
    inDir: path.join(root, "in"),
    scenarioFile: path.join(root, "in", "scenario.json"),
    bundleDir: path.join(root, "in", "bundle"),
    outDir: path.join(root, "out", runId),
    doneFile: path.join(root, "out", runId, "DONE"),
    runJson: path.join(root, "out", runId, "run.json"),
    runLog: path.join(root, "out", runId, "run.log"),
  };
}

/**
 * The `-Probe*` argv of 01-probehost.md section 2.1. Pure, so a change to the
 * launch contract is caught by a unit test and not by a booted simulator.
 */
export function buildLaunchArgs(item, opts) {
  const args = ["-ProbeSuite", item.suite ?? "scenario", "-ProbeRunId", item.runId];
  if ((item.suite ?? "scenario") === "scenario") {
    args.push("-ProbeMode", item.mode, "-ProbeScenario", IN_SCENARIO);
  }
  args.push("-ProbeOut", `probe/out/${item.runId}`);
  if (opts.bundleDir) args.push("-ProbeBundleDir", IN_BUNDLE);
  else if (opts.manifestUrl) args.push("-ProbeManifestUrl", opts.manifestUrl);
  const payload = item.scenario?.payload;
  if (payload) {
    args.push("-ProbeStepTimeoutMs", String(payload.timeoutMs));
    args.push("-ProbeBudgetMs", String(payload.budgetMs));
    args.push("-ProbeScreenshots", payload.screenshots ? "1" : "0");
  }
  if (opts.console) args.push("-ProbeVerbose", "1");
  return args;
}

/** The app's whole-run budget plus the runner's slack. */
export function deadlineMsFor(item, opts = {}) {
  const budget = item.scenario?.payload?.budgetMs ?? 240_000;
  return budget + (opts.slackMs ?? RUNNER_SLACK_MS);
}

/** Where this attempt's files land under build/probe/<suiteRunId>/. */
export function artifactDirFor(item) {
  const base = path.posix.join(item.scenarioId, item.mode ?? "spike", String(item.repeat ?? 1));
  return item.attempt > 1 ? path.posix.join(base, `attempt-${item.attempt}`) : base;
}

/** Write the one scenario this launch measures, and clear any stale output. */
export async function stageScenario(dataContainer, item) {
  const paths = containerPaths(dataContainer, item.runId);
  await mkdir(paths.inDir, { recursive: true });
  await rm(paths.outDir, { recursive: true, force: true });
  if (item.scenario?.payload) {
    await writeFile(paths.scenarioFile, `${JSON.stringify(item.scenario.payload, null, 2)}\n`, "utf8");
  }
  return paths;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll for DONE every 250 ms until the deadline.
 * @returns {Promise<{done: boolean, waitedMs: number}>}
 */
export async function waitForDone(doneFile, deadlineMs, { pollMs = POLL_INTERVAL_MS, now = Date.now } = {}) {
  const started = now();
  for (;;) {
    if (await exists(doneFile)) return { done: true, waitedMs: now() - started };
    if (now() - started >= deadlineMs) return { done: false, waitedMs: now() - started };
    await sleep(pollMs);
  }
}

/**
 * 02-runner.md section 7. Retry exactly once, and only when the harness failed.
 * Never retry a completed measurement: a second attempt at a site that blocked
 * nothing is how a harness starts lying.
 */
export function shouldRetry(result) {
  if (!result || result.attempt >= 2) return false;
  switch (result.status) {
    case "timeout":
    case "unparseable":
    case "missing":
    case "harness-failed":
      return true;
    case "ok":
      // 70 internal, 75 tempfail. 64 usage, 65 bundle and 73 cantcreate are never
      // retried: they are a runner bug or a broken published bundle, and both
      // deserve to fail loudly rather than be papered over by a second attempt.
      return result.exitCode === 70 || result.exitCode === 75;
    default:
      return false;
  }
}

/** A sick simulator, as opposed to a site that behaved badly. */
export function isInternalFailure(result) {
  if (!result) return false;
  if (result.status === "ok") return result.exitCode === 70;
  return result.status !== "skipped";
}

/**
 * Run one work item end to end. Never throws for anything a site did: every
 * failure becomes a record the report can carry (02-runner.md section 9).
 *
 * @returns {Promise<object>} the work-item result
 */
export async function runWorkItem({ simctl, udid, bundleId, dataContainer, item, opts, outRoot, log }) {
  const started = Date.now();
  const artifactDir = artifactDirFor(item);
  const destDir = path.join(outRoot, ...artifactDir.split("/"));
  const base = {
    runId: item.runId,
    scenarioId: item.scenarioId,
    mode: item.mode ?? null,
    repeat: item.repeat ?? 1,
    attempt: item.attempt ?? 1,
    order: item.order ?? null,
    dir: artifactDir,
    files: [],
    runJson: null,
    exitCode: null,
    harnessStatus: null,
    pageState: null,
    reason: null,
  };

  let paths;
  try {
    paths = await stageScenario(dataContainer, item);
    await mkdir(destDir, { recursive: true });
  } catch (error) {
    return { ...base, status: "harness-failed", reason: `staging failed: ${error.code ?? error.message}`, durationMs: Date.now() - started };
  }

  const args = buildLaunchArgs(item, opts);
  const deadline = deadlineMsFor(item, opts);
  try {
    const launched = await simctl.launch(udid, bundleId, args, {
      console: Boolean(opts.console),
      // A detached launch returns as soon as the app starts, so the default
      // launch timeout is right. --console-pty instead blocks until the app
      // exits, so that one call must be allowed the whole run budget.
      timeoutMs: opts.console ? deadline : undefined,
    });
    log?.debug?.("launched", { runId: item.runId, pid: launched.pid });
  } catch (error) {
    return { ...base, status: "harness-failed", reason: `launch failed: ${error.message}`, durationMs: Date.now() - started };
  }

  const { done, waitedMs } = await waitForDone(paths.doneFile, deadline);

  if (!done) {
    // Evidence first, then stop the one app inside the one simulator we started.
    const shotPath = path.join(destDir, "timeout.png");
    const shot = await simctl.screenshot(udid, shotPath).catch(() => false);
    await simctl.terminate(udid, bundleId).catch(() => false);
    const tail = await tailLines(paths.runLog, 2000);
    const collected = await collectRun({ containerRunDir: paths.outDir, destDir });
    if (tail) {
      await writeFile(path.join(destDir, "run.log"), tail, "utf8").catch(() => {});
    }
    await cleanContainerRun(paths.outDir);
    const files = [...collected.files];
    if (shot) files.push("timeout.png");
    if (tail) files.push("run.log");
    return {
      ...base,
      status: "timeout",
      reason: `no DONE sentinel after ${waitedMs} ms (deadline ${deadline} ms)`,
      files: [...new Set(files)],
      durationMs: Date.now() - started,
    };
  }

  const collected = await collectRun({ containerRunDir: paths.outDir, destDir });
  await cleanContainerRun(paths.outDir);

  if (collected.status !== "ok") {
    return {
      ...base,
      status: collected.status,
      reason: collected.reason,
      files: collected.files,
      durationMs: Date.now() - started,
    };
  }

  const run = collected.runJson;
  return {
    ...base,
    status: "ok",
    files: collected.files,
    runJson: run,
    exitCode: run?.harness?.exitCode ?? null,
    harnessStatus: run?.harness?.status ?? null,
    pageState: run?.pageState?.state ?? null,
    waitedMs,
    durationMs: Date.now() - started,
  };
}

/** A retry keeps the same simulator and gets a distinct runId (section 7). */
export function retryItem(item) {
  return {
    ...item,
    attempt: (item.attempt ?? 1) + 1,
    runId: `${item.runId}-r2`,
  };
}
