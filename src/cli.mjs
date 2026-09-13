#!/usr/bin/env node
// The only entry point. Every stage is also a command, so any stage can be run
// alone against the tree the previous one left behind. PIPELINE section 4.

import { parseArgs } from "node:util";
import path from "node:path";
import process from "node:process";
import { EXIT, PipelineError, usageError } from "./lib/errors.mjs";
import { createContext } from "./lib/ctx.mjs";
import { createLogger } from "./lib/log.mjs";

const USAGE = `janus-filters - build signed WebKit rule-list bundles from public filter lists

  node src/cli.mjs fetch        [--offline] [--only <listId,...>] [--force]
  node src/cli.mjs preprocess   [--only <listId,...>]
  node src/cli.mjs trustgate
  node src/cli.mjs translate
  node src/cli.mjs bucket       [--plan]
  node src/cli.mjs active
  node src/cli.mjs report       [--baseline <dir with yesterday's reports>]
  node src/cli.mjs pack         [--version <int>] [--flavours ios17,ios26]
                                [--splice-active] [--prepare-payloads]
                                [--previous <manifest>] [--base-url <url>]
                                [--mirrors <url,...>] [--allow-partial-flavours]
                                [--allow-unvalidated]
  node src/cli.mjs sign         --manifest build/dist/manifest.json [--sig <path>]
  node src/cli.mjs verify       --manifest <path> --sig <path> [--key <base64>]
                                [--dir <payload dir>] [--require-complete]
                                [--skip-age] [--skip-hashes]
  node src/cli.mjs build        [--offline] [--only <listId,...>]

Global flags: --build-dir <path> (default build), --config-dir <path> (default config),
              --lists <path> (default lists.json), --json (summary to stdout), --quiet

Logs are JSON lines on stderr. stdout carries only the machine-readable summary,
and only with --json.`;

const GLOBAL_FLAGS = ["build-dir", "config-dir", "lists", "json", "quiet", "help"];

/** Which stage-specific flags each command accepts. */
const COMMANDS = {
  fetch: { module: "./stages/fetch.mjs", flags: ["offline", "only", "force"] },
  preprocess: { module: "./stages/preprocess.mjs", flags: ["only"] },
  trustgate: { module: "./stages/trustgate.mjs", flags: [] },
  translate: { module: "./stages/translate.mjs", flags: [] },
  bucket: { module: "./stages/bucket.mjs", flags: ["plan"] },
  active: { module: "./stages/active.mjs", flags: [] },
  report: { module: "./stages/report.mjs", flags: ["baseline"] },
  pack: {
    module: "./stages/pack.mjs",
    flags: [
      "version",
      "flavours",
      "splice-active",
      "prepare-payloads",
      "compress",
      "previous",
      "base-url",
      "mirrors",
      "allow-partial-flavours",
      "allow-unvalidated",
    ],
    external: true,
  },
  sign: { module: "./stages/sign.mjs", flags: ["manifest", "sig"], external: true },
  verify: {
    module: "./stages/verify.mjs",
    flags: ["manifest", "sig", "key", "dir", "require-complete", "skip-age", "skip-hashes"],
    external: true,
  },
  build: { module: null, flags: ["offline", "only"] },
};

/** The order `build` runs. pack, sign and publish are separate by design. */
const BUILD_STAGES = [
  "fetch",
  "preprocess",
  "trustgate",
  "translate",
  "bucket",
  "active",
  "report",
];

const OPTIONS = {
  "build-dir": { type: "string", default: "build" },
  "config-dir": { type: "string", default: "config" },
  lists: { type: "string", default: "lists.json" },
  json: { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
  offline: { type: "boolean", default: false },
  force: { type: "boolean", default: false },
  plan: { type: "boolean", default: false },
  only: { type: "string" },
  baseline: { type: "string" },
  version: { type: "string" },
  flavours: { type: "string" },
  manifest: { type: "string" },
  sig: { type: "string" },
  key: { type: "string" },
  dir: { type: "string" },
  previous: { type: "string" },
  "base-url": { type: "string" },
  mirrors: { type: "string" },
  "allow-partial-flavours": { type: "boolean", default: false },
  "allow-unvalidated": { type: "boolean", default: false },
  "require-complete": { type: "boolean", default: false },
  "skip-age": { type: "boolean", default: false },
  "skip-hashes": { type: "boolean", default: false },
  "splice-active": { type: "boolean", default: false },
  "prepare-payloads": { type: "boolean", default: false },
  compress: { type: "boolean", default: false },
};

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    return { command: null, values };
  }
  if (positionals.length > 1) {
    throw usageError(`expected one command, got: ${positionals.join(" ")}`);
  }
  const command = positionals[0];
  const spec = COMMANDS[command];
  if (!spec) {
    throw usageError(`unknown command "${command}"; try --help`);
  }
  const allowed = new Set([...GLOBAL_FLAGS, ...spec.flags]);
  for (const [name, value] of Object.entries(values)) {
    const wasGiven = OPTIONS[name].type === "boolean" ? value === true : value !== undefined;
    if (wasGiven && !allowed.has(name)) {
      throw usageError(`${command} does not accept --${name}`);
    }
  }
  return { command, values, spec };
}

function contextOptions(command, values) {
  const only = values.only
    ? values.only
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : null;
  if (values.only !== undefined && (only === null || only.length === 0)) {
    throw usageError("--only needs at least one list id");
  }
  let version = null;
  if (values.version !== undefined) {
    if (!/^\d+$/.test(values.version)) throw usageError("--version must be a non-negative integer");
    version = Number(values.version);
  }
  const flavours = values.flavours
    ? values.flavours
        .split(",")
        .map((flavour) => flavour.trim())
        .filter((flavour) => flavour.length > 0)
    : ["ios17", "ios26"];
  return {
    stage: command,
    buildDir: values["build-dir"],
    configDir: values["config-dir"],
    listsPath: values.lists,
    quiet: values.quiet,
    json: values.json,
    offline: values.offline,
    force: values.force,
    plan: values.plan,
    only,
    baseline: values.baseline ?? null,
    flavours,
    version,
    manifestPath: values.manifest ?? null,
    signaturePath: values.sig ?? null,
    publicKey: values.key ?? null,
  };
}

async function loadStage(command, spec) {
  try {
    return await import(spec.module);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && spec.external) {
      throw usageError(
        `the ${command} stage (${spec.module}) is not present in this checkout; ` +
          "pack, sign and verify ship with the release side of the pipeline",
      );
    }
    throw error;
  }
}

/**
 * pack, sign and verify parse their own kebab-case flags (they depend on node:
 * built-ins only, so they never import lib/ctx.mjs). They get the raw parseArgs
 * values plus the resolved directories; every other stage gets the full context.
 */
function externalContext(values) {
  return {
    buildDir: path.resolve(values["build-dir"]),
    configDir: path.resolve(values["config-dir"]),
    rootDir: process.cwd(),
    listsPath: path.resolve(values.lists),
    versionsPath: path.resolve("VERSIONS.json"),
    args: values,
  };
}

async function runStage(command, values) {
  const spec = COMMANDS[command];
  const stage = await loadStage(command, spec);
  if (typeof stage.run !== "function") {
    throw usageError(`${spec.module} does not export run(ctx)`);
  }
  if (spec.external) return stage.run(externalContext(values));
  const options = contextOptions(command, values);
  const ctx = await createContext(options);
  ctx.args = options;
  return stage.run(ctx);
}

async function runBuild(values) {
  const summaries = {};
  for (const command of BUILD_STAGES) {
    const spec = COMMANDS[command];
    // --offline is a property of the run, not of one stage: fetch honours it and
    // preprocess needs it too, because an !#include is a network read.
    const options = contextOptions(command, { ...values });
    const ctx = await createContext(options);
    ctx.args = options;
    const stage = await loadStage(command, spec);
    summaries[command] = await stage.run(ctx);
  }
  return summaries;
}

async function main() {
  const { command, values } = parse(process.argv.slice(2));
  if (command === null) {
    process.stderr.write(USAGE + "\n");
    return EXIT.OK;
  }
  const summary = command === "build" ? await runBuild(values) : await runStage(command, values);
  if (values.json && summary !== undefined) {
    process.stdout.write(JSON.stringify(summary) + "\n");
  }
  return EXIT.OK;
}

try {
  process.exitCode = await main();
} catch (error) {
  const log = createLogger("cli", { quiet: false });
  if (error instanceof PipelineError) {
    log.error("failed", { message: error.message, exit: error.code, ...error.details });
    process.exitCode = error.code;
  } else if (Number.isInteger(error?.exitCode)) {
    // StageError from pack/sign/verify: same exit-code table, different class.
    log.error("failed", { message: error.message, exit: error.exitCode, ...(error.fields ?? {}) });
    process.exitCode = error.exitCode;
  } else {
    log.error("internal-error", { message: error?.message ?? String(error) });
    if (error?.stack) process.stderr.write(error.stack + "\n");
    process.exitCode = EXIT.INTERNAL;
  }
}
