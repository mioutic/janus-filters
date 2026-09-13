#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// report.mjs — the job summary and the trend record, from a merged report.
//
//   node Tools/ProbeRunner/report.mjs --dir build/probe/<runId>
//   node Tools/ProbeRunner/report.mjs --report <file> --summary - --no-trend
//   node Tools/ProbeRunner/report.mjs --accumulate <dir> --out trend.ndjson
//
// Options:
//   --dir <dir>        a run directory: reads <dir>/report.json, or
//                      <dir>/spike-report.json for the spike suite
//   --report <file>    read exactly this file instead
//   --summary <file>   append the markdown here; "-" means stdout.
//                      Defaults to $GITHUB_STEP_SUMMARY when that is set.
//   --markdown <file>  also write the markdown as a file (default <dir>/summary.md)
//   --trend <file>     write the trend record (default <dir>/trend.json)
//   --no-trend         do not write a trend record
//   --artifact <name>  the artifact name for the footer (default: derived from ci)
//   --accumulate <dir> merge a directory of trend.json files into ndjson
//   --out <file>       where --accumulate writes; "-" means stdout
//   --quiet            no log line on stderr
//
// This program reads ONE input: a merged report. It never opens a run.json, never
// shells out, and never touches the network — so the summary a human reads and the
// trend a later job accumulates cannot disagree with the report in the artifact
// (00-index.md section 3).
//
// Exit codes:
//   0  the summary was written. Blocking results, page states, failed scenarios
//      and a red spike matrix all exit 0: this program reports measurements, it
//      does not judge them.
//   2  usage, or the report is missing or unparseable — nothing could be reported.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { artifactName, renderSummary } from "./lib/summary.mjs";
import { accumulateDir, buildTrend } from "./lib/trend.mjs";

const FLAGS_WITH_VALUE = new Set(["--dir", "--report", "--summary", "--markdown", "--trend", "--artifact", "--accumulate", "--out"]);
const FLAGS_WITHOUT_VALUE = new Set(["--no-trend", "--quiet", "--help", "-h"]);

function usage(message) {
  if (message) process.stderr.write(`report.mjs: ${message}\n`);
  process.stderr.write(
    [
      "usage: node Tools/ProbeRunner/report.mjs --dir <run dir> [--summary <file>] [--trend <file>]",
      "       node Tools/ProbeRunner/report.mjs --report <file> [--summary -] [--no-trend]",
      "       node Tools/ProbeRunner/report.mjs --accumulate <dir of trend.json files> [--out <file>]",
      "",
      "See docs/probehost/03-report.md sections 3 and 4.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (FLAGS_WITHOUT_VALUE.has(flag)) {
      args[flag.replace(/^--?/, "")] = true;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) usage(`unknown option "${flag}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${flag} needs a value`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args;
}

const log = (quiet, fields) => {
  if (!quiet) process.stderr.write(`${JSON.stringify({ stage: "probe-report", ...fields })}\n`);
};

async function readJson(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    usage(`cannot read ${file}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    usage(`${file} is not valid JSON: ${err.message}`);
  }
  return undefined;
}

/** Appends, because $GITHUB_STEP_SUMMARY may already carry earlier steps' output. */
async function appendSummary(target, markdown) {
  if (target === "-") {
    process.stdout.write(markdown);
    return "stdout";
  }
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await appendFile(target, markdown, "utf8");
  return target;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage();

// ---------------------------------------------------------------------------
// --accumulate: a directory of trend records in, ndjson out (03-report.md 4.3)
// ---------------------------------------------------------------------------
if (args.accumulate) {
  if (args.dir || args.report) usage("--accumulate cannot be combined with --dir or --report");
  const out = args.out ?? "trend.ndjson";
  let existing = "";
  if (out !== "-" && existsSync(out)) existing = await readFile(out, "utf8");
  let merged;
  try {
    merged = await accumulateDir(args.accumulate, { existing });
  } catch (err) {
    usage(err.message);
  }
  if (out === "-") {
    process.stdout.write(merged.ndjson);
  } else {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(out, merged.ndjson, "utf8");
  }
  log(args.quiet, {
    event: "accumulated",
    level: "info",
    from: args.accumulate,
    out,
    found: merged.added,
    total: merged.total,
  });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// the normal path: one report in, markdown and a trend record out
// ---------------------------------------------------------------------------
if (!args.dir && !args.report) usage("one of --dir or --report is required");

let reportPath = args.report ?? null;
if (!reportPath) {
  const candidates = [path.join(args.dir, "report.json"), path.join(args.dir, "spike-report.json")];
  reportPath = candidates.find((file) => existsSync(file)) ?? null;
  if (!reportPath) usage(`neither report.json nor spike-report.json is in ${args.dir}`);
}

const report = await readJson(reportPath);
if (!report || typeof report !== "object") usage(`${reportPath} does not contain a report object`);

const suite = report.suite === "spike" ? "spike" : "scenario";
const runDir = args.dir ?? path.dirname(reportPath);

let markdown;
try {
  markdown = renderSummary(report, { artifact: args.artifact });
} catch (err) {
  usage(`could not render the summary: ${err.message}`);
}

const summaryTarget = args.summary ?? process.env.GITHUB_STEP_SUMMARY ?? null;
let summaryWrittenTo = null;
if (summaryTarget) summaryWrittenTo = await appendSummary(summaryTarget, markdown);

// A copy of the exact markdown travels in the artifact (03-report.md section 5),
// so the summary survives the 90 days after the run page stops being interesting.
const markdownFile = args.markdown ?? path.join(runDir, "summary.md");
if (markdownFile !== "-") {
  await mkdir(path.dirname(path.resolve(markdownFile)), { recursive: true });
  await writeFile(markdownFile, markdown, "utf8");
}

let trendFile = null;
if (suite === "scenario" && !args["no-trend"]) {
  trendFile = args.trend ?? path.join(runDir, "trend.json");
  const record = buildTrend(report);
  await mkdir(path.dirname(path.resolve(trendFile)), { recursive: true });
  await writeFile(trendFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

log(args.quiet, {
  event: "written",
  level: "info",
  suite,
  report: reportPath,
  summary: summaryWrittenTo,
  markdown: markdownFile === "-" ? null : markdownFile,
  trend: trendFile,
  artifact: args.artifact ?? artifactName(report),
  bytes: Buffer.byteLength(markdown, "utf8"),
});
process.exit(0);
