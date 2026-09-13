// The run context every stage receives. It owns the build paths (PIPELINE 2.1),
// the parsed lists.json (section 5), lazy config loading, and the logger.

import path from "node:path";
import { createLogger } from "./log.mjs";
import { exists, readJson, readJsonIfExists } from "./io.mjs";
import { usageError } from "./errors.mjs";

export const NETWORK_FAMILIES = ["net.ads", "net.privacy", "net.security"];
export const COSMETIC_FAMILIES = ["cos.generic", "cos.specific"];
export const ALL_FAMILIES = [...NETWORK_FAMILIES, ...COSMETIC_FAMILIES];
export const ACTIVE_BUCKET_ID = "janus.active";

const ROLES = new Set(["rules", "removeparam", "popup-index", "sitefix"]);
const FORMATS = new Set(["adblock", "hosts"]);
const TRUST = new Set(["trusted", "untrusted"]);
const ID_PATTERN = /^[a-z0-9.-]+$/;

/** Every generated path, fixed by PIPELINE 2.1. */
export function buildPaths(buildDir) {
  const at = (...parts) => path.join(buildDir, ...parts);
  return {
    build: buildDir,
    at,
    cache: at("cache"),
    includeCache: at("cache", "include"),
    raw: at("raw"),
    prepared: at("prepared"),
    trusted: at("trusted"),
    xlated: at("xlated"),
    buckets: at("buckets"),
    bucketIndex: at("buckets", "index.json"),
    aux: at("auxdata"),
    converted: at("converted"),
    validate: at("validate"),
    reports: at("reports"),
    droppedReports: at("reports", "dropped"),
    droppedMarkdown: at("reports", "dropped.md"),
    budget: at("reports", "budget.json"),
    surrogateReport: at("reports", "surrogates.json"),
    dist: at("dist"),
    merged: at("merged.txt"),
    mergedProvenance: at("merged.provenance.jsonl"),
    surrogateCandidates: at("xlated", "surrogate-candidates.jsonl"),
    activeRedirects: at("auxdata", "active-redirects.json"),
    linkcleaner: at("auxdata", "linkcleaner.json"),
    popupIndex: at("auxdata", "popup-index.json"),
    sitefix: at("auxdata", "sitefix.json"),
    killswitches: at("auxdata", "killswitches.json"),
  };
}

function fail(message, details) {
  throw usageError(message, details);
}

/** Validates lists.json and returns the list array in file order. */
export function validateListsDocument(doc, source) {
  if (!doc || typeof doc !== "object") fail(`${source} is not an object`);
  if (doc.schemaVersion !== 1) {
    fail(`${source} has schemaVersion ${doc.schemaVersion}, expected 1`);
  }
  if (!Array.isArray(doc.lists) || doc.lists.length === 0) {
    fail(`${source} has no lists`);
  }
  const seen = new Set();
  for (const list of doc.lists) {
    const where = `${source} list ${list?.id ?? "<missing id>"}`;
    if (typeof list.id !== "string" || !ID_PATTERN.test(list.id)) {
      fail(`${where}: id must match [a-z0-9.-]+`);
    }
    if (seen.has(list.id)) fail(`${where}: duplicate id`);
    seen.add(list.id);
    if (typeof list.title !== "string" || list.title.length === 0) fail(`${where}: title required`);
    if (typeof list.url !== "string" || list.url.length === 0) fail(`${where}: url required`);
    if (!Array.isArray(list.mirrors)) fail(`${where}: mirrors must be an array`);
    if (!FORMATS.has(list.format)) fail(`${where}: format must be adblock or hosts`);
    if (!NETWORK_FAMILIES.includes(list.family)) {
      fail(`${where}: family must be one of ${NETWORK_FAMILIES.join(", ")}`);
    }
    if (!TRUST.has(list.trust)) fail(`${where}: trust must be trusted or untrusted`);
    if (typeof list.default !== "boolean") fail(`${where}: default must be a boolean`);
    if (typeof list.required !== "boolean") fail(`${where}: required must be a boolean`);
    for (const field of ["license", "licenseUrl", "attribution"]) {
      if (typeof list[field] !== "string" || list[field].length === 0) {
        fail(`${where}: ${field} is mandatory (it generates NOTICE)`);
      }
    }
    const role = list.role ?? "rules";
    if (!ROLES.has(role)) fail(`${where}: role must be one of ${[...ROLES].join(", ")}`);
    if (role === "sitefix" && !list.url.startsWith("file:")) {
      fail(`${where}: a sitefix list is read from config, so its url must start with file:`);
    }
    // https for anything on the network. A file: URL is local by construction:
    // the sitefix list always, and a fixture set in an offline dry run, which the
    // fetch stage refuses to read in a networked run.
    if (role !== "sitefix" && !list.url.startsWith("https://") && !list.url.startsWith("file:")) {
      fail(`${where}: url must be https, or file: for the sitefix list and offline fixtures`);
    }
    for (const mirror of list.mirrors) {
      if (typeof mirror !== "string" || !mirror.startsWith("https://")) {
        fail(`${where}: every mirror must be an https URL`);
      }
    }
  }
  return doc.lists.map((list) => ({ ...list, role: list.role ?? "rules" }));
}

/**
 * @param {object} options
 * @param {string} options.stage stage name, used in every log line
 * @param {string} [options.buildDir]
 * @param {string} [options.configDir]
 * @param {string} [options.listsPath]
 * @param {boolean} [options.quiet]
 * @param {boolean} [options.json]
 * @param {boolean} [options.offline]
 * @param {boolean} [options.force]
 * @param {boolean} [options.plan]
 * @param {string[]|null} [options.only]
 * @param {string|null} [options.baseline]
 */
export async function createContext(options) {
  const {
    stage = "cli",
    buildDir = "build",
    configDir = "config",
    listsPath = "lists.json",
    quiet = false,
    json = false,
    offline = false,
    force = false,
    plan = false,
    only = null,
    baseline = null,
    flavours = ["ios17", "ios26"],
    version = null,
    logger = null,
  } = options ?? {};

  const resolvedBuild = path.resolve(buildDir);
  const resolvedConfig = path.resolve(configDir);
  const resolvedLists = path.resolve(listsPath);
  if (!exists(resolvedLists)) fail(`lists file not found: ${listsPath}`);
  const lists = validateListsDocument(await readJson(resolvedLists), listsPath);

  if (only) {
    const known = new Set(lists.map((list) => list.id));
    for (const id of only) {
      if (!known.has(id)) fail(`--only names an unknown list id: ${id}`);
    }
  }

  const cache = new Map();
  const loadConfig = async (name, { optional = false } = {}) => {
    if (cache.has(name)) return cache.get(name);
    const file = path.join(resolvedConfig, `${name}.json`);
    const doc = optional ? await readJsonIfExists(file) : null;
    const value = optional ? doc : exists(file) ? await readJson(file) : fail(`config file missing: ${path.join(configDir, `${name}.json`)}`);
    cache.set(name, value);
    return value;
  };

  const paths = buildPaths(resolvedBuild);
  const onlySet = only ? new Set(only) : null;

  return {
    stage,
    log: logger ?? createLogger(stage, { quiet }),
    flags: { quiet, json, offline, force, plan, only: onlySet, baseline, flavours, version },
    dirs: { build: resolvedBuild, config: resolvedConfig, listsFile: resolvedLists },
    paths,
    lists,
    listById: (id) => lists.find((list) => list.id === id) ?? null,
    /** Lists this invocation should touch, honouring --only. */
    selectedLists: () => (onlySet ? lists.filter((list) => onlySet.has(list.id)) : lists),
    config: {
      env: () => loadConfig("env"),
      trust: () => loadConfig("trust"),
      buckets: () => loadConfig("buckets"),
      surrogates: () => loadConfig("surrogates"),
      alias: () => loadConfig("ubo-alias"),
      file: (name) => path.join(resolvedConfig, name),
    },
    file: {
      raw: (id) => path.join(paths.raw, `${id}.txt`),
      prepared: (id) => path.join(paths.prepared, `${id}.txt`),
      preparedStats: (id) => path.join(paths.prepared, `${id}.stats.json`),
      trusted: (id) => path.join(paths.trusted, `${id}.txt`),
      gate: (id) => path.join(paths.trusted, `${id}.gate.json`),
      xlated: (id) => path.join(paths.xlated, `${id}.txt`),
      xlate: (id) => path.join(paths.xlated, `${id}.xlate.json`),
      bucket: (bucketId) => path.join(paths.buckets, `${bucketId}.txt`),
      dropped: (id) => path.join(paths.droppedReports, `${id}.json`),
      cacheBody: (id) => path.join(paths.cache, `${id}.body`),
      cacheMeta: (id) => path.join(paths.cache, `${id}.meta.json`),
    },
  };
}
