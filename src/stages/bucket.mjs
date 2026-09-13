// Stage: bucket. PIPELINE section 10.
//
// The hash, the ordering and the replication rules in this file are normative:
// changing any of them reshuffles buckets, changes their sha256 and forces the
// phone to re-download the whole set. They are not to be "improved".

import path from "node:path";
import { policyError } from "../lib/errors.mjs";
import {
  byCodeUnit,
  ensureDir,
  exists,
  readJsonIfExists,
  readLines,
  sortStrings,
  writeJson,
  writeJsonl,
  writeLines,
} from "../lib/io.mjs";
import { fnv1a32, pad2 } from "../lib/hash.mjs";
import { bucketKey, isDocumentAllowlist, parseRule, scopeKeys } from "../lib/rule.mjs";
import { mergeRuleStreams } from "../lib/merge.mjs";
import { ACTIVE_BUCKET_ID } from "../lib/ctx.mjs";

const DEFAULT_OPT_IN_SIZING = { B: 1, G: 1 };

/** `janus.<family>[.<optInSlug>].<NN>` or `...gen<NN>`. PIPELINE 10.1. */
export function bucketIdFor(group, kind, index) {
  const base = group.slug ? `janus.${group.family}.${group.slug}` : `janus.${group.family}`;
  return kind === "gen" ? `${base}.gen${pad2(index)}` : `${base}.${pad2(index)}`;
}

export function allBucketIds(group) {
  const ids = [];
  for (let i = 0; i < group.B; i += 1) ids.push(bucketIdFor(group, "keyed", i));
  for (let i = 0; i < group.G; i += 1) ids.push(bucketIdFor(group, "gen", i));
  return ids;
}

export function genBucketIds(group) {
  const ids = [];
  for (let i = 0; i < group.G; i += 1) ids.push(bucketIdFor(group, "gen", i));
  return ids;
}

/** The five-section order of PIPELINE 10.4. Section 5 is the surrogate tail. */
export function sectionOf(rule) {
  if (rule.type === "cosmetic") return rule.exception ? 2 : 1;
  if (rule.exception) {
    if (rule.important || isDocumentAllowlist(rule)) return 4;
    return 2;
  }
  return rule.important ? 3 : 1;
}

/** The family a rule belongs to (PIPELINE 10.2). */
export function familyOf(rule, list) {
  if (rule.type === "cosmetic") return rule.domains.length > 0 ? "cos.specific" : "cos.generic";
  return list.family;
}

function groupKeyOf(family, slug) {
  return `${family}|${slug ?? ""}`;
}

/** Builds the bucket groups: one per family, plus one per opt-in list. */
export function buildGroups(ctx, bucketConfig) {
  const groups = new Map();
  const families = bucketConfig.families ?? {};
  for (const [family, sizing] of Object.entries(families)) {
    groups.set(groupKeyOf(family, null), {
      family,
      slug: null,
      optIn: false,
      B: sizing.B,
      G: sizing.G,
      softCap: sizing.softCap,
      hardCap: sizing.hardCap,
      listIds: new Set(),
    });
  }
  const optIn = bucketConfig.optIn ?? {};
  for (const list of ctx.lists) {
    if (list.default) continue;
    if (list.role !== "rules") continue;
    const sizing = optIn[list.id] ?? DEFAULT_OPT_IN_SIZING;
    if (!optIn[list.id]) {
      ctx.log.warn("optin-unsized", { listId: list.id, using: DEFAULT_OPT_IN_SIZING });
    }
    const slug = list.id.replace(/\./g, "-");
    // An opt-in list gets its own buckets in every family it can reach, so its
    // rules are never installed for an owner who did not enable it.
    for (const family of [sizing.family ?? list.family, "cos.generic", "cos.specific"]) {
      const familySizing = families[family] ?? {};
      const key = groupKeyOf(family, slug);
      if (groups.has(key)) continue;
      groups.set(key, {
        family,
        slug,
        optIn: true,
        listId: list.id,
        B: family.startsWith("cos.") ? (familySizing.B ?? 0) : (sizing.B ?? DEFAULT_OPT_IN_SIZING.B),
        G: family.startsWith("cos.") ? (familySizing.G ?? 0) : (sizing.G ?? DEFAULT_OPT_IN_SIZING.G),
        softCap: familySizing.softCap ?? bucketConfig.families?.[family]?.softCap ?? 80000,
        hardCap: familySizing.hardCap ?? bucketConfig.families?.[family]?.hardCap ?? 110000,
        listIds: new Set([list.id]),
      });
    }
  }
  return groups;
}

function groupFor(groups, family, list) {
  const slug = list.default ? null : list.id.replace(/\./g, "-");
  const group = groups.get(groupKeyOf(family, slug)) ?? groups.get(groupKeyOf(family, null));
  if (!group) {
    throw policyError(`no bucket group for family ${family}`, { family, listId: list.id });
  }
  return group;
}

/** key -> keyed bucket, host-less -> gen bucket. PIPELINE 10.3, normative. */
export function bucketForKey(group, key, ruleText) {
  if (key !== "" && group.B > 0) {
    return bucketIdFor(group, "keyed", fnv1a32(key) % group.B);
  }
  if (group.G > 0) {
    return bucketIdFor(group, "gen", fnv1a32(ruleText) % group.G);
  }
  if (group.B > 0) {
    return bucketIdFor(group, "keyed", fnv1a32(ruleText) % group.B);
  }
  throw policyError(`bucket group ${group.family} has neither keyed nor generic buckets`, {
    family: group.family,
  });
}

/**
 * Network modifiers that make an exception act on **cosmetic** filtering. The
 * rules such an exception must neutralise live in `cos.*`, and WebKit's
 * ignore-previous-rules only acts inside its own list, so replicating them into
 * the network family they were parsed in would leave them inert (PIPELINE 10.5).
 */
const COSMETIC_SCOPE_MODIFIERS = new Set([
  "content",
  "ehide",
  "elemhide",
  "generichide",
  "ghide",
  "specifichide",
  "shide",
]);

/** True for `@@...$elemhide` and friends: a network rule with cosmetic scope. */
export function isCosmeticScopeException(rule) {
  if (rule.type !== "network" || rule.exception !== true) return false;
  return rule.modifiers.some((m) => !m.negated && COSMETIC_SCOPE_MODIFIERS.has(m.name));
}

/** Which groups an exception replicates into (PIPELINE 10.5). */
function replicationGroups(groups, group, rule) {
  const out = [];
  const cosmetic = rule.type === "cosmetic" || isCosmeticScopeException(rule);
  for (const candidate of groups.values()) {
    const sameScope = cosmetic
      ? candidate.family.startsWith("cos.")
      : candidate.family === group.family;
    if (!sameScope) continue;
    // An exception from an opt-in list stays inside that list's own buckets.
    if (group.optIn && candidate.slug !== group.slug) continue;
    out.push(candidate);
  }
  return out;
}

/**
 * The buckets one exception is copied into. Replication happens after routing and
 * before ordering, and every copy is byte-identical to the original rule text.
 */
export function replicationTargets(groups, group, rule, text) {
  const scope = scopeKeys(rule);
  const generic = scope.length === 0;
  const documentAllowlist = isDocumentAllowlist(rule);
  const targets = new Set();
  for (const candidate of replicationGroups(groups, group, rule)) {
    if (generic || documentAllowlist) {
      for (const id of allBucketIds(candidate)) targets.add(id);
      continue;
    }
    for (const key of scope) {
      if (candidate.B > 0) targets.add(bucketIdFor(candidate, "keyed", fnv1a32(key) % candidate.B));
    }
    for (const id of genBucketIds(candidate)) targets.add(id);
    if (candidate.B === 0 && candidate.G === 0) continue;
    if (candidate.B === 0 && candidate.G > 0) {
      // A family with no keyed buckets: the scoped copy lands in its gen buckets,
      // which the loop above already added.
      continue;
    }
  }
  if (targets.size === 0) targets.add(bucketForKey(group, scope[0] ?? "", text));
  return [...targets].sort(byCodeUnit);
}

/** Reads the previous run's counts to turn input rules into a converted estimate. */
async function loadConversionRatios(ctx) {
  const previousIndex = await readJsonIfExists(ctx.paths.bucketIndex);
  if (!previousIndex?.buckets) return { basis: "default-1.0", ratios: {} };
  const input = new Map();
  for (const [id, entry] of Object.entries(previousIndex.buckets)) {
    input.set(id, { family: entry.family, ruleCount: entry.ruleCount });
  }
  const converted = new Map();
  let found = false;
  for (const flavour of ctx.flags.flavours) {
    const report = await readJsonIfExists(path.join(ctx.paths.validate, flavour, "report.json"));
    if (!report?.buckets) continue;
    found = true;
    for (const entry of Array.isArray(report.buckets) ? report.buckets : Object.values(report.buckets)) {
      const id = entry.id ?? entry.bucketId;
      if (!id) continue;
      const count = entry.ruleCount ?? 0;
      converted.set(id, Math.max(converted.get(id) ?? 0, count));
    }
  }
  if (!found) return { basis: "default-1.0", ratios: {} };
  const perFamily = new Map();
  for (const [id, entry] of input) {
    if (!converted.has(id)) continue;
    const totals = perFamily.get(entry.family) ?? { input: 0, converted: 0 };
    totals.input += entry.ruleCount;
    totals.converted += converted.get(id);
    perFamily.set(entry.family, totals);
  }
  const ratios = {};
  for (const [family, totals] of perFamily) {
    if (totals.input > 0) ratios[family] = totals.converted / totals.input;
  }
  return { basis: "previous-converted-ratio", ratios };
}

export async function run(ctx) {
  const bucketConfig = await ctx.config.buckets();
  const groups = buildGroups(ctx, bucketConfig);
  const ratioInfo = await loadConversionRatios(ctx);

  // Rebuild the merged set from the translated lists (PIPELINE 10 "In").
  const streams = [];
  for (const list of ctx.lists) {
    if (list.role !== "rules" && list.role !== "sitefix") continue;
    const file = ctx.file.xlated(list.id);
    if (!exists(file)) continue;
    const lines = (await readLines(file)) ?? [];
    const entries = [];
    for (let index = 0; index < lines.length; index += 1) {
      const rule = parseRule(lines[index]);
      if (rule === null) continue;
      entries.push({ text: lines[index], line: index + 1, rule });
    }
    streams.push({ listId: list.id, entries, list });
  }
  const merged = mergeRuleStreams(streams.map(({ listId, entries }) => ({ listId, entries })));
  const listById = new Map(streams.map((stream) => [stream.listId, stream.list]));

  const buckets = new Map(); // bucketId -> {group, rows:[{order, section, text}], originals, replicated, lists:Set}
  const bucketOf = (id, group) => {
    if (!buckets.has(id)) {
      buckets.set(id, { id, group, rows: [], originals: 0, replicated: 0, lists: new Set() });
    }
    return buckets.get(id);
  };
  // Every declared bucket exists even when no rule hashes into it: a missing
  // bucket would change the manifest layout from one day to the next.
  for (const group of groups.values()) {
    for (const id of allBucketIds(group)) bucketOf(id, group);
  }

  let order = 0;
  for (const record of merged.provenance) {
    const list = listById.get(record.listId);
    const rule = parseRule(record.rule);
    if (rule === null || !list) continue;
    const family = familyOf(rule, list);
    const group = groupFor(groups, family, list);
    const section = sectionOf(rule);
    const isException = rule.exception === true;
    const targets = isException
      ? replicationTargets(groups, group, rule, record.rule)
      : [bucketForKey(group, bucketKey(rule), record.rule)];
    let primary = isException ? bucketForKey(group, bucketKey(rule), record.rule) : targets[0];
    // A cosmetic-scope exception leaves its network family entirely, so its
    // "primary" bucket is the first target it actually reached.
    if (!targets.includes(primary)) primary = targets[0];
    for (const id of targets) {
      const bucket = bucketOf(id, groups.get(groupKeyOf(group.family, group.slug)) ?? group);
      bucket.rows.push({ order, section, text: record.rule });
      bucket.lists.add(record.listId);
      if (id === primary) bucket.originals += 1;
      else bucket.replicated += 1;
    }
    order += 1;
  }

  // Ordering: section first, merged order inside a section. Stable order plus
  // stable keys is what keeps an unchanged bucket's sha256 unchanged.
  const index = { schemaVersion: 1, buckets: {} };
  const budgetRows = [];
  const ids = sortStrings([...buckets.keys()]);
  for (const id of ids) {
    const bucket = buckets.get(id);
    bucket.rows.sort((a, b) => a.section - b.section || a.order - b.order);
    const lines = bucket.rows.map((row) => row.text);
    const ratio = ratioInfo.ratios[bucket.group.family] ?? 1.0;
    const estimated = Math.round(lines.length * ratio);
    const softCap = bucket.group.softCap ?? 80000;
    const hardCap = bucket.group.hardCap ?? 110000;
    index.buckets[id] = {
      family: bucket.group.family,
      optIn: bucket.group.optIn,
      // The opt-in list this group belongs to, or null. CI routes the advanced
      // rules of an opt-in bucket to its own payload with it (CONTRACT 9.1).
      optInSlug: bucket.group.slug ?? null,
      ruleCount: lines.length,
      originalCount: bucket.originals,
      replicatedCount: bucket.replicated,
      sourceLists: sortStrings([...bucket.lists]),
    };
    budgetRows.push({
      id,
      family: bucket.group.family,
      optIn: bucket.group.optIn,
      inputCount: lines.length,
      estimatedConverted: estimated,
      ratio,
      softCap,
      hardCap,
      state: estimated > hardCap ? "over-hard" : estimated > softCap ? "over-soft" : "ok",
      suggestedB:
        estimated > softCap && bucket.group.B > 0
          ? Math.ceil((bucket.group.B * estimated) / softCap)
          : null,
    });
    if (!ctx.flags.plan) {
      await ensureDir(ctx.paths.buckets);
      await writeLines(ctx.file.bucket(id), lines);
    }
  }

  if (!ctx.flags.plan) {
    await writeLines(ctx.paths.merged, merged.lines);
    await writeJsonl(ctx.paths.mergedProvenance, merged.provenance);
    await writeJson(ctx.paths.bucketIndex, index);
  }

  const fetchSummary = await readJsonIfExists(path.join(ctx.paths.build, "fetch.summary.json"));
  const budget = {
    schemaVersion: 1,
    basis: ratioInfo.basis,
    plan: ctx.flags.plan === true,
    activeBucket: ACTIVE_BUCKET_ID,
    webkitLimit: bucketConfig.webkitLimit ?? 150000,
    ratios: ratioInfo.ratios,
    skippedLists: fetchSummary?.skipped ?? [],
    buckets: budgetRows,
  };
  await writeJson(ctx.paths.budget, budget);

  const overSoft = budgetRows.filter((row) => row.state === "over-soft");
  const overHard = budgetRows.filter((row) => row.state === "over-hard");
  for (const row of [...overSoft, ...overHard]) {
    ctx.log.warn("budget", {
      bucket: row.id,
      family: row.family,
      estimatedConverted: row.estimatedConverted,
      softCap: row.softCap,
      hardCap: row.hardCap,
      suggestedB: row.suggestedB,
    });
  }
  if (ctx.flags.plan && !ctx.flags.quiet) {
    const table = budgetRows
      .map(
        (row) =>
          `${row.id.padEnd(34)} ${String(row.inputCount).padStart(8)} in  ` +
          `${String(row.estimatedConverted).padStart(8)} est  ${row.state}`,
      )
      .join("\n");
    process.stderr.write(`${table}\n`);
  }
  if (overHard.length > 0) {
    throw policyError(
      `${overHard.length} bucket(s) are estimated above the hard cap; raise B for the family in a commit that bumps layoutVersion`,
      { buckets: overHard.map((row) => row.id) },
    );
  }

  const summary = {
    stage: "bucket",
    plan: ctx.flags.plan === true,
    buckets: ids.length,
    rules: merged.lines.length,
    replicated: budgetRows.reduce((total, row) => total + (index.buckets[row.id]?.replicatedCount ?? 0), 0),
    overSoft: overSoft.map((row) => row.id),
    basis: ratioInfo.basis,
  };
  ctx.log.info("done", { buckets: ids.length, rules: merged.lines.length });
  return summary;
}
