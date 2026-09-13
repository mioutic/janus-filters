// Stage: fetch. PIPELINE section 6.
// In:  lists.json, build/cache/. Out: build/raw/<listId>.txt, refreshed cache.
// build/raw/ is evidence: bodies are LF-normalised and otherwise untouched,
// because the dropped report quotes them by line number.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, PipelineError, networkError, policyError } from "../lib/errors.mjs";
import {
  ensureDir,
  exists,
  normaliseNewlines,
  readText,
  readTextIfExists,
  writeJson,
  writeText,
  readJsonIfExists,
} from "../lib/io.mjs";
import { sha256hex } from "../lib/hash.mjs";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 120_000;
const ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 20_000;
const STALE_WARN_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_FAIL_MS = 14 * 24 * 60 * 60 * 1000;
const USER_AGENT = "janus-filters/1 (+https://github.com/mioutic/janus-filters)";

/** Cheap rule-line count: enough for the sanity checks, and fast on 7 MB lists. */
export function countRuleLines(text) {
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("!")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) continue;
    if (trimmed.startsWith("#") && (trimmed.length === 1 || trimmed[1] === " " || trimmed[1] === "\t")) {
      continue;
    }
    count += 1;
  }
  return count;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelay(attempt) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling); // full jitter
}

/** Resolves a file: URL against the directory holding lists.json. */
function resolveFileUrl(ctx, url) {
  const spec = url.slice("file:".length);
  if (spec.startsWith("//")) return fileURLToPath(url);
  return path.resolve(path.dirname(ctx.dirs.listsFile), spec);
}

/**
 * One HTTP GET with manual redirect handling: https only, at most 5 hops.
 * @returns {Promise<{status:number, bytes:Uint8Array|null, etag:string|null, lastModified:string|null, finalUrl:string}>}
 */
async function httpGet(url, { conditional, log } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers = {
      accept: "text/plain",
      "user-agent": USER_AGENT,
    };
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;

    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
      clearTimeout(connectTimer);
      if (response.status === 304) {
        return { status: 304, bytes: null, etag: null, lastModified: null, finalUrl: current };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw networkError(`redirect without location from ${current}`);
        const next = new URL(location, current);
        if (next.protocol !== "https:") {
          throw networkError(`refusing a non-https redirect hop to ${next.protocol}//`, {
            from: current,
          });
        }
        log?.debug("redirect", { from: current, to: next.toString(), status: response.status });
        current = next.toString();
        continue;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        bytes: buffer,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        finalUrl: current,
      };
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
    }
  }
  throw networkError(`more than ${MAX_REDIRECTS} redirects starting at ${url}`);
}

/** Sanity checks from section 6. Returns the decoded text or throws a retryable error. */
function checkBody(bytes, { url, cachedRuleCount }) {
  if (!bytes || bytes.length === 0) throw networkError(`empty body from ${url}`);
  if (bytes.length > MAX_BODY_BYTES) {
    throw networkError(`body from ${url} is larger than 64 MiB`, { bytes: bytes.length });
  }
  const text = decodeUtf8(bytes);
  if (text === null) throw networkError(`body from ${url} is not valid UTF-8`);
  const normalised = normaliseNewlines(text);
  const ruleCount = countRuleLines(normalised);
  if (ruleCount === 0) throw networkError(`body from ${url} contains no rules`);
  if (cachedRuleCount > 0 && ruleCount < Math.floor(cachedRuleCount / 2)) {
    throw networkError(
      `body from ${url} has ${ruleCount} rules, less than half of the cached ${cachedRuleCount}`,
      { ruleCount, cachedRuleCount },
    );
  }
  return { text: normalised, ruleCount };
}

async function attemptUrl(ctx, url, { conditional, cachedRuleCount }) {
  let lastError = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt);
      ctx.log.debug("retry", { url, attempt, delayMs: delay });
      await sleep(delay);
    }
    try {
      const response = await httpGet(url, { conditional, log: ctx.log });
      if (response.status === 304) return { notModified: true, url };
      if (response.status !== 200) {
        lastError = networkError(`HTTP ${response.status} from ${url}`, { status: response.status });
        continue;
      }
      const checked = checkBody(response.bytes, { url, cachedRuleCount });
      return {
        notModified: false,
        url,
        text: checked.text,
        ruleCount: checked.ruleCount,
        etag: response.etag,
        lastModified: response.lastModified,
      };
    } catch (error) {
      lastError = error;
      ctx.log.warn("attempt-failed", { url, attempt, message: error.message });
    }
  }
  throw lastError ?? networkError(`no attempt succeeded for ${url}`);
}

async function fetchList(ctx, list) {
  const rawFile = ctx.file.raw(list.id);
  const bodyFile = ctx.file.cacheBody(list.id);
  const metaFile = ctx.file.cacheMeta(list.id);
  const cachedBody = await readTextIfExists(bodyFile);
  const meta = (await readJsonIfExists(metaFile)) ?? null;
  const cachedRuleCount = cachedBody ? countRuleLines(cachedBody) : 0;

  // A file: URL is local: the sitefix list by design, a fixture set in a dry run.
  if (list.url.startsWith("file:")) {
    if (list.role !== "sitefix" && !ctx.flags.offline) {
      throw policyError(
        `list ${list.id} has a file: URL but the run is not offline; only the sitefix list may be local`,
        { listId: list.id },
      );
    }
    const source = resolveFileUrl(ctx, list.url);
    if (!exists(source)) {
      throw policyError(`list ${list.id} points at a missing local file`, { listId: list.id });
    }
    const text = await readText(source);
    await writeText(rawFile, text);
    return {
      id: list.id,
      status: "copied",
      bytes: Buffer.byteLength(text, "utf8"),
      ruleCount: countRuleLines(text),
      fromCache: false,
      url: list.url,
    };
  }

  const useCache = async (reason) => {
    if (cachedBody === null) return null;
    const fetchedAt = meta?.fetchedAt ? Date.parse(meta.fetchedAt) : NaN;
    if (Number.isFinite(fetchedAt)) {
      const age = Date.now() - fetchedAt;
      if (age > STALE_FAIL_MS) {
        throw policyError(
          `cached body for ${list.id} is older than 14 days, the same limit the app applies to a manifest`,
          { listId: list.id, ageDays: Math.floor(age / 86_400_000) },
        );
      }
      if (age > STALE_WARN_MS) {
        ctx.log.warn("cache-stale", {
          listId: list.id,
          ageDays: Math.floor(age / 86_400_000),
        });
      }
    }
    await writeText(rawFile, cachedBody);
    ctx.log.info("from-cache", { listId: list.id, reason });
    return {
      id: list.id,
      status: reason,
      bytes: Buffer.byteLength(cachedBody, "utf8"),
      ruleCount: cachedRuleCount,
      fromCache: true,
      url: meta?.url ?? list.url,
    };
  };

  if (ctx.flags.offline) {
    const cached = await useCache("fromCache");
    if (cached) return cached;
    return { id: list.id, status: "missing", reason: "offline-without-cache", fromCache: false };
  }

  const conditional =
    !ctx.flags.force && cachedBody !== null && meta?.url === list.url
      ? { etag: meta?.etag ?? null, lastModified: meta?.lastModified ?? null }
      : null;

  const candidates = [{ url: list.url, conditional }, ...list.mirrors.map((url) => ({ url, conditional: null }))];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const result = await attemptUrl(ctx, candidate.url, {
        conditional: candidate.conditional,
        // The shrink guard is about the list's content, not its origin: a mirror
        // that answers with half the rules is exactly what it exists to catch.
        cachedRuleCount,
      });
      if (result.notModified) {
        const cached = await useCache("notModified");
        if (cached) return { ...cached, status: "notModified" };
        // A 304 without a body is a broken cache: retry the same URL unconditionally.
        ctx.log.warn("304-without-cache", { listId: list.id });
        const refetched = await attemptUrl(ctx, candidate.url, {
          conditional: null,
          cachedRuleCount: 0,
        });
        await writeCache(ctx, list, refetched);
        await writeText(rawFile, refetched.text);
        return summaryOf(list, refetched, "fetched");
      }
      await writeCache(ctx, list, result);
      await writeText(rawFile, result.text);
      return summaryOf(list, result, "fetched");
    } catch (error) {
      if (error instanceof PipelineError && error.code === EXIT.POLICY) throw error;
      failures.push({ url: candidate.url, message: error.message });
      ctx.log.warn("url-exhausted", { listId: list.id, url: candidate.url, message: error.message });
    }
  }

  const cached = await useCache("fromCache");
  if (cached) return { ...cached, failures };
  return { id: list.id, status: "missing", reason: "all-urls-failed", failures, fromCache: false };
}

function summaryOf(list, result, status) {
  return {
    id: list.id,
    status,
    bytes: Buffer.byteLength(result.text, "utf8"),
    ruleCount: result.ruleCount,
    fromCache: false,
    url: result.url,
  };
}

async function writeCache(ctx, list, result) {
  await ensureDir(ctx.paths.cache);
  await writeText(ctx.file.cacheBody(list.id), result.text);
  await writeJson(ctx.file.cacheMeta(list.id), {
    url: result.url,
    etag: result.etag ?? null,
    lastModified: result.lastModified ?? null,
    sha256: sha256hex(result.text),
    fetchedAt: new Date().toISOString(),
    status: 200,
    ruleCount: result.ruleCount,
  });
}

/**
 * Fetches an `!#include` body for preprocess, cached by URL hash.
 * Same policy as a list body, minus mirrors: an include has exactly one origin.
 */
export async function fetchIncludeBody(ctx, url) {
  const key = sha256hex(url);
  const cacheFile = path.join(ctx.paths.includeCache, `${key}.body`);
  if (ctx.flags.offline) {
    if (url.startsWith("file:")) return readText(resolveFileUrl(ctx, url));
    const cached = await readTextIfExists(cacheFile);
    if (cached === null) {
      throw networkError(`include ${url} is not in the cache and the run is offline`);
    }
    return cached;
  }
  if (url.startsWith("file:")) return readText(resolveFileUrl(ctx, url));
  const result = await attemptUrl(ctx, url, { conditional: null, cachedRuleCount: 0 });
  if (result.notModified) {
    const cached = await readTextIfExists(cacheFile);
    if (cached !== null) return cached;
  }
  await writeText(cacheFile, result.text);
  return result.text;
}

export async function run(ctx) {
  await ensureDir(ctx.paths.raw);
  await ensureDir(ctx.paths.cache);
  const results = [];
  for (const list of ctx.selectedLists()) {
    const result = await fetchList(ctx, list);
    results.push(result);
    ctx.log.info("list", {
      listId: list.id,
      status: result.status,
      ruleCount: result.ruleCount,
      fromCache: result.fromCache,
    });
    if (result.status === "missing") {
      if (list.required) {
        throw new PipelineError(
          EXIT.NETWORK,
          `required list ${list.id} has no body and no usable cache`,
          { listId: list.id, reason: result.reason },
        );
      }
      ctx.log.warn("list-skipped", { listId: list.id, reason: result.reason });
    }
  }
  const skipped = results.filter((result) => result.status === "missing").map((r) => r.id);
  const summary = {
    stage: "fetch",
    lists: results.length,
    fetched: results.filter((r) => r.status === "fetched").length,
    notModified: results.filter((r) => r.status === "notModified").length,
    fromCache: results.filter((r) => r.status === "fromCache").length,
    copied: results.filter((r) => r.status === "copied").length,
    skipped,
    results,
  };
  await writeJson(path.join(ctx.paths.build, "fetch.summary.json"), summary);
  return summary;
}
