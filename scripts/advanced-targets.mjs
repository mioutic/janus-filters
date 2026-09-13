#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Prints "<bucketId> <advancedFileName>" for every bucket in
// build/buckets/index.json, one pair per line, space-separated and sorted.
//
//   node scripts/advanced-targets.mjs [--build-dir build]
//
// The converter appends the advanced rules it cannot express as content rules to
// the file named here (PIPELINE 12, CONTRACT 9.1). Default-on buckets share
// advanced.txt; every opt-in bucket gets advanced.<optInSlug>.txt of its own, so
// a scriptlet from a list the owner never enabled is never fed to FilterEngine.
//
// Exit codes: 2 the index is missing or has no buckets.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const buildDir = path.resolve(flag("build-dir", "build"));
const indexPath = path.join(buildDir, "buckets", "index.json");

let doc;
try {
  doc = JSON.parse(await readFile(indexPath, "utf8"));
} catch (err) {
  process.stderr.write(`advanced-targets: cannot read ${indexPath}: ${err.message}\n`);
  process.exit(2);
}

const buckets = doc.buckets ?? doc;
const ids = Object.keys(buckets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
if (ids.length === 0) {
  process.stderr.write(`advanced-targets: ${indexPath} names no buckets\n`);
  process.exit(2);
}

/** The opt-in slug of a bucket: the recorded one, or the one inside its id. */
function slugOf(id, entry) {
  if (typeof entry?.optInSlug === "string") return entry.optInSlug;
  if (entry?.optIn !== true) return null;
  // janus.<family>.<slug>.<NN|genNN>
  const withoutIndex = id.replace(/[.](gen)?[0-9]+$/, "");
  const prefix = `janus.${entry.family ?? ""}.`;
  return withoutIndex.startsWith(prefix) ? withoutIndex.slice(prefix.length) || null : null;
}

const lines = [];
for (const id of ids) {
  const slug = slugOf(id, buckets[id]);
  lines.push(`${id} ${slug ? `advanced.${slug}.txt` : "advanced.txt"}`);
}
process.stdout.write(`${lines.join("\n")}\n`);
