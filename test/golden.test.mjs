// The determinism suite. PIPELINE section 3: re-running the pipeline on unchanged
// inputs must reproduce every bucket byte for byte, because a byte that moves is
// a new sha256, and a new sha256 is a download the phone did not need.
//
// test/fixtures/golden/ is the committed dry-run tree. A diff here is either a
// deliberate format change - in which case regenerate the golden tree in the same
// commit - or the regression this suite exists to catch.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { FIXTURES, REPO, removeDir, tempBuildDir } from "./fixtures/helpers.mjs";

const GOLDEN = path.join(FIXTURES, "golden");
const LISTS = path.join(FIXTURES, "lists", "lists.json");

function runCli(args, { cwd = REPO } = {}) {
  return spawnSync(process.execPath, [path.join("src", "cli.mjs"), ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function walk(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), relative)));
    } else {
      out.push(relative);
    }
  }
  return out.sort();
}

test("the offline build reproduces the golden tree byte for byte", async () => {
  const buildDir = await tempBuildDir();
  try {
    const result = runCli([
      "build",
      "--offline",
      "--lists",
      LISTS,
      "--build-dir",
      buildDir,
      "--quiet",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.fetch.stage, "fetch");
    assert.equal(summary.report.stage, "report");

    const files = await walk(GOLDEN);
    assert.ok(files.length > 25);
    for (const file of files) {
      const expected = await readFile(path.join(GOLDEN, file));
      const actual = await readFile(path.join(buildDir, file));
      assert.deepEqual(
        actual.toString("utf8"),
        expected.toString("utf8"),
        `${file} differs from the golden tree`,
      );
    }
  } finally {
    await removeDir(buildDir);
  }
});

test("two runs of the same inputs produce identical trees", async () => {
  const first = await tempBuildDir();
  const second = await tempBuildDir();
  try {
    for (const buildDir of [first, second]) {
      const result = runCli(["build", "--offline", "--lists", LISTS, "--build-dir", buildDir, "--quiet"]);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const file of await walk(first)) {
      if (file.startsWith("cache/")) continue; // cache metadata carries fetchedAt
      const a = await readFile(path.join(first, file));
      const b = await readFile(path.join(second, file));
      assert.deepEqual(a.toString("utf8"), b.toString("utf8"), `${file} is not deterministic`);
    }
  } finally {
    await removeDir(first);
    await removeDir(second);
  }
});

test("every generated text file uses LF and ends with exactly one newline", async () => {
  for (const file of await walk(GOLDEN)) {
    const text = (await readFile(path.join(GOLDEN, file))).toString("utf8");
    if (text.length === 0) continue;
    assert.ok(!text.includes("\r"), `${file} contains CR`);
    assert.ok(!text.startsWith("\ufeff"), `${file} starts with a BOM`);
    assert.ok(text.endsWith("\n"), `${file} does not end with a newline`);
    assert.ok(!text.endsWith("\n\n"), `${file} ends with a blank line`);
  }
});

test("the CLI reports usage errors with exit code 2", () => {
  assert.equal(runCli(["--help"]).status, 0);
  assert.equal(runCli([]).status, 0);
  assert.equal(runCli(["nonsense"]).status, 2);
  assert.equal(runCli(["preprocess", "--offline"]).status, 2);
  assert.equal(runCli(["bucket", "--only", "x"]).status, 2);
  assert.equal(runCli(["fetch", "--lists", "no-such-file.json"]).status, 2);
  const unknownList = runCli(["fetch", "--offline", "--lists", LISTS, "--only", "nope"]);
  assert.equal(unknownList.status, 2);
  assert.match(unknownList.stderr, /unknown list id/);
});

test("a stage summary is machine-readable and stdout stays clean without --json", async () => {
  const buildDir = await tempBuildDir();
  try {
    const quiet = runCli(["fetch", "--offline", "--lists", LISTS, "--build-dir", buildDir, "--quiet"]);
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "");
    const json = runCli([
      "fetch",
      "--offline",
      "--lists",
      LISTS,
      "--build-dir",
      buildDir,
      "--quiet",
      "--json",
    ]);
    assert.equal(json.status, 0);
    const summary = JSON.parse(json.stdout);
    assert.equal(summary.lists, 11);
    assert.deepEqual(summary.skipped, []);
    for (const line of json.stderr.split("\n").filter((entry) => entry.length > 0)) {
      const record = JSON.parse(line);
      assert.equal(typeof record.stage, "string");
      assert.equal(typeof record.event, "string");
      assert.ok(["debug", "info", "warn", "error"].includes(record.level));
    }
  } finally {
    await removeDir(buildDir);
  }
});
