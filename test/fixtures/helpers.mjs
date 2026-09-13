// Shared test scaffolding. Not a test file: it lives under fixtures so node:test
// never picks it up.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "../../src/lib/ctx.mjs";
import { nullLogger } from "../../src/lib/log.mjs";

export const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(FIXTURES, "..", "..");
export const FIXTURE_LISTS = path.join(FIXTURES, "lists", "lists.json");
export const CONFIG_DIR = path.join(REPO, "config");

export async function tempBuildDir() {
  return mkdtemp(path.join(os.tmpdir(), "janus-filters-test-"));
}

export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

/** A context wired to the fixture list set, an offline run and a silent logger. */
export async function testContext(options = {}) {
  const buildDir = options.buildDir ?? (await tempBuildDir());
  const ctx = await createContext({
    stage: options.stage ?? "test",
    buildDir,
    configDir: options.configDir ?? CONFIG_DIR,
    listsPath: options.listsPath ?? FIXTURE_LISTS,
    quiet: true,
    offline: options.offline ?? true,
    plan: options.plan ?? false,
    only: options.only ?? null,
    baseline: options.baseline ?? null,
    logger: nullLogger(options.stage ?? "test"),
  });
  return ctx;
}

/** Runs the offline stages in order and returns their summaries. */
export async function runPipeline(options = {}) {
  const buildDir = options.buildDir ?? (await tempBuildDir());
  const stages = options.stages ?? [
    "fetch",
    "preprocess",
    "trustgate",
    "translate",
    "bucket",
    "active",
    "report",
  ];
  const summaries = {};
  for (const stage of stages) {
    const module = await import("../../src/stages/" + stage + ".mjs");
    const ctx = await testContext({ ...options, stage, buildDir });
    summaries[stage] = await module.run(ctx);
  }
  return { buildDir, summaries };
}
