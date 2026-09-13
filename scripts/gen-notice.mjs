#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates NOTICE from lists.json (attribution, licence, source URL for every
// filter list) plus VERSIONS.json (third-party software we link or bundle).
//
//   node scripts/gen-notice.mjs --write     rewrite NOTICE
//   node scripts/gen-notice.mjs --check     fail when NOTICE differs (CI)
//   node scripts/gen-notice.mjs             print the generated file to stdout
//
// A list cannot be added without its attribution: `npm run notice:check` is part
// of the test workflow, so NOTICE and lists.json can never drift apart
// (PIPELINE sections 5 and 20).
//
// Exit codes: 0 ok, 2 usage/missing input, 3 NOTICE is out of date or a list is
// missing a licence field.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.join(import.meta.dirname, ".."));
const LISTS = path.join(ROOT, "lists.json");
const VERSIONS = path.join(ROOT, "VERSIONS.json");
const NOTICE = path.join(ROOT, "NOTICE");

/** Fixed: a generated file must not change because the clock moved. */
const COPYRIGHT_YEAR = "2026";
const COPYRIGHT_HOLDER = "the Janus filters authors";

const REQUIRED_LIST_FIELDS = ["id", "title", "license", "licenseUrl", "attribution"];

class GenError extends Error {
  constructor(message, exitCode = 3) {
    super(message);
    this.exitCode = exitCode;
  }
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") throw new GenError(`missing input file: ${file}`, 2);
    throw new GenError(`invalid JSON in ${file}: ${err.message}`, 3);
  }
}

const HEADER = `NOTICE for janus-filters
========================

This file is generated. Do not edit it by hand: run \`npm run notice\` after
changing lists.json or VERSIONS.json. \`npm run notice:check\` fails the build
when it is out of date.

janus-filters builds the compiled filter bundles used by the Janus browser.

    Copyright (C) ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}

    This program is free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by the Free
    Software Foundation, either version 3 of the License, or (at your option)
    any later version. See LICENSE for the full text.

This repository is public and contains no personal data: no browsing history, no
device identifiers, no account information. The only secret involved in a release
is the bundle signing key, which exists solely as a GitHub environment secret and
is read from the environment inside one CI job.

The published bundles are derived works of the filter lists below. Each list keeps
its own licence and its own copyright holders; redistribution of a bundle carries
those terms with it. Where a list is licensed GPL-3.0 or CC BY-SA, the bundle is
distributed under the same terms, with attribution preserved here.
`;

function listSection(lists) {
  const lines = [];
  lines.push("");
  lines.push("Filter lists");
  lines.push("------------");
  lines.push("");
  lines.push(
    `${lists.length} list${lists.length === 1 ? "" : "s"}, sorted by id. "default" means the ` +
      "list is on for a fresh install;",
  );
  lines.push('"trust" is the CI trust level (an untrusted list is reduced to network and');
  lines.push("cosmetic rules before conversion).");
  const sorted = [...lists].sort((a, b) => byCodeUnit(a.id, b.id));
  for (const l of sorted) {
    const missing = REQUIRED_LIST_FIELDS.filter(
      (f) => typeof l[f] !== "string" || l[f].trim() === "",
    );
    if (missing.length > 0) {
      throw new GenError(
        `lists.json entry ${String(l.id ?? "<no id>")} is missing required field(s): ${missing.join(", ")}`,
      );
    }
    lines.push("");
    lines.push(`### ${l.title} (${l.id})`);
    lines.push("");
    lines.push(`    Attribution: ${l.attribution}`);
    lines.push(`    Licence:     ${l.license}`);
    lines.push(`    Licence URL: ${l.licenseUrl}`);
    if (typeof l.homepage === "string" && l.homepage !== "") {
      lines.push(`    Homepage:    ${l.homepage}`);
    }
    if (typeof l.url === "string" && l.url !== "") {
      lines.push(`    Source:      ${l.url}`);
    } else {
      lines.push("    Source:      maintained in this repository");
    }
    for (const m of Array.isArray(l.mirrors) ? l.mirrors : []) {
      lines.push(`    Mirror:      ${m}`);
    }
    const flags = [
      `trust=${l.trust ?? "unknown"}`,
      `default=${l.default === true ? "on" : "off"}`,
      `role=${l.role ?? "rules"}`,
    ];
    lines.push(`    Flags:       ${flags.join(", ")}`);
    if (typeof l.notes === "string" && l.notes !== "") {
      lines.push(`    Notes:       ${l.notes}`);
    }
  }
  return lines;
}

/** Third-party software, from VERSIONS.json when it carries a notice block. */
function softwareSection(versions) {
  const entries = [];
  const push = (name, version, license, url, note) => {
    if (!name) return;
    entries.push({ name, version: version ?? "", license: license ?? "", url: url ?? "", note });
  };

  const declared = versions?.notice?.software;
  if (Array.isArray(declared) && declared.length > 0) {
    for (const s of declared) push(s.name, s.version, s.license, s.url, s.note);
  } else {
    // Fall back to the pins themselves, so NOTICE is still complete.
    for (const [name, pin] of Object.entries(versions?.swift ?? {})) {
      push(name, pin?.version, pin?.license, pin?.url, pin?.note);
    }
    for (const [name, pin] of Object.entries(versions?.npm ?? {})) {
      push(name, pin?.version, pin?.license, pin?.url, pin?.note);
    }
    for (const [name, pin] of Object.entries(versions?.adguard ?? {})) {
      push(
        name === "scriptlets" ? "@adguard/scriptlets" : name === "extendedCss" ? "@adguard/extended-css" : name,
        typeof pin === "string" ? pin : pin?.version,
        typeof pin === "string" ? undefined : pin?.license,
        typeof pin === "string" ? undefined : pin?.url,
        typeof pin === "string" ? undefined : pin?.note,
      );
    }
  }

  const lines = [];
  lines.push("");
  lines.push("Third-party software");
  lines.push("--------------------");
  lines.push("");
  lines.push("Used by the build pipeline, or bundled into the Janus app alongside these");
  lines.push("bundles. Versions are pinned in VERSIONS.json.");
  for (const s of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
    lines.push("");
    lines.push(`### ${s.name}${s.version ? ` ${s.version}` : ""}`);
    lines.push("");
    if (s.license) lines.push(`    Licence: ${s.license}`);
    if (s.url) lines.push(`    Source:  ${s.url}`);
    if (s.note) lines.push(`    Note:    ${s.note}`);
  }
  return lines;
}

export async function generate() {
  const lists = await readJson(LISTS);
  const versions = await readJson(VERSIONS);
  const entries = Array.isArray(lists.lists) ? lists.lists : [];
  if (entries.length === 0) throw new GenError("lists.json contains no lists", 3);

  const lines = [HEADER.trimEnd(), ...listSection(entries), ...softwareSection(versions), ""];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}`;
}

async function main(argv) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write && check) throw new GenError("--write and --check are mutually exclusive", 2);

  const generated = await generate();
  if (write) {
    await writeFile(NOTICE, generated, "utf8");
    process.stderr.write(
      `${JSON.stringify({ stage: "gen-notice", event: "written", level: "info", bytes: generated.length })}\n`,
    );
    return;
  }
  if (check) {
    let current;
    try {
      current = await readFile(NOTICE, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new GenError("NOTICE is missing; run `npm run notice`", 3);
      throw err;
    }
    if (current !== generated) {
      const a = current.split("\n");
      const b = generated.split("\n");
      const at = a.findIndex((line, i) => line !== b[i]);
      throw new GenError(
        `NOTICE is out of date (first difference at line ${at + 1}); run \`npm run notice\`\n` +
          `  committed:  ${JSON.stringify(a[at] ?? "<eof>")}\n` +
          `  generated:  ${JSON.stringify(b[at] ?? "<eof>")}`,
      );
    }
    process.stderr.write(
      `${JSON.stringify({ stage: "gen-notice", event: "up-to-date", level: "info" })}\n`,
    );
    return;
  }
  process.stdout.write(generated);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((err) => {
    const code = err instanceof GenError ? err.exitCode : 1;
    process.stderr.write(
      `${JSON.stringify({ stage: "gen-notice", event: "failed", level: "error", message: err.message })}\n`,
    );
    if (code === 1) console.error(err.stack);
    process.exit(code);
  });
}
