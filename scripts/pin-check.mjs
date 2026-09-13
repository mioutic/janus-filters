#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Verifies every pin in VERSIONS.json against the files that consume it, and
// re-checks the public-repo hygiene rules that can be checked mechanically
// (PIPELINE sections 17.2, 17.4 and 20).
//
//   node scripts/pin-check.mjs [--json] [--online]
//
// Checks, in order:
//   1. package.json      exact dependency versions, engines, licence, type
//   2. package-lock.json the same versions actually locked (when present)
//   3. workflows         every `uses:` pinned to the recorded commit SHA,
//                        every runner label pinned (never macos-latest)
//   4. Swift packages    SafariConverterLib / swift-argument-parser exact pins,
//                        Package.resolved committed and in agreement
//   5. signing           the pinned public key derives the pinned keyId, and the
//                        code and the contract agree with both
//   6. budgets           the numbers in the code match VERSIONS.json
//   7. hygiene           no private keys, no local paths in committed text
//   8. online (--online) every actions/* tag and SwiftPM tag resolved through the
//                        GitHub API to the commit recorded beside it, and the npm
//                        integrity resolved through the registry (DESIGN 10.3).
//                        Off by default so 1-7 still run with no network.
//
// Exit codes: 0 all pins agree, 2 usage/missing VERSIONS.json, 3 a pin disagrees.

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { HARD_CAP_RULES, MANIFEST_MAX_BYTES } from "../src/stages/pack.mjs";
import {
  KEY_ID,
  MAX_AGE_DAYS,
  PUBLIC_KEY_BASE64,
  keyIdFromRawPublicKey,
} from "../src/stages/verify.mjs";

const ROOT = path.resolve(path.join(import.meta.dirname, ".."));
const failures = [];
const warnings = [];
const checks = [];

const ok = (name) => checks.push({ name, status: "ok" });
const bad = (name, detail) => {
  checks.push({ name, status: "fail", detail });
  failures.push(`${name}: ${detail}`);
};
const warn = (name, detail) => {
  checks.push({ name, status: "warn", detail });
  warnings.push(`${name}: ${detail}`);
};

async function readJson(file, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" && optional) return undefined;
    if (err.code === "ENOENT") {
      process.stderr.write(`pin-check: missing ${path.relative(ROOT, file)}\n`);
      process.exit(2);
    }
    process.stderr.write(`pin-check: invalid JSON in ${path.relative(ROOT, file)}: ${err.message}\n`);
    process.exit(3);
  }
}

const versions = await readJson(path.join(ROOT, "VERSIONS.json"));

// -------------------------------------------------------------------------
// 1. package.json
// -------------------------------------------------------------------------
{
  const pkg = await readJson(path.join(ROOT, "package.json"));
  const nodeMajor = versions.toolchain?.nodeMajor;
  const wantEngine = `>=${nodeMajor}.0.0 <${Number(nodeMajor) + 1}`;
  if (pkg.engines?.node === wantEngine) ok("package.json engines.node");
  else bad("package.json engines.node", `expected "${wantEngine}", found "${String(pkg.engines?.node)}"`);

  if (pkg.type === "module") ok("package.json type=module");
  else bad("package.json type", `expected "module", found "${String(pkg.type)}"`);

  if (pkg.license === "GPL-3.0-or-later") ok("package.json license");
  else bad("package.json license", `expected "GPL-3.0-or-later", found "${String(pkg.license)}"`);

  if (pkg.private === true) ok("package.json private");
  else bad("package.json private", "must be true: this package is never published to npm");

  const pinnedNpm = versions.npm ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const [name, range] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range)) {
      bad(`dependency ${name}`, `must be an exact version, found "${range}"`);
      continue;
    }
    const pin = pinnedNpm[name];
    if (!pin) bad(`dependency ${name}`, "is not recorded in VERSIONS.json npm");
    else if (pin.version !== range) {
      bad(`dependency ${name}`, `package.json has ${range}, VERSIONS.json pins ${pin.version}`);
    } else ok(`dependency ${name}@${range}`);
  }
  for (const name of Object.keys(pinnedNpm)) {
    if (!(name in deps)) bad(`dependency ${name}`, "is pinned in VERSIONS.json but not used by package.json");
  }
}

// -------------------------------------------------------------------------
// 2. package-lock.json
// -------------------------------------------------------------------------
{
  const lock = await readJson(path.join(ROOT, "package-lock.json"), { optional: true });
  if (!lock) {
    warn("package-lock.json", "not committed; CI falls back to `npm install` and the npm cache key is empty");
  } else {
    for (const [name, pin] of Object.entries(versions.npm ?? {})) {
      const entry = lock.packages?.[`node_modules/${name}`];
      if (!entry) bad(`lock ${name}`, "missing from package-lock.json");
      else if (entry.version !== pin.version) {
        bad(`lock ${name}`, `locked ${entry.version}, VERSIONS.json pins ${pin.version}`);
      } else if (pin.integrity && entry.integrity && entry.integrity !== pin.integrity) {
        bad(`lock ${name}`, "integrity hash differs from the recorded pin");
      } else ok(`lock ${name}@${pin.version}`);
    }
  }
}

// -------------------------------------------------------------------------
// 3. workflows
// -------------------------------------------------------------------------
{
  const dir = path.join(ROOT, ".github", "workflows");
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
  } catch {
    warn("workflows", "no .github/workflows directory");
  }
  const pinnedActions = versions.actions ?? {};
  const seen = new Set();
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      const uses = /^\s*-?\s*uses:\s*(\S+)\s*(?:#\s*(\S+))?/.exec(line);
      if (uses) {
        const ref = uses[1].replace(/^["']|["']$/g, "");
        const comment = uses[2];
        if (ref.startsWith("./")) continue; // local composite action
        const at = ref.lastIndexOf("@");
        const action = ref.slice(0, at);
        const rev = ref.slice(at + 1);
        seen.add(action);
        const pin = pinnedActions[action];
        if (!pin) {
          bad(`${file} uses ${action}`, "is not recorded in VERSIONS.json actions");
        } else if (!/^[0-9a-f]{40}$/.test(rev)) {
          bad(`${file} uses ${action}`, `must be pinned to a 40-hex commit SHA, found "${rev}"`);
        } else if (rev !== pin.sha) {
          bad(`${file} uses ${action}`, `pinned to ${rev}, VERSIONS.json records ${pin.sha}`);
        } else if (comment && comment !== pin.version) {
          bad(`${file} uses ${action}`, `comment says ${comment}, VERSIONS.json records ${pin.version}`);
        } else ok(`${file} uses ${action}@${pin.version}`);
      }
      const runsOn = /^\s*runs-on:\s*(\S+)/.exec(line);
      if (runsOn) {
        const label = runsOn[1].replace(/^["']|["']$/g, "");
        if (label.startsWith("${{")) continue;
        const allowed = [versions.toolchain?.runnerUbuntu, versions.toolchain?.runnerMacos];
        if (label === "macos-latest") {
          bad(`${file} runs-on`, "macos-latest is forbidden: the macOS runner image is pinned");
        } else if (!allowed.includes(label)) {
          bad(`${file} runs-on`, `"${label}" is not one of the pinned runners ${allowed.join(", ")}`);
        } else ok(`${file} runs-on ${label}`);
      }
    }
  }
  for (const action of Object.keys(pinnedActions)) {
    if (!seen.has(action)) warn(`action ${action}`, "is pinned in VERSIONS.json but no workflow uses it");
  }
}

// -------------------------------------------------------------------------
// 4. Swift packages
// -------------------------------------------------------------------------
{
  const toolsDir = path.join(ROOT, "Tools");
  let tools = [];
  try {
    tools = (await readdir(toolsDir)).sort();
  } catch {
    warn("Tools", "no Tools directory yet; the Swift pins are unverified");
  }
  for (const tool of tools) {
    const pkgSwift = path.join(toolsDir, tool, "Package.swift");
    if (!existsSync(pkgSwift)) continue;
    const text = await readFile(pkgSwift, "utf8");
    for (const [name, pin] of Object.entries(versions.swift ?? {})) {
      if (pin.direct === false || !text.includes(name)) continue;
      const v = pin.version.replace(/\./g, "\\.");
      // Both spellings SwiftPM accepts: .exact("x") and exact: "x".
      const exact = new RegExp(`(?:\\.exact\\(\\s*"${v}"\\s*\\)|\\bexact:\\s*"${v}")`);
      if (exact.test(text)) ok(`${tool}/Package.swift ${name} exact ${pin.version}`);
      else bad(`${tool}/Package.swift ${name}`, `expected an exact pin on ${pin.version}`);
    }
    // A package with no external `.package(...)` dependency resolves to nothing, so
    // SwiftPM writes no Package.resolved and there is nothing to review. Only a
    // package that pulls a dependency in must commit one.
    const hasDependencies = /\.package\s*\(\s*url\s*:/.test(text);
    const resolved = await readJson(path.join(toolsDir, tool, "Package.resolved"), { optional: true });
    if (!resolved) {
      if (hasDependencies) {
        bad(
          `${tool}/Package.resolved`,
          "must be committed so the resolved commit is reviewable (PIPELINE 17.2)",
        );
      } else {
        ok(`${tool}/Package.resolved not needed (no external dependencies)`);
      }
      continue;
    }
    if (!hasDependencies) {
      bad(`${tool}/Package.resolved`, "committed for a package that declares no dependencies");
      continue;
    }
    const pins = resolved.pins ?? resolved.object?.pins ?? [];
    for (const [name, pin] of Object.entries(versions.swift ?? {})) {
      const entry = pins.find(
        (p) =>
          p.identity === name.toLowerCase() ||
          p.package === name ||
          (typeof p.location === "string" && p.location.toLowerCase().includes(name.toLowerCase())),
      );
      if (!entry) {
        if (pin.direct === false) continue; // transitive: absent is fine for this tool
        if (text.includes(name)) bad(`${tool}/Package.resolved`, `${name} is missing`);
        continue;
      }
      const v = entry.state?.version ?? entry.state?.branch ?? "";
      const rev = entry.state?.revision ?? "";
      if (v !== pin.version) {
        bad(`${tool}/Package.resolved ${name}`, `resolved ${v}, pinned ${pin.version}`);
      } else if (pin.revision && rev !== pin.revision) {
        bad(`${tool}/Package.resolved ${name}`, `resolved commit ${rev}, pinned ${pin.revision}`);
      } else ok(`${tool}/Package.resolved ${name}@${v}`);
    }
  }
}

// -------------------------------------------------------------------------
// 5. signing
// -------------------------------------------------------------------------
{
  const s = versions.signing ?? {};
  if (s.algorithm !== "Ed25519") bad("signing.algorithm", `expected Ed25519, found ${String(s.algorithm)}`);
  const raw = Buffer.from(String(s.publicKeyBase64 ?? ""), "base64");
  if (raw.length !== 32) {
    bad("signing.publicKeyBase64", `must decode to 32 raw bytes, got ${raw.length}`);
  } else {
    const derived = keyIdFromRawPublicKey(raw);
    if (derived !== s.keyId) bad("signing.keyId", `key derives ${derived}, VERSIONS.json records ${s.keyId}`);
    else ok(`signing.keyId ${derived}`);
  }
  if (s.publicKeyBase64 === PUBLIC_KEY_BASE64) ok("verify.mjs public key matches the pin");
  else bad("verify.mjs public key", "src/stages/verify.mjs disagrees with VERSIONS.json");
  if (s.keyId === KEY_ID) ok("verify.mjs keyId matches the pin");
  else bad("verify.mjs keyId", "src/stages/verify.mjs disagrees with VERSIONS.json");

  const contract = await readFile(path.join(ROOT, "docs", "CONTRACT.md"), "utf8").catch(() => "");
  if (contract) {
    if (contract.includes(PUBLIC_KEY_BASE64) && contract.includes(KEY_ID)) {
      ok("docs/CONTRACT.md carries the public key and keyId");
    } else {
      bad("docs/CONTRACT.md", "does not carry the pinned public key and keyId");
    }
  }
}

// -------------------------------------------------------------------------
// 6. budgets
// -------------------------------------------------------------------------
{
  const b = versions.budgets ?? {};
  const pairs = [
    ["hardCapRules", b.hardCapRules, HARD_CAP_RULES, "src/stages/pack.mjs HARD_CAP_RULES"],
    ["manifestMaxBytes", b.manifestMaxBytes, MANIFEST_MAX_BYTES, "src/stages/pack.mjs MANIFEST_MAX_BYTES"],
    ["maxBundleAgeDays", b.maxBundleAgeDays, MAX_AGE_DAYS, "src/stages/verify.mjs MAX_AGE_DAYS"],
  ];
  for (const [name, pinned, inCode, where] of pairs) {
    if (pinned === inCode) ok(`budget ${name}=${inCode}`);
    else bad(`budget ${name}`, `VERSIONS.json says ${String(pinned)}, ${where} says ${inCode}`);
  }
}

// -------------------------------------------------------------------------
// 7. hygiene (PIPELINE section 20)
// -------------------------------------------------------------------------
{
  const SKIP_DIRS = new Set(["node_modules", "build", ".git", ".github/.cache"]);
  const TEXT = /\.(mjs|js|json|yml|yaml|md|swift|txt|sh|resolved)$/;
  const BANNED = [
    [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, "a private key"],
    [/[A-Za-z]:\\Users\\/, "a local Windows path"],
    [/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  ];
  const files = [];
  const walk = async (dir) => {
    for (const name of await readdir(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const s = await stat(full);
      if (s.isDirectory()) await walk(full);
      else if (TEXT.test(name) || name === "NOTICE" || name === "LICENSE") files.push(full);
    }
  };
  await walk(ROOT);
  let hits = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const [re, what] of BANNED) {
      const m = re.exec(text);
      if (m) {
        // pin-check's own pattern definitions are the one allowed match.
        if (path.resolve(file) === path.resolve(import.meta.filename)) continue;
        hits += 1;
        bad("hygiene", `${path.relative(ROOT, file)} looks like it contains ${what}`);
      }
    }
  }
  if (hits === 0) ok(`hygiene scan (${files.length} files)`);
}

// -------------------------------------------------------------------------
// 8. online resolution (--online, DESIGN 10.3)
// -------------------------------------------------------------------------
// Everything above proves the repository agrees with itself. Only this section can
// catch a pin that does not exist upstream, or a commit that does not belong to the
// tag recorded beside it. It is opt-in because the offline checks must keep working
// with no network at all; both workflows pass --online.
if (process.argv.includes("--online")) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  /** One API call. Never records anything: the caller decides what a miss means. */
  const gh = async (url) => {
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "janus-filters-pin-check",
      "x-github-api-version": "2022-11-28",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(url, { headers });
    } catch (err) {
      return { error: `request failed: ${err.message}` };
    }
    if (response.status === 404) return { notFound: true };
    if (response.status === 403 || response.status === 429) {
      return { rateLimited: `GitHub rate-limited this check (HTTP ${response.status})` };
    }
    if (!response.ok) return { error: `HTTP ${response.status} from ${url}` };
    return { body: await response.json() };
  };

  /**
   * The commit a tag points at, annotated tags dereferenced. Tag spellings differ
   * upstream ("4.3.0" for actions, "v4.3.0" for the Swift packages), so every
   * candidate is tried before anything is called a failure.
   */
  const commitForTag = async (slug, tags) => {
    let last = { notFound: true };
    for (const tag of tags) {
      const ref = await gh(`https://api.github.com/repos/${slug}/git/ref/tags/${tag}`);
      if (ref.body?.object?.sha === undefined) {
        last = ref;
        continue;
      }
      if (ref.body.object.type !== "tag") return { sha: ref.body.object.sha, tag };
      const annotated = await gh(
        `https://api.github.com/repos/${slug}/git/tags/${ref.body.object.sha}`,
      );
      if (annotated.body?.object?.sha === undefined) return annotated;
      return { sha: annotated.body.object.sha, tag };
    }
    return last;
  };

  /** Compares one resolved tag with the recorded commit. */
  const checkTag = async (name, slug, tags, expected) => {
    const result = await commitForTag(slug, tags);
    if (result.rateLimited) return warn(name, result.rateLimited);
    if (result.notFound) return bad(name, `no tag ${tags.join(" or ")} in ${slug}`);
    if (result.error) return bad(name, result.error);
    if (result.sha === expected) return ok(name);
    return bad(name, `tag ${result.tag} is ${result.sha}, VERSIONS.json pins ${expected}`);
  };

  for (const [action, pin] of Object.entries(versions.actions ?? {})) {
    await checkTag(`online ${action}@${pin.version}`, action, [pin.version], pin.sha);
  }

  for (const [id, pin] of Object.entries(versions.swift ?? {})) {
    if (typeof pin !== "object" || !pin?.url || !pin?.version || !pin?.revision) continue;
    const slug = String(pin.url).replace(/^https:[/][/]github[.]com[/]/, "").replace(/[.]git$/, "");
    await checkTag(
      `online ${id}@${pin.version}`,
      slug,
      [`v${pin.version}`, pin.version],
      pin.revision,
    );
  }

  for (const [pkg, pin] of Object.entries(versions.npm ?? {})) {
    if (typeof pin !== "object" || !pin?.version) continue;
    const name = `online npm ${pkg}@${pin.version}`;
    let meta;
    try {
      const response = await fetch(
        `https://registry.npmjs.org/${pkg.split("/").map(encodeURIComponent).join("/")}/${pin.version}`,
        { headers: { accept: "application/json", "user-agent": "janus-filters-pin-check" } },
      );
      if (!response.ok) {
        bad(name, `HTTP ${response.status} from the npm registry`);
        continue;
      }
      meta = await response.json();
    } catch (err) {
      bad(name, `request failed: ${err.message}`);
      continue;
    }
    if (pin.integrity && meta?.dist?.integrity !== pin.integrity) {
      bad(name, `registry integrity ${String(meta?.dist?.integrity)} != VERSIONS.json ${pin.integrity}`);
    } else {
      ok(name);
    }
  }
}

// -------------------------------------------------------------------------
// report
// -------------------------------------------------------------------------
const summary = {
  tool: "pin-check",
  checked: checks.length,
  ok: checks.filter((c) => c.status === "ok").length,
  warnings: warnings.length,
  failures: failures.length,
};
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ...summary, checks }, null, 2)}\n`);
} else {
  for (const w of warnings) process.stderr.write(`warn  ${w}\n`);
  for (const f of failures) process.stderr.write(`FAIL  ${f}\n`);
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}
process.exit(failures.length > 0 ? 3 : 0);
