// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stage: pack (PIPELINE section 15).
//
// Assembles build/dist/ and writes the manifest the Janus app parses
// (docs/CONTRACT.md section 4). Deterministic: the only clock read in the whole
// run happens here, from SOURCE_DATE_EPOCH when it is set.
//
// Two modes:
//
//   pack                     full run: hash every payload, build the manifest.
//                            Every *.lzfse must already exist in build/dist/.
//   pack --prepare-payloads  compression pass only: build the engine tars and
//                            LZFSE-compress everything that is not compressed
//                            yet, then stop. This is what the macOS convert job
//                            runs, because LZFSE encoders live on macOS
//                            (`compression_tool`) and PIPELINE 17.1 puts the
//                            publish job on ubuntu. See docs/PIPELINE.md 15.1.
//
// Exit codes are PIPELINE section 3: 2 usage, 3 budget/policy, 5 integrity.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KEY_ID } from "./verify.mjs";

export const STAGE = "pack";

export const CONTRACT_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;
export const ADVANCED_TEXT_SCHEMA_VERSION = 1;
export const EXPIRY_DAYS = 14;
export const HARD_CAP_RULES = 110000;
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024; // CONTRACT 6 step 1

export const REPO_SLUG = "mioutic/janus-filters";
export const RELEASE_HOST_PREFIX = `https://github.com/${REPO_SLUG}/`;
export const PAGES_HOST_PREFIX = "https://mioutic.github.io/janus-filters/";

export const DEFAULT_FLAVOURS = ["ios17", "ios26"];

/** Fixed top-level manifest key order (CONTRACT 4.2 / 4.5). */
export const MANIFEST_KEY_ORDER = [
  "contractVersion",
  "schemaVersion",
  "layoutVersion",
  "version",
  "issuedAt",
  "expiresAt",
  "keyId",
  "minAppBuild",
  "baseUrl",
  "mirrors",
  "flavours",
  "generator",
  "lists",
  "buckets",
  "advancedRules",
  "engine",
  "payloads",
  "killSwitches",
  "dropped",
  "delta",
];

const KILL_SWITCH_KEYS = [
  "listSuppliedJavaScript",
  "scriptlets",
  "surrogates",
  "advancedRules",
  "extendedCss",
];

// --------------------------------------------------------------------------
// small shared helpers (kept local so this stage depends only on node: built-ins)
// --------------------------------------------------------------------------

export class StageError extends Error {
  constructor(message, exitCode = 1, fields = {}) {
    super(message);
    this.name = "StageError";
    this.exitCode = exitCode;
    this.stage = STAGE;
    this.fields = fields;
  }
}

const fail = (code, message, fields) => {
  throw new StageError(message, code, fields);
};

function log(level, event, fields = {}) {
  if (process.env.JANUS_QUIET === "1" && level === "info") return;
  const line = JSON.stringify({ stage: STAGE, event, level, ...fields });
  process.stderr.write(`${line}\n`);
}

/** Sort by UTF-16 code unit, never localeCompare (PIPELINE section 3). */
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/**
 * Accept either a ctx built by src/cli.mjs or a bare argv array. Unknown
 * shapes degrade to defaults rather than throwing, so a stage can always be
 * run on its own against a build tree.
 */
export function resolveCtx(ctx = {}) {
  const args =
    ctx.args && typeof ctx.args === "object" && !Array.isArray(ctx.args)
      ? ctx.args
      : parseFlags(Array.isArray(ctx.argv) ? ctx.argv : Array.isArray(ctx) ? ctx : []);
  const buildDir = path.resolve(ctx.buildDir ?? args["build-dir"] ?? "build");
  const configDir = path.resolve(ctx.configDir ?? args["config-dir"] ?? "config");
  const rootDir = path.resolve(ctx.rootDir ?? args.root ?? process.cwd());
  const listsPath = path.resolve(ctx.listsPath ?? args.lists ?? path.join(rootDir, "lists.json"));
  const versionsPath = path.resolve(
    ctx.versionsPath ?? args.versions ?? path.join(rootDir, "VERSIONS.json"),
  );
  return { args, buildDir, configDir, rootDir, listsPath, versionsPath };
}

async function readJson(file, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (optional && err.code === "ENOENT") return undefined;
    if (err.code === "ENOENT") fail(2, `missing input file: ${file}`);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(3, `invalid JSON in ${file}: ${err.message}`);
  }
}

async function fileInfo(file) {
  const bytes = await readFile(file);
  return { bytes, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function hashOnly(file) {
  const info = await fileInfo(file);
  return { size: info.size, sha256: info.sha256 };
}

const exists = (p) => existsSync(p);

function pick(obj, ...paths) {
  for (const p of paths) {
    let cur = obj;
    for (const seg of p.split(".")) {
      if (cur === null || typeof cur !== "object" || !(seg in cur)) {
        cur = undefined;
        break;
      }
      cur = cur[seg];
    }
    if (cur !== undefined) return cur;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// LZFSE
// --------------------------------------------------------------------------

/**
 * Encode one file with LZFSE. Apple's `compression_tool` (macOS) is preferred
 * because it is exactly the codec `NSData.decompressed(using:.lzfse)` reads;
 * the reference `lzfse` CLI is accepted as a fallback. There is no LZFSE in
 * Node, which is why compression happens in the macOS job.
 */
export function lzfseEncode(src, dst) {
  // `compression_tool -encode -a lzfse` without -A writes a RAW LZFSE stream, which
  // is exactly what compression_decode_buffer(COMPRESSION_LZFSE) and
  // NSData.decompressed(using: .lzfse) read. -A (block mode) writes a "pbz<algo>"
  // container the app could not read, so it must never be passed.
  const candidates = [
    { cmd: "compression_tool", args: ["-encode", "-a", "lzfse", "-i", src, "-o", dst] },
    { cmd: "xcrun", args: ["compression_tool", "-encode", "-a", "lzfse", "-i", src, "-o", dst] },
    { cmd: "lzfse", args: ["-encode", "-i", src, "-o", dst] },
  ];
  const tried = [];
  for (const { cmd, args } of candidates) {
    const res = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    if (res.error && res.error.code === "ENOENT") {
      tried.push(`${cmd}: not found`);
      continue;
    }
    if (res.status === 0) {
      verifyLzfseRoundTrip(cmd, src, dst);
      return cmd;
    }
    tried.push(`${cmd}: exit ${res.status} ${String(res.stderr ?? "").trim()}`);
  }
  fail(
    3,
    `no LZFSE encoder available to compress ${path.basename(src)} ` +
      `(run the compression pass on macOS: pack --prepare-payloads). Tried: ${tried.join("; ")}`,
  );
}

/**
 * Decode what we just wrote and compare it with the input. The phone has exactly
 * one chance to decompress a payload, so no bundle ships a stream this build could
 * not read back. RuleListValidate does the same for the bucket payloads it writes.
 */
function verifyLzfseRoundTrip(cmd, src, dst) {
  const probe = `${dst}.probe`;
  const args =
    cmd === "lzfse"
      ? ["-decode", "-i", dst, "-o", probe]
      : cmd === "xcrun"
        ? ["compression_tool", "-decode", "-a", "lzfse", "-i", dst, "-o", probe]
        : ["-decode", "-a", "lzfse", "-i", dst, "-o", probe];
  const res = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  try {
    if (res.status !== 0) {
      fail(5, `${path.basename(dst)} could not be decoded back: ${String(res.stderr ?? "").trim()}`);
    }
    const before = readFileSync(src);
    const after = readFileSync(probe);
    if (!before.equals(after)) {
      fail(5, `${path.basename(dst)} does not decompress to ${path.basename(src)} byte for byte`);
    }
  } finally {
    rmSync(probe, { force: true });
  }
}

// --------------------------------------------------------------------------
// deterministic ustar writer (engine payload, CONTRACT 9.3)
// --------------------------------------------------------------------------

const TAR_BLOCK = 512;
const ENGINE_FILES = ["engine.bin", "meta.bin", "rules.bin", "rules.txt"];

function tarHeader(name, size) {
  const h = Buffer.alloc(TAR_BLOCK, 0);
  if (Buffer.byteLength(name) > 100) fail(3, `tar entry name too long: ${name}`);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "ascii"); // mode
  h.write("0000000\0", 108, 8, "ascii"); // uid
  h.write("0000000\0", 116, 8, "ascii"); // gid
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii"); // mtime 0: deterministic
  h.write("        ", 148, 8, "ascii"); // checksum placeholder
  h.write("0", 156, 1, "ascii"); // typeflag: regular file
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/**
 * Tar the four FilterEngine files, flat, sorted, mtime 0. The app rejects any
 * entry that is not one of these names (CONTRACT 9.3), so nothing else goes in.
 */
export async function buildEngineTar(webextDir, outPath) {
  const chunks = [];
  for (const name of ENGINE_FILES) {
    const file = path.join(webextDir, name);
    if (!exists(file)) fail(3, `engine payload incomplete: ${file} is missing`);
    const bytes = await readFile(file);
    chunks.push(tarHeader(name, bytes.length), bytes);
    const pad = (TAR_BLOCK - (bytes.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  const tar = Buffer.concat(chunks);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, tar);
  return { size: tar.length, sha256: createHash("sha256").update(tar).digest("hex") };
}

// --------------------------------------------------------------------------
// manifest serialisation
// --------------------------------------------------------------------------

/**
 * Two-space JSON, UTF-8, LF, and **no trailing newline**: these bytes are the
 * signed bytes and the bytes the app hashes (PIPELINE 15.2, CONTRACT 5).
 */
export function serialiseManifest(manifest) {
  const ordered = {};
  for (const key of MANIFEST_KEY_ORDER) {
    if (manifest[key] !== undefined) ordered[key] = manifest[key];
  }
  for (const key of Object.keys(manifest)) {
    if (!(key in ordered) && manifest[key] !== undefined) ordered[key] = manifest[key];
  }
  return Buffer.from(JSON.stringify(ordered, null, 2), "utf8");
}

// --------------------------------------------------------------------------
// version and time
// --------------------------------------------------------------------------

export function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function issuedAtMs(env = process.env) {
  const sde = env.SOURCE_DATE_EPOCH;
  if (sde !== undefined && sde !== "") {
    const secs = Number(sde);
    if (!Number.isFinite(secs) || secs < 0) fail(2, "SOURCE_DATE_EPOCH is not a positive integer");
    return Math.floor(secs) * 1000;
  }
  return Date.now();
}

export function dateComponent(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return Number(`${y}${m}${day}`) * 100;
}

/**
 * version = YYYYMMDD*100 + N, computed as max(previous + 1, dateComponent) so a
 * misbehaving clock or a same-day re-run still moves forward (PIPELINE 15.2).
 */
export function computeVersion({ issuedMs, previousVersion = 0, requested }) {
  const base = dateComponent(issuedMs);
  let version;
  if (requested !== undefined && requested !== null && requested !== true && requested !== "") {
    version = Number(requested);
    if (!Number.isSafeInteger(version) || version <= 0) {
      fail(2, `--version must be a positive integer, got ${String(requested)}`);
    }
  } else {
    version = Math.max(previousVersion + 1, base);
  }
  if (previousVersion && version <= previousVersion) {
    fail(3, `version ${version} is not greater than the published version ${previousVersion}`);
  }
  if (version - base >= 100 || version < base) {
    log("warn", "version.outside-day", { version, dateComponent: base });
  }
  return version;
}

export function assertUrlAllowed(url, field) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    fail(3, `${field} must be an https URL: ${String(url)}`);
  }
  if (!url.endsWith("/")) fail(3, `${field} must end with "/": ${url}`);
  if (!url.startsWith(RELEASE_HOST_PREFIX) && !url.startsWith(PAGES_HOST_PREFIX)) {
    fail(3, `${field} is outside the pinned origins (CONTRACT 6 step 11): ${url}`);
  }
}

// --------------------------------------------------------------------------
// payload entries
// --------------------------------------------------------------------------

/**
 * One manifest file entry: uncompressed identity plus the compressed download.
 * `sha256`/`size` describe what the app compiles; `downloadSha256`/`downloadSize`
 * let it reject a corrupt download before decompressing (PIPELINE 15.1 step 3).
 */
async function payloadEntry({ srcPath, distPath, distDir, compress }) {
  if (!exists(srcPath)) fail(3, `missing payload source: ${srcPath}`);
  const plain = await hashOnly(srcPath);
  if (!exists(distPath)) {
    if (!compress) {
      fail(
        3,
        `missing compressed payload ${path.relative(distDir, distPath)}; ` +
          "the macOS convert job must run `pack --prepare-payloads`",
      );
    }
    await mkdir(distDir, { recursive: true });
    lzfseEncode(srcPath, distPath);
    log("info", "compressed", { file: path.basename(distPath) });
  }
  const packed = await hashOnly(distPath);
  return {
    file: path.basename(distPath),
    sha256: plain.sha256,
    size: plain.size,
    downloadSha256: packed.sha256,
    downloadSize: packed.size,
  };
}

// --------------------------------------------------------------------------
// advanced-rules payloads (PIPELINE 12, CONTRACT 9.1)
// --------------------------------------------------------------------------

/**
 * `advanced.txt` carries the default-on buckets; `advanced.<optInSlug>.txt`
 * carries one opt-in list's buckets, so a rule from a list the owner never
 * enabled is never fed to FilterEngine. Returns undefined for a file name that
 * is not an advanced payload, null for the default one.
 */
export function advancedSlugOf(name) {
  const match = /^advanced(?:\.(.+))?\.txt$/.exec(name);
  if (!match) return undefined;
  return match[1] ?? null;
}

export function countRuleLines(text) {
  if (text.length === 0) return 0;
  let count = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") count += 1;
  return count;
}

/** Every advanced payload in one converted flavour directory. */
async function advancedFiles(flavourDir) {
  let names;
  try {
    names = await readdir(flavourDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort(byCodeUnit)) {
    const slug = advancedSlugOf(name);
    if (slug === undefined) continue;
    out.push({ name, slug, srcPath: path.join(flavourDir, name) });
  }
  return out.sort((a, b) => byCodeUnit(a.slug ?? "", b.slug ?? ""));
}

const advancedDistName = (flavour, slug) =>
  slug === null ? `advanced.${flavour}.txt.lzfse` : `advanced.${flavour}.${slug}.txt.lzfse`;

// --------------------------------------------------------------------------
// the stage
// --------------------------------------------------------------------------

export async function run(ctx = {}) {
  const { args, buildDir, configDir, listsPath, versionsPath } = resolveCtx(ctx);
  if (args.quiet) process.env.JANUS_QUIET = "1";

  const flavours = String(args.flavours ?? DEFAULT_FLAVOURS.join(","))
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (flavours.length === 0) fail(2, "--flavours must name at least one flavour");

  const dirs = {
    dist: path.join(buildDir, "dist"),
    converted: path.join(buildDir, "converted"),
    validate: path.join(buildDir, "validate"),
    aux: path.join(buildDir, "auxdata"),
    buckets: path.join(buildDir, "buckets"),
    prepared: path.join(buildDir, "prepared"),
    trusted: path.join(buildDir, "trusted"),
    xlated: path.join(buildDir, "xlated"),
    reports: path.join(buildDir, "reports"),
  };
  await mkdir(dirs.dist, { recursive: true });

  // Splice pass (macOS, before RuleListValidate): PIPELINE 15.1 step 1.
  if (args["splice-active"] === true || args["splice-active"] === "true") {
    const results = [];
    for (const flavour of flavours) results.push(await spliceActive({ dirs, flavour }));
    return { stage: STAGE, mode: "splice-active", results };
  }

  const prepareOnly = args["prepare-payloads"] === true || args["prepare-payloads"] === "true";
  const compress = prepareOnly || args.compress === true || args.compress === "true";
  const truthy = (value) => value === true || value === "true";
  const allowUnvalidated = truthy(args["allow-unvalidated"]);
  const allowPartialFlavours = truthy(args["allow-partial-flavours"]);

  const bucketIndex = await readJson(path.join(dirs.buckets, "index.json"));
  const bucketIds = Object.keys(bucketIndex.buckets ?? bucketIndex).sort(byCodeUnit);
  if (bucketIds.length === 0) fail(3, "build/buckets/index.json names no buckets");
  const indexEntries = bucketIndex.buckets ?? bucketIndex;

  // ---- compression pass (macOS) -------------------------------------------
  if (prepareOnly) {
    let made = 0;
    for (const flavour of flavours) {
      for (const id of bucketIds) {
        const src = path.join(dirs.converted, flavour, `${id}.json`);
        const dst = path.join(dirs.dist, `${id}.${flavour}.json.lzfse`);
        if (!exists(src)) fail(3, `missing converted bucket: ${src}`);
        if (!exists(dst)) {
          lzfseEncode(src, dst);
          made += 1;
        }
      }
      for (const adv of await advancedFiles(path.join(dirs.converted, flavour))) {
        const advDst = path.join(dirs.dist, advancedDistName(flavour, adv.slug));
        // LZFSE refuses an empty input and an empty payload carries nothing:
        // pack reports ruleCount 0 with no file instead (CONTRACT 9.1).
        if ((await stat(adv.srcPath)).size === 0) {
          log("warn", "advanced.empty", { flavour, file: adv.name });
          continue;
        }
        if (!exists(advDst)) {
          lzfseEncode(adv.srcPath, advDst);
          made += 1;
        }
      }
      const webext = path.join(dirs.converted, flavour, "engine", ".webext");
      if (exists(webext)) {
        const tarPath = path.join(dirs.converted, flavour, "engine.tar");
        await buildEngineTar(webext, tarPath);
        const engDst = path.join(dirs.dist, `engine.${flavour}.tar.lzfse`);
        if (!exists(engDst)) {
          lzfseEncode(tarPath, engDst);
          made += 1;
        }
      }
    }
    for (const [src, dst] of [
      ["linkcleaner.json", "linkcleaner.json.lzfse"],
      ["popup-index.json", "popup-index.json.lzfse"],
      ["sitefix.json", "sitefix.json.lzfse"],
    ]) {
      const s = path.join(dirs.aux, src);
      const d = path.join(dirs.dist, dst);
      if (!exists(s)) fail(3, `missing aux payload: ${s}`);
      if (!exists(d)) {
        lzfseEncode(s, d);
        made += 1;
      }
    }
    log("info", "prepare.done", { compressed: made });
    return { stage: STAGE, mode: "prepare-payloads", compressed: made };
  }

  // ---- inputs --------------------------------------------------------------
  // CONTRACT 4.2/8.1: a device installs exactly one flavour and finds nothing if
  // its own flavour is absent, so a partial set is never published.
  const missingFlavours = DEFAULT_FLAVOURS.filter((f) => !flavours.includes(f));
  if (missingFlavours.length > 0 && !allowPartialFlavours) {
    fail(
      3,
      `flavours ${missingFlavours.join(", ")} are missing from this bundle; ` +
        "publishing a partial set would leave those devices with no buckets " +
        "(pass --allow-partial-flavours only for a local experiment)",
    );
  }
  const lists = await readJson(listsPath);
  const versions = await readJson(versionsPath, { optional: true }) ?? {};
  const bucketsCfg = await readJson(path.join(configDir, "buckets.json"));
  // The active stage writes { schemaVersion, note, killSwitches: {...} }; a bare
  // map of the five booleans is accepted too, so either shape packs.
  const killSwitchDoc = await readJson(path.join(dirs.aux, "killswitches.json"));
  const killSwitches = killSwitchDoc?.killSwitches ?? killSwitchDoc;

  const layoutVersion = pick(bucketsCfg, "layoutVersion");
  const minAppBuild = pick(bucketsCfg, "minAppBuild");
  if (!Number.isSafeInteger(layoutVersion)) {
    fail(3, "config/buckets.json is missing an integer layoutVersion (PIPELINE 15.2)");
  }
  if (!Number.isSafeInteger(minAppBuild)) {
    fail(3, "config/buckets.json is missing an integer minAppBuild (PIPELINE 15.2)");
  }

  for (const key of KILL_SWITCH_KEYS) {
    if (typeof killSwitches[key] !== "boolean") {
      fail(3, `build/auxdata/killswitches.json: ${key} must be a boolean (CONTRACT 10.4)`);
    }
  }

  const previousPath = path.resolve(
    typeof args.previous === "string" ? args.previous : path.join(buildDir, "previous-manifest.json"),
  );
  const previous = await readJson(previousPath, { optional: true });
  if (previous) log("info", "previous.loaded", { version: previous.version });
  else log("warn", "previous.absent", { path: path.basename(previousPath) });

  const issuedMs = issuedAtMs();
  const issuedAt = rfc3339(issuedMs);
  const expiresAt = rfc3339(issuedMs + EXPIRY_DAYS * 86400 * 1000);
  const version = computeVersion({
    issuedMs,
    previousVersion: Number(previous?.version ?? 0) || 0,
    requested: args.version,
  });

  const baseUrl = String(args["base-url"] ?? `${RELEASE_HOST_PREFIX}releases/download/filters-${version}/`);
  const mirrors = (args.mirrors ? String(args.mirrors).split(",") : [`${PAGES_HOST_PREFIX}v/${version}/`])
    .map((m) => m.trim())
    .filter(Boolean);
  assertUrlAllowed(baseUrl, "baseUrl");
  for (const m of mirrors) assertUrlAllowed(m, "mirrors[]");

  // ---- lists ---------------------------------------------------------------
  const listDefs = Array.isArray(lists.lists) ? lists.lists : [];
  const listById = new Map(listDefs.map((l) => [l.id, l]));
  const manifestLists = [];
  for (const l of listDefs) {
    // The per-list sidecars are what travel in the converter-inputs artifact
    // (PIPELINE 17.1): the full prepared/trusted/xlated texts deliberately do not,
    // so presence must be proved by a sidecar. A skipped list writes none of them.
    const present =
      exists(path.join(dirs.prepared, `${l.id}.stats.json`)) ||
      exists(path.join(dirs.trusted, `${l.id}.gate.json`)) ||
      exists(path.join(dirs.xlated, `${l.id}.xlate.json`)) ||
      exists(path.join(dirs.prepared, `${l.id}.txt`)) ||
      exists(path.join(buildDir, "raw", `${l.id}.txt`)) ||
      exists(path.join(dirs.trusted, `${l.id}.txt`));
    if (!present) {
      if (l.default === true) {
        fail(3, `default-on list ${l.id} was skipped; a partial set is never published (PIPELINE 18)`);
      }
      log("warn", "list.skipped", { listId: l.id });
      continue;
    }
    const entry = {
      id: l.id,
      title: l.title,
      default: l.default === true,
      trust: l.trust,
      license: l.license,
      homepage: l.homepage,
    };
    const ruleCount = await listRuleCount(dirs, l.id);
    if (ruleCount !== undefined) entry.ruleCount = ruleCount;
    manifestLists.push(entry);
  }
  manifestLists.sort((a, b) => byCodeUnit(a.id, b.id));

  // ---- validate reports ----------------------------------------------------
  // PIPELINE 15.1 step 3: proof that WebKit compiled these exact bytes is a
  // required input. Nothing is signed on the strength of a warning.
  const reports = new Map();
  for (const flavour of flavours) {
    const report = await readJson(path.join(dirs.validate, flavour, "report.json"), {
      optional: true,
    });
    const rows = new Map();
    for (const row of report?.buckets ?? report?.results ?? []) {
      if (row?.bucketId) rows.set(row.bucketId, row);
    }
    if (rows.size === 0) {
      if (!allowUnvalidated) {
        fail(
          3,
          `build/validate/${flavour}/report.json names no buckets; ` +
            "RuleListValidate must run before pack (PIPELINE 15.1 step 3)",
        );
      }
      log("warn", "validate.report-missing", { flavour });
    }
    if (report && report.status !== undefined && report.status !== "ok" && !allowUnvalidated) {
      fail(3, `build/validate/${flavour}/report.json reports status ${String(report.status)}`);
    }
    reports.set(flavour, rows);
  }

  // ---- buckets -------------------------------------------------------------
  const prevBuckets = new Map((previous?.buckets ?? []).map((b) => [b.id, b]));
  const buckets = [];
  const changedPerFlavour = new Map(flavours.map((f) => [f, { changedBuckets: 0, changedBytes: 0 }]));

  for (const id of bucketIds) {
    const meta = indexEntries[id] ?? {};
    const sourceLists = [...(meta.sourceLists ?? meta.lists ?? [])].sort(byCodeUnit);
    // The bucket stage already decided this (PIPELINE 10.1): an opt-in group's
    // buckets are opt-in even though default lists' exceptions are replicated into
    // them, which is exactly what recomputing from sourceLists gets wrong.
    const optIn =
      typeof meta.optIn === "boolean"
        ? meta.optIn
        : sourceLists.length > 0 &&
          sourceLists.every((listId) => listById.get(listId)?.default === false);
    const entry = {
      id,
      family: meta.family ?? (id === "janus.active" ? "active" : undefined),
      optIn,
      lists: sourceLists,
      flavours: {},
    };
    if (!entry.family) fail(3, `bucket ${id} has no family in build/buckets/index.json`);

    for (const flavour of flavours) {
      const srcPath = path.join(dirs.converted, flavour, `${id}.json`);
      const distPath = path.join(dirs.dist, `${id}.${flavour}.json.lzfse`);
      if (!exists(srcPath)) {
        fail(3, `flavour ${flavour} is incomplete: ${srcPath} is missing (PIPELINE 18)`);
      }
      const file = await payloadEntry({ srcPath, distPath, distDir: dirs.dist, compress });

      const parsed = JSON.parse(await readFile(srcPath, "utf8"));
      if (!Array.isArray(parsed)) fail(5, `${srcPath} is not a JSON array of content rules`);
      const ruleCount = parsed.length;
      if (ruleCount > HARD_CAP_RULES) {
        fail(3, `bucket ${id} (${flavour}) has ${ruleCount} rules, over the ${HARD_CAP_RULES} cap`);
      }

      const row = reports.get(flavour)?.get(id);
      if (!row) {
        if (!allowUnvalidated) {
          fail(
            3,
            `bucket ${id} (${flavour}) has no row in build/validate/${flavour}/report.json: ` +
              "WebKit never compiled it (PIPELINE 15.1 step 3)",
          );
        }
      } else {
        if (row.sha256 && row.sha256 !== file.sha256) {
          fail(
            5,
            `bucket ${id} (${flavour}): the validator compiled sha256 ${row.sha256}, ` +
              `the bytes being packed are ${file.sha256}`,
          );
        }
        if (row.ruleCount !== undefined && row.ruleCount !== ruleCount) {
          fail(
            5,
            `bucket ${id} (${flavour}): the validator counted ${row.ruleCount} rules, ` +
              `the bytes being packed hold ${ruleCount}`,
          );
        }
      }

      const flavourEntry = {
        file: file.file,
        sha256: file.sha256,
        size: file.size,
        downloadSha256: file.downloadSha256,
        downloadSize: file.downloadSize,
        ruleCount,
      };

      // Carry forward: an unchanged bucket keeps its measured compile time so a
      // re-run neither recompiles nor re-measures it (PIPELINE 15.1 step 4).
      const prevFlavour = prevBuckets.get(id)?.flavours?.[flavour];
      const unchanged = prevFlavour?.sha256 === file.sha256;
      const compileMs = row?.compileMs ?? (unchanged ? prevFlavour?.compileMs : undefined);
      if (Number.isFinite(compileMs)) flavourEntry.compileMs = Math.round(compileMs);
      if (unchanged && prevFlavour.downloadSha256 !== file.downloadSha256) {
        log("warn", "compress.nondeterministic", { bucketId: id, flavour });
      }
      if (!unchanged) {
        const acc = changedPerFlavour.get(flavour);
        acc.changedBuckets += 1;
        acc.changedBytes += file.downloadSize;
      }
      entry.flavours[flavour] = flavourEntry;
    }
    buckets.push(entry);
  }
  buckets.sort((a, b) => byCodeUnit(a.id, b.id));
  if (!buckets.some((b) => b.id === "janus.active")) {
    log("warn", "active.absent", { hint: "janus.active is always installed by the app" });
  }

  // ---- advanced rules, engine, aux payloads --------------------------------
  const advancedRules = {};
  const engine = {};
  const slugToList = new Map(listDefs.map((l) => [l.id.replace(/\./g, "-"), l.id]));
  const defaultLists = manifestLists.filter((l) => l.default === true).map((l) => l.id);
  for (const flavour of flavours) {
    const flavourDir = path.join(dirs.converted, flavour);
    const files = await advancedFiles(flavourDir);
    if (!files.some((f) => f.slug === null)) {
      fail(3, `missing payload source: ${path.join(flavourDir, "advanced.txt")}`);
    }
    const optInAdvanced = [];
    let defaultEntry;
    let defaultCount = 0;
    for (const adv of files) {
      const text = await readFile(adv.srcPath, "utf8");
      const ruleCount = countRuleLines(text);
      let entry;
      if (text.length > 0) {
        entry = await payloadEntry({
          srcPath: adv.srcPath,
          distPath: path.join(dirs.dist, advancedDistName(flavour, adv.slug)),
          distDir: dirs.dist,
          compress,
        });
      } else {
        log("warn", "advanced.empty", { flavour, file: adv.name });
      }
      if (adv.slug === null) {
        defaultEntry = entry;
        defaultCount = ruleCount;
        continue;
      }
      const listId = slugToList.get(adv.slug);
      if (!listId) fail(3, `${adv.name} does not name a list in lists.json (slug ${adv.slug})`);
      if (!entry) continue;
      optInAdvanced.push({ ...entry, ruleCount, lists: [listId] });
    }
    advancedRules[flavour] = {
      ...(defaultEntry ?? {}),
      ruleCount: defaultCount,
      schemaVersion: ADVANCED_TEXT_SCHEMA_VERSION,
      lists: defaultLists,
      ...(optInAdvanced.length > 0
        ? { optIn: optInAdvanced.sort((a, b) => byCodeUnit(a.file, b.file)) }
        : {}),
    };

    const tarPath = path.join(dirs.converted, flavour, "engine.tar");
    const engDist = path.join(dirs.dist, `engine.${flavour}.tar.lzfse`);
    const webext = path.join(dirs.converted, flavour, "engine", ".webext");
    if (!exists(tarPath) && exists(webext) && compress) await buildEngineTar(webext, tarPath);
    if (exists(tarPath) && (exists(engDist) || compress)) {
      const engEntry = await payloadEntry({
        srcPath: tarPath,
        distPath: engDist,
        distDir: dirs.dist,
        compress,
      });
      const engineSchemaVersion =
        (await readJson(path.join(dirs.converted, flavour, "engine", "engine.json"), {
          optional: true,
        }))?.engineSchemaVersion ??
        pick(versions, "engineSchemaVersion", "swift.SafariConverterLib.engineSchemaVersion") ??
        1;
      engine[flavour] = {
        file: engEntry.file,
        engineSchemaVersion,
        sha256: engEntry.sha256,
        size: engEntry.size,
        downloadSha256: engEntry.downloadSha256,
        downloadSize: engEntry.downloadSize,
      };
    } else {
      log("info", "engine.absent", { flavour });
    }
  }

  const payloads = {};
  for (const [key, src, dst] of [
    ["linkcleaner", "linkcleaner.json", "linkcleaner.json.lzfse"],
    ["popupIndex", "popup-index.json", "popup-index.json.lzfse"],
    ["siteFix", "sitefix.json", "sitefix.json.lzfse"],
  ]) {
    const srcPath = path.join(dirs.aux, src);
    const entry = await payloadEntry({
      srcPath,
      distPath: path.join(dirs.dist, dst),
      distDir: dirs.dist,
      compress,
    });
    const schemaVersion = (await readJson(srcPath)).schemaVersion ?? 1;
    payloads[key] = {
      file: entry.file,
      schemaVersion,
      sha256: entry.sha256,
      size: entry.size,
      downloadSha256: entry.downloadSha256,
      downloadSize: entry.downloadSize,
    };
  }

  // ---- dropped summary and delta -------------------------------------------
  const dropped = await droppedSummary(dirs.reports);
  let delta;
  if (previous?.version) {
    let changedBuckets = 0;
    let changedBytes = 0;
    const byFlavour = {};
    for (const [flavour, acc] of changedPerFlavour) {
      byFlavour[flavour] = { changedBuckets: acc.changedBuckets, changedBytes: acc.changedBytes };
      // A device installs one flavour, so the worst flavour is the daily cost.
      changedBuckets = Math.max(changedBuckets, acc.changedBuckets);
      changedBytes = Math.max(changedBytes, acc.changedBytes);
    }
    delta = { previousVersion: previous.version, changedBuckets, changedBytes, byFlavour };
  }

  // ---- manifest ------------------------------------------------------------
  const manifest = {
    contractVersion: CONTRACT_VERSION,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    layoutVersion,
    version,
    issuedAt,
    expiresAt,
    keyId: KEY_ID,
    minAppBuild,
    baseUrl,
    mirrors,
    flavours: [...flavours],
    generator: {
      pipeline: pick(versions, "pipeline") ?? "janus-filters@1",
      safariConverterLib: pick(versions, "swift.SafariConverterLib.version") ?? "4.3.0",
      scriptlets: pick(versions, "adguard.scriptlets.version", "adguard.scriptlets") ?? "2.5.1",
      extendedCss: pick(versions, "adguard.extendedCss.version", "adguard.extendedCss") ?? "2.2.1",
    },
    lists: manifestLists,
    buckets,
    advancedRules,
    engine: Object.keys(engine).length > 0 ? engine : undefined,
    payloads,
    killSwitches: Object.fromEntries(KILL_SWITCH_KEYS.map((k) => [k, killSwitches[k]])),
    dropped,
    delta,
  };

  const bytes = serialiseManifest(manifest);
  if (bytes.length > MANIFEST_MAX_BYTES) {
    fail(3, `manifest is ${bytes.length} bytes, over the app's 4 MiB limit (CONTRACT 6 step 1)`);
  }
  const manifestPath = path.join(dirs.dist, "manifest.json");
  await writeFile(manifestPath, bytes);

  const summary = {
    stage: STAGE,
    version,
    issuedAt,
    expiresAt,
    layoutVersion,
    flavours,
    buckets: buckets.length,
    lists: manifestLists.length,
    manifestBytes: bytes.length,
    distBytes: await distBytes(dirs.dist),
    delta: delta ?? null,
  };
  log("info", "packed", summary);
  return summary;
}

/**
 * PIPELINE 15.1 step 1: prepend the redirect actions from
 * build/auxdata/active-redirects.json to the converted janus.active array and append
 * the folded unbreak exceptions, in the order of section 11.1. The caller
 * re-runs RuleListValidate on the result, because a splice that does not compile
 * must stop the run.
 *
 * Idempotent: a marker records the spliced file's hash, so a re-run of the stage
 * against an already-spliced tree changes nothing.
 */
export async function spliceActive({ dirs, flavour }) {
  const auxPath = path.join(dirs.aux, "active-redirects.json");
  const target = path.join(dirs.converted, flavour, "janus.active.json");
  // The marker lives in aux, never beside the buckets: RuleListValidate treats
  // every *.json in the converted directory as a bucket.
  const markerPath = path.join(dirs.aux, `active-splice.${flavour}.json`);
  if (!exists(auxPath)) {
    log("warn", "splice.no-aux", { flavour, file: "build/auxdata/active-redirects.json" });
    return { flavour, spliced: false, reason: "no active-redirects.json" };
  }
  if (!exists(target)) fail(3, `cannot splice: ${target} is missing`);

  const aux = await readJson(auxPath);
  const redirects = Array.isArray(aux) ? aux : (aux.redirects ?? aux.rules ?? []);
  const exceptions = Array.isArray(aux) ? [] : (aux.exceptions ?? aux.folded ?? aux.unbreak ?? []);
  if (!Array.isArray(redirects) || !Array.isArray(exceptions)) {
    fail(3, "build/auxdata/active-redirects.json must hold arrays of content rules");
  }

  const before = await fileInfo(target);
  const marker = await readJson(markerPath, { optional: true });
  if (marker?.outputSha256 === before.sha256) {
    log("info", "splice.already-applied", { flavour });
    return { flavour, spliced: false, reason: "already spliced" };
  }

  const converted = JSON.parse(before.bytes.toString("utf8"));
  if (!Array.isArray(converted)) fail(5, `${target} is not a JSON array of content rules`);
  const spliced = [...redirects, ...converted, ...exceptions];
  const bytes = Buffer.from(JSON.stringify(spliced), "utf8");
  await writeFile(target, bytes);
  const outputSha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    markerPath,
    `${JSON.stringify(
      {
        flavour,
        redirects: redirects.length,
        converted: converted.length,
        exceptions: exceptions.length,
        inputSha256: before.sha256,
        outputSha256,
        ruleCount: spliced.length,
      },
      null,
      2,
    )}\n`,
  );
  log("info", "spliced", {
    flavour,
    redirects: redirects.length,
    exceptions: exceptions.length,
    ruleCount: spliced.length,
  });
  return { flavour, spliced: true, ruleCount: spliced.length };
}

async function listRuleCount(dirs, listId) {
  const stats = await readJson(path.join(dirs.prepared, `${listId}.stats.json`), { optional: true });
  const fromStats = pick(stats ?? {}, "kept", "ruleCount", "counts.kept", "rules");
  if (Number.isSafeInteger(fromStats)) return fromStats;
  const dropped = await readJson(path.join(dirs.reports, "dropped", `${listId}.json`), {
    optional: true,
  });
  const fromReport = pick(dropped ?? {}, "counts.kept");
  return Number.isSafeInteger(fromReport) ? fromReport : undefined;
}

async function droppedSummary(reportsDir) {
  const dir = path.join(reportsDir, "dropped");
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort(byCodeUnit);
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  let total = 0;
  const byModifier = {};
  const byCause = {};
  for (const f of files) {
    const rec = await readJson(path.join(dir, f), { optional: true });
    if (!rec) continue;
    total += Number(rec.counts?.dropped ?? 0) || 0;
    for (const [k, v] of Object.entries(rec.byModifier ?? {})) byModifier[k] = (byModifier[k] ?? 0) + v;
    for (const [k, v] of Object.entries(rec.byCause ?? {})) byCause[k] = (byCause[k] ?? 0) + v;
  }
  const sorted = (o) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => byCodeUnit(a, b)));
  return { total, byModifier: sorted(byModifier), byCause: sorted(byCause) };
}

async function distBytes(distDir) {
  let bytes = 0;
  for (const f of await readdir(distDir)) {
    const s = await stat(path.join(distDir, f));
    if (s.isFile()) bytes += s.size;
  }
  return bytes;
}

export default { run, STAGE };

// Direct execution: `node src/stages/pack.mjs --prepare-payloads`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({ argv: process.argv.slice(2) })
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch((err) => {
      const code = err instanceof StageError ? err.exitCode : 1;
      log("error", "failed", { message: err.message, exitCode: code });
      if (code === 1) console.error(err.stack);
      process.exit(code);
    });
}
