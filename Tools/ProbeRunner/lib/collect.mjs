// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pulling one run's evidence out of the app data container into the artifact tree
// (docs/probehost/02-runner.md section 5 steps 5 and 6, 03-report.md section 5).
//
// Results are plain files, which is the reason ProbeHost is a plain app and not an
// XCTest target: `cp` and `JSON.parse`, no .xcresult and no xcresulttool whose
// output format has already changed incompatibly once (00-index.md section 1).
//
// This module never derives a number from what it copies. Every number in
// report.json comes from a field in some run.json; PNGs and logs are evidence for
// a human, never input to arithmetic.

import { copyFile, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** A single evidence file larger than this is a bug, not evidence. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** How much of a log tail is read when a run hung. */
const MAX_TAIL_BYTES = 1024 * 1024;

/**
 * Copy run.json, run.log and every PNG out of the container run directory.
 * DONE is deliberately not copied: it is a sentinel, not evidence.
 *
 * @returns {Promise<{status: "ok"|"missing"|"unparseable", runJson: object|null,
 *                    files: string[], reason: string|null}>}
 */
export async function collectRun({ containerRunDir, destDir }) {
  let entries;
  try {
    entries = await readdir(containerRunDir, { withFileTypes: true });
  } catch (error) {
    return {
      status: "missing",
      runJson: null,
      files: [],
      reason: `no output directory in the container (${error.code ?? error.message})`,
    };
  }

  await mkdir(destDir, { recursive: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === "DONE") continue;
    const from = path.join(containerRunDir, name);
    try {
      const info = await stat(from);
      if (info.size > MAX_FILE_BYTES) continue;
      await copyFile(from, path.join(destDir, name));
      files.push(name);
    } catch {
      // A file that cannot be copied is noted by its absence from files[]; it is
      // never a reason to fail a measurement that already completed.
    }
  }

  // The run record is run.json for a scenario run and spike.json for a spike run
  // (01-probehost.md section 5, 04-spike.md section 2). Both are written before
  // DONE and both are parsed the same way; nothing else in the directory is.
  const recordName = files.includes("run.json")
    ? "run.json"
    : files.includes("spike.json")
      ? "spike.json"
      : null;
  if (!recordName) {
    return {
      status: "missing",
      runJson: null,
      files,
      reason: "DONE was written but no run.json or spike.json is present",
    };
  }

  let runJson = null;
  try {
    runJson = JSON.parse(await readFile(path.join(destDir, recordName), "utf8"));
  } catch (error) {
    // The raw bytes stay in the artifact as evidence; the row says unparseable.
    return { status: "unparseable", runJson: null, files, reason: `${recordName}: ${error.message}` };
  }
  if (typeof runJson !== "object" || runJson === null || Array.isArray(runJson)) {
    return { status: "unparseable", runJson: null, files, reason: "run.json is not an object" };
  }

  return { status: "ok", runJson, files, reason: null };
}

/** Remove the container run directory so it cannot grow across a long suite. */
export async function cleanContainerRun(containerRunDir) {
  try {
    await rm(containerRunDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The last `maxLines` lines of a file, or null when there is none. A hung run
 * usually says where it hung, and that is worth more than the whole log.
 */
export async function tailLines(filePath, maxLines = 2000) {
  let handle;
  try {
    const info = await stat(filePath);
    if (info.size === 0) return null;
    handle = await open(filePath, "r");
    const length = Math.min(info.size, MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // A partial first line when the file was clipped is dropped rather than shown.
    if (info.size > MAX_TAIL_BYTES && lines.length > 1) lines.shift();
    return `${lines.slice(-maxLines).join("\n")}\n`;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Copy an offline bundle into the container once per install, so every launch can
 * pass -ProbeBundleDir probe/in/bundle (01-probehost.md section 2.1).
 */
export async function stageBundleDir(sourceDir, containerBundleDir) {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`--bundle-dir is unreadable: ${error.code ?? error.message}`);
  }
  await rm(containerBundleDir, { recursive: true, force: true });
  await mkdir(containerBundleDir, { recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await copyFile(path.join(sourceDir, entry.name), path.join(containerBundleDir, entry.name));
    copied += 1;
  }
  if (copied === 0) throw new Error("--bundle-dir holds no files");
  return copied;
}
