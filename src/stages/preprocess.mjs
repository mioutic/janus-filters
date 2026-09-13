// Stage: preprocess. PIPELINE section 7.
// Resolves everything that makes a list conditional or indirect, then normalises
// what remains, so that from here on the pipeline handles one flat rule stream.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { policyError } from "../lib/errors.mjs";
import { ensureDir, exists, readText, writeJson, writeJsonl, writeLines } from "../lib/io.mjs";
import { directiveOf, normaliseLine } from "../lib/rule.mjs";
import { normaliseHost } from "../lib/psl.mjs";
import { mergeRuleStreams } from "../lib/merge.mjs";
import { fetchIncludeBody } from "./fetch.mjs";

const MAX_INCLUDE_DEPTH = 5;
const MAX_INCLUDES_PER_LIST = 64;
const MAX_SAMPLES_PER_CAUSE = 20;
const HOSTS_SINKS = new Set(["0.0.0.0", "127.0.0.1", "::1"]);
const HOSTS_SKIP = new Set(["localhost", "localhost.localdomain", "broadcasthost", "local"]);

class ExpressionError extends Error {}

/** Tokens of an `!#if` expression: identifiers, !, &&, ||, parentheses. */
export function tokeniseIfExpression(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "!") {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    if (ch === "&" || ch === "|") {
      if (text[i + 1] !== ch) throw new ExpressionError(`single ${ch} in expression`);
      tokens.push({ type: ch === "&" ? "&&" : "||" });
      i += 2;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (!identifier) throw new ExpressionError(`unexpected character ${JSON.stringify(ch)}`);
    tokens.push({ type: "ident", name: identifier[0] });
    i += identifier[0].length;
  }
  if (tokens.length === 0) throw new ExpressionError("empty expression");
  return tokens;
}

/**
 * Evaluates an `!#if` expression with C precedence (! > && > ||).
 * Unknown identifiers are false and are reported through `onUnknown`.
 * @throws {ExpressionError} on a malformed expression
 */
export function evaluateIfExpression(text, identifiers, onUnknown = () => {}) {
  const tokens = tokeniseIfExpression(text);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  const parsePrimary = () => {
    const token = take();
    if (!token) throw new ExpressionError("expression ends early");
    if (token.type === "!") return !parsePrimary();
    if (token.type === "(") {
      const value = parseOr();
      const close = take();
      if (!close || close.type !== ")") throw new ExpressionError("missing )");
      return value;
    }
    if (token.type === "ident") {
      if (Object.hasOwn(identifiers, token.name)) return identifiers[token.name] === true;
      onUnknown(token.name);
      return false;
    }
    throw new ExpressionError(`unexpected token ${token.type}`);
  };
  const parseAnd = () => {
    let value = parsePrimary();
    while (peek()?.type === "&&") {
      take();
      const right = parsePrimary();
      value = value && right;
    }
    return value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (peek()?.type === "||") {
      take();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };

  const result = parseOr();
  if (position !== tokens.length) throw new ExpressionError("trailing tokens");
  return result;
}

/**
 * Converts one hosts-format line into `||host^` rules. PIPELINE 7.4.
 * @returns {{rules: string[], cause: string|null}}
 */
export function convertHostsLine(line) {
  const withoutComment = line.split("#")[0].trim();
  if (withoutComment.length === 0) return { rules: [], cause: null };
  const parts = withoutComment.split(/\s+/);
  if (parts.length < 2) return { rules: [], cause: "hosts.non_sink" };
  const [sink, ...hosts] = parts;
  if (!HOSTS_SINKS.has(sink)) return { rules: [], cause: "hosts.non_sink" };
  const rules = [];
  for (const candidate of hosts) {
    const lowered = candidate.toLowerCase();
    if (HOSTS_SKIP.has(lowered)) continue;
    if (!lowered.includes(".")) continue;
    const host = normaliseHost(lowered);
    if (host === null) return { rules, cause: "normalise.bad_idn" };
    rules.push(`||${host}^`);
  }
  return { rules, cause: null };
}

function newStats(list) {
  return {
    schemaVersion: 1,
    listId: list.id,
    format: list.format,
    role: list.role,
    counts: {
      in: 0,
      comments: 0,
      empty: 0,
      kept: 0,
      duplicateOfEarlierList: 0,
      removedByBadfilter: 0,
    },
    includes: [],
    affinityBlocks: 0,
    affinityGroups: [],
    ifBlocks: 0,
    drops: {},
    samples: [],
  };
}

function recordDrop(stats, cause, line, text) {
  stats.drops[cause] = (stats.drops[cause] ?? 0) + 1;
  const already = stats.samples.filter((sample) => sample.cause === cause).length;
  if (already < MAX_SAMPLES_PER_CAUSE) {
    stats.samples.push({ cause, line, rule: text });
  }
}

/** Resolves an include against the including file's URL, enforcing same origin. */
export function resolveInclude(spec, baseUrl, listUrl) {
  if (baseUrl.startsWith("file:")) {
    let resolved;
    try {
      resolved = new URL(spec, baseUrl);
    } catch {
      return { drop: "include.cross_origin" };
    }
    if (resolved.protocol !== "file:") return { drop: "include.cross_origin" };
    const root = new URL(".", listUrl).pathname;
    if (!resolved.pathname.startsWith(root)) return { drop: "include.cross_origin" };
    return { url: resolved.toString() };
  }
  let resolved;
  let base;
  try {
    resolved = new URL(spec, baseUrl);
    base = new URL(listUrl);
  } catch {
    return { drop: "include.cross_origin" };
  }
  if (resolved.protocol !== "https:") return { drop: "include.cross_origin" };
  if (resolved.host !== base.host) return { drop: "include.cross_origin" };
  const directory = new URL(".", base).pathname;
  if (!resolved.pathname.startsWith(directory)) return { drop: "include.cross_origin" };
  return { url: resolved.toString() };
}

/**
 * Walks one file's lines: expands includes depth-first, resolves !#if, consumes
 * !#safari_cb_affinity, and returns the surviving raw lines with attribution.
 */
async function walk(ctx, text, options) {
  const { baseUrl, listUrl, depth, stats, state, env, attributedLine } = options;
  const identifiers = env.identifiers ?? {};
  const maxIfDepth = env.maxIfDepth ?? 16;
  const out = [];
  const stack = [];
  const active = () => stack.every((frame) => frame.effective);
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const attribution = attributedLine ?? index + 1;
    const trimmed = raw.trim();
    const directive = trimmed.startsWith("!#") ? directiveOf(trimmed) : null;

    if (directive !== null) {
      const { name, argument } = directive;
      if (name === "if") {
        stats.ifBlocks += 1;
        const parentActive = active();
        if (stack.length >= maxIfDepth) {
          recordDrop(stats, "if.parse_error", attribution, trimmed);
          stack.push({ effective: false, condition: false, parentActive });
          continue;
        }
        let condition = false;
        if (parentActive) {
          try {
            condition = evaluateIfExpression(argument, identifiers, (unknown) => {
              recordDrop(stats, "if.unknown_identifier", attribution, unknown);
            });
          } catch {
            recordDrop(stats, "if.parse_error", attribution, trimmed);
            condition = false;
          }
        }
        stack.push({ effective: parentActive && condition, condition, parentActive });
        continue;
      }
      if (name === "else") {
        const frame = stack.pop();
        if (!frame) {
          recordDrop(stats, "if.parse_error", attribution, trimmed);
          continue;
        }
        stack.push({
          effective: frame.parentActive && !frame.condition,
          condition: !frame.condition,
          parentActive: frame.parentActive,
        });
        continue;
      }
      if (name === "endif") {
        if (stack.pop() === undefined) recordDrop(stats, "if.parse_error", attribution, trimmed);
        continue;
      }
      if (name === "safari_cb_affinity") {
        // Consumed, never forwarded: Janus assigns buckets itself (PIPELINE 7.2).
        if (argument.length > 0) {
          stats.affinityBlocks += 1;
          for (const group of argument.replace(/[()]/g, "").split(",")) {
            const value = group.trim();
            if (value.length > 0 && !stats.affinityGroups.includes(value)) {
              stats.affinityGroups.push(value);
            }
          }
        }
        continue;
      }
      if (name === "include") {
        if (!active()) continue;
        if (depth >= MAX_INCLUDE_DEPTH) {
          recordDrop(stats, "include.depth", attribution, argument);
          continue;
        }
        if (state.count >= MAX_INCLUDES_PER_LIST) {
          recordDrop(stats, "include.limit", attribution, argument);
          continue;
        }
        const resolved = resolveInclude(argument, baseUrl, listUrl);
        if (resolved.drop) {
          recordDrop(stats, resolved.drop, attribution, argument);
          continue;
        }
        if (state.stack.has(resolved.url)) {
          recordDrop(stats, "include.cycle", attribution, argument);
          continue;
        }
        state.count += 1;
        state.stack.add(resolved.url);
        let body;
        try {
          body = await fetchIncludeBody(ctx, resolved.url);
        } catch (error) {
          recordDrop(stats, "fetch.include_unavailable", attribution, argument);
          ctx.log.warn("include-unavailable", { url: resolved.url, message: error.message });
          state.stack.delete(resolved.url);
          continue;
        }
        const expanded = await walk(ctx, body, {
          ...options,
          baseUrl: resolved.url,
          depth: depth + 1,
          attributedLine: attribution,
        });
        state.stack.delete(resolved.url);
        stats.includes.push({ url: resolved.url, lines: expanded.length, depth: depth + 1 });
        for (const entry of expanded) out.push(entry); // never spread a whole list
        continue;
      }
      recordDrop(stats, "normalise.unknown_directive", attribution, trimmed);
      continue;
    }

    if (!active()) continue;
    out.push({ text: raw, line: attribution });
  }

  if (stack.length > 0) {
    throw policyError(
      `unterminated !#if in ${baseUrl}: a truncated download must not silently produce half a list`,
      { url: baseUrl, open: stack.length },
    );
  }
  return out;
}

/** The URL a list's includes resolve against. */
function baseUrlOf(ctx, list) {
  if (list.url.startsWith("file:")) {
    const spec = list.url.slice("file:".length);
    const absolute = path.resolve(path.dirname(ctx.dirs.listsFile), spec);
    return pathToFileURL(absolute).toString();
  }
  return list.url;
}

async function preprocessList(ctx, list, env) {
  const rawFile = ctx.file.raw(list.id);
  if (!exists(rawFile)) return null;
  const text = await readText(rawFile);
  const stats = newStats(list);
  const baseUrl = baseUrlOf(ctx, list);
  const state = { count: 0, stack: new Set([baseUrl]) };

  const candidates =
    list.format === "hosts"
      ? text.split("\n").map((line, index) => ({ text: line, line: index + 1 }))
      : await walk(ctx, text, {
          baseUrl,
          listUrl: baseUrl,
          depth: 0,
          stats,
          state,
          env,
          attributedLine: null,
        });

  const entries = [];
  const seenInList = new Set();
  for (const candidate of candidates) {
    stats.counts.in += 1;
    let texts;
    if (list.format === "hosts") {
      const converted = convertHostsLine(candidate.text);
      if (converted.cause) recordDrop(stats, converted.cause, candidate.line, candidate.text.trim());
      if (converted.rules.length === 0) {
        if (!converted.cause) stats.counts.empty += 1;
        continue;
      }
      texts = converted.rules;
    } else {
      texts = [candidate.text];
    }
    for (const value of texts) {
      const result = normaliseLine(value);
      if (result.status === "empty") {
        stats.counts.empty += 1;
        continue;
      }
      if (result.status === "comment") {
        stats.counts.comments += 1;
        continue;
      }
      if (result.status === "directive") {
        recordDrop(stats, "normalise.unknown_directive", candidate.line, result.text);
        continue;
      }
      if (result.status === "drop") {
        recordDrop(stats, result.cause, candidate.line, value.trim());
        continue;
      }
      if (seenInList.has(result.text)) continue; // exact duplicate inside one list
      seenInList.add(result.text);
      entries.push({ text: result.text, line: candidate.line, rule: result.rule });
    }
  }
  stats.counts.kept = entries.length;
  return { list, entries, stats };
}

export async function run(ctx) {
  const env = await ctx.config.env();
  await ensureDir(ctx.paths.prepared);

  const prepared = [];
  for (const list of ctx.selectedLists()) {
    const result = await preprocessList(ctx, list, env);
    if (result === null) {
      ctx.log.warn("no-raw-body", { listId: list.id });
      continue;
    }
    await writeLines(ctx.file.prepared(list.id), result.entries.map((entry) => entry.text));
    prepared.push(result);
    ctx.log.info("list", {
      listId: list.id,
      in: result.stats.counts.in,
      kept: result.stats.counts.kept,
      drops: Object.keys(result.stats.drops).length,
    });
  }

  // merged.txt is the deduped union in lists.json order, with $badfilter applied
  // across the whole set. Lists that carry no content rules stay out of it.
  const contributing = prepared.filter(
    (entry) => entry.list.role === "rules" || entry.list.role === "sitefix",
  );
  const merged = mergeRuleStreams(
    contributing.map((entry) => ({ listId: entry.list.id, entries: entry.entries })),
  );
  await writeLines(ctx.paths.merged, merged.lines);
  await writeJsonl(ctx.paths.mergedProvenance, merged.provenance);

  for (const entry of prepared) {
    const listStats = merged.perList[entry.list.id];
    if (listStats) {
      entry.stats.counts.kept = listStats.kept;
      entry.stats.counts.duplicateOfEarlierList = listStats.duplicateOfEarlierList;
      entry.stats.counts.removedByBadfilter = listStats.removedByBadfilter;
      entry.stats.counts.badfilterRules = listStats.badfilterRules;
    }
    for (const unmatched of merged.unmatchedBadfilters) {
      if (unmatched.listId !== entry.list.id) continue;
      recordDrop(entry.stats, "badfilter.no_match", unmatched.line, unmatched.rule);
    }
    await writeJson(ctx.file.preparedStats(entry.list.id), entry.stats);
  }

  const summary = {
    stage: "preprocess",
    lists: prepared.length,
    merged: {
      rules: merged.lines.length,
      removedByBadfilter: merged.removedByBadfilter.length,
      unmatchedBadfilters: merged.unmatchedBadfilters.length,
    },
    perList: Object.fromEntries(
      prepared.map((entry) => [
        entry.list.id,
        { in: entry.stats.counts.in, kept: entry.stats.counts.kept, drops: entry.stats.drops },
      ]),
    ),
  };
  ctx.log.info("done", { rules: merged.lines.length });
  return summary;
}
