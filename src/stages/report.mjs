// Stage: report (dropped rules). PIPELINE section 14.
//
// A rule can disappear at seven points and each one is a different problem, so
// they are never merged into a single "dropped" number. The converter hands back
// counters, not text, so this stage re-classifies every rule it believes the
// library cannot express and reconciles its own count against the counters: a
// silent drift between what we believe is unsupported and what the library
// actually drops is exactly the regression this report exists to catch.

import path from "node:path";
import {
  byCodeUnit,
  ensureDir,
  exists,
  listFiles,
  readJsonIfExists,
  readJsonl,
  readLines,
  sortStrings,
  writeJson,
  writeText,
} from "../lib/io.mjs";
import { parseRule } from "../lib/rule.mjs";
import { etldPlusOne } from "../lib/psl.mjs";

const MAX_SAMPLES_PER_CAUSE = 20;
const RECONCILIATION_TOLERANCE = 0.01;

/**
 * Modifiers SafariConverterLib 4.3.0 states it does not support (README,
 * "Supported vs. Unsupported Modifiers"), plus the aliases our parser may see.
 */
export const UNSUPPORTED_MODIFIERS = new Set([
  "app", "cookie", "csp", "extension", "header", "hls", "inline-font",
  "inline-script", "jsonprune", "network", "permissions", "redirect",
  "redirect-rule", "referrerpolicy", "removeheader", "removeparam", "replace",
  "stealth", "strict1p", "strict3p", "strict-first-party", "strict-third-party",
  "to", "uritransform", "urltransform", "xmlprune",
]);

/** Modifiers that only exist in the newer Safari flavour. */
export const FLAVOUR_ONLY_MODIFIERS = { method: "ios26" };

/** Regex constructs WebKit's url-filter parser rejects. */
const BAD_REGEX = /\(\?|\{\d|\\[0-9bBdDwWsS]|\[\^/;

const WATCHED_DOMAINS = ["reddit.com", "gofile.io"];

/**
 * Classifies a rule the converter cannot express.
 * @returns {{cause: string, modifier?: string, scriptlet?: string}|null}
 */
export function classifyUnsupported(text, flavour = "ios26") {
  if (text.includes("$$") || /##\^/.test(text)) {
    return { cause: "convert.html-filtering" };
  }
  const rule = parseRule(text);
  if (rule === null) return { cause: "convert.unparsable" };
  if (rule.type === "cosmetic") {
    if (rule.body.startsWith("+js(")) return { cause: "convert.ubo-scriptlet" };
    return null;
  }
  for (const modifier of rule.modifiers) {
    if (UNSUPPORTED_MODIFIERS.has(modifier.name)) {
      return { cause: "convert.unsupported-modifier", modifier: `$${modifier.name}` };
    }
    const only = FLAVOUR_ONLY_MODIFIERS[modifier.name];
    if (only && only !== flavour) {
      return { cause: "convert.flavour-modifier", modifier: `$${modifier.name}` };
    }
  }
  if (rule.domains.length > 0 && rule.negatedDomains.length > 0) {
    return { cause: "convert.mixed-domain", modifier: "$domain" };
  }
  if (rule.pattern.length > 2 && rule.pattern.startsWith("/") && rule.pattern.endsWith("/")) {
    if (BAD_REGEX.test(rule.pattern)) return { cause: "convert.unsupported-regex" };
  }
  return null;
}

function scriptletNameOf(text) {
  const ubo = /\+js\(\s*([^,)]+)/.exec(text);
  if (ubo) return ubo[1].trim();
  const adg = /\/\/scriptlet\(\s*['"]([^'"]+)['"]/.exec(text);
  return adg ? adg[1] : null;
}

function emptyReport(listId) {
  return {
    schemaVersion: 1,
    listId,
    counts: { in: 0, kept: 0, dropped: 0 },
    byModifier: {},
    byScriptlet: {},
    byCause: {},
    samples: [],
  };
}

function addCause(report, cause, count = 1) {
  report.byCause[cause] = (report.byCause[cause] ?? 0) + count;
  report.counts.dropped += count;
}

function addSample(report, cause, rule, line) {
  const already = report.samples.filter((sample) => sample.cause === cause).length;
  if (already >= MAX_SAMPLES_PER_CAUSE) return;
  report.samples.push({ rule, cause, line });
}

function sortObject(object) {
  const out = {};
  for (const key of sortStrings(Object.keys(object))) out[key] = object[key];
  return out;
}

/** Which list a rule came from, and at which raw line. */
async function loadProvenance(ctx) {
  const records = (await readJsonl(ctx.paths.mergedProvenance)) ?? [];
  const map = new Map();
  for (const record of records) {
    if (!map.has(record.rule)) map.set(record.rule, record);
  }
  return map;
}

export async function run(ctx) {
  await ensureDir(ctx.paths.droppedReports);
  const provenance = await loadProvenance(ctx);
  const reports = new Map();
  const reportFor = (listId) => {
    if (!reports.has(listId)) reports.set(listId, emptyReport(listId));
    return reports.get(listId);
  };

  // Preprocess, trust gate and translate all keep their own drop records.
  for (const list of ctx.lists) {
    const report = reportFor(list.id);
    const stats = await readJsonIfExists(ctx.file.preparedStats(list.id));
    if (stats) {
      report.counts.in = stats.counts.in ?? 0;
      report.counts.kept = stats.counts.kept ?? 0;
      for (const [cause, count] of Object.entries(stats.drops ?? {})) addCause(report, cause, count);
      for (const sample of stats.samples ?? []) addSample(report, sample.cause, sample.rule, sample.line);
    }
    const gate = await readJsonIfExists(ctx.file.gate(list.id));
    if (gate) {
      addCause(report, "trust-gate", gate.counts?.stripped ?? 0);
      for (const stripped of gate.stripped ?? []) {
        addSample(report, "trust-gate", stripped.rule, stripped.line);
        const name = scriptletNameOf(stripped.rule);
        if (name) report.byScriptlet[name] = (report.byScriptlet[name] ?? 0) + 1;
      }
    }
    const xlate = await readJsonIfExists(ctx.file.xlate(list.id));
    if (xlate) {
      for (const [cause, count] of Object.entries(xlate.dropCounts ?? {})) {
        addCause(report, cause, count);
      }
      for (const drop of xlate.drops ?? []) {
        addSample(report, drop.cause, drop.rule, drop.line);
        if (drop.cause === "scriptlet.no-alias") {
          const name = scriptletNameOf(drop.rule);
          if (name) report.byScriptlet[name] = (report.byScriptlet[name] ?? 0) + 1;
        }
      }
    }
  }

  // convert.*: our own classification of every bucket input rule, attributed to
  // the list the rule came from.
  const flavour = ctx.flags.flavours.at(-1) ?? "ios26";
  const seenRules = new Set();
  let predictedConvertDrops = 0;
  for (const name of await listFiles(ctx.paths.buckets, ".txt")) {
    const lines = (await readLines(path.join(ctx.paths.buckets, name))) ?? [];
    for (const text of lines) {
      if (seenRules.has(text)) continue;
      seenRules.add(text);
      const verdict = classifyUnsupported(text, flavour);
      if (verdict === null) continue;
      predictedConvertDrops += 1;
      const record = provenance.get(text);
      const report = reportFor(record?.listId ?? "janus.active");
      addCause(report, verdict.cause);
      addSample(report, verdict.cause, text, record?.line ?? 0);
      if (verdict.modifier) {
        report.byModifier[verdict.modifier] = (report.byModifier[verdict.modifier] ?? 0) + 1;
      }
      if (verdict.cause === "convert.ubo-scriptlet") {
        const scriptlet = scriptletNameOf(text);
        if (scriptlet) report.byScriptlet[scriptlet] = (report.byScriptlet[scriptlet] ?? 0) + 1;
      }
    }
  }

  // compile.bisect: what WebKit refused on the macOS runner.
  for (const name of ctx.flags.flavours) {
    const bisect = await readJsonl(path.join(ctx.paths.validate, name, "dropped-bisect.jsonl"));
    for (const entry of bisect ?? []) {
      const record = provenance.get(entry.rule);
      const report = reportFor(record?.listId ?? "janus.active");
      addCause(report, "compile.bisect");
      addSample(report, "compile.bisect", entry.rule, record?.line ?? 0);
    }
  }

  // Reconciliation against the converter's own counters.
  let libraryDiscarded = 0;
  let counterFiles = 0;
  for (const name of ctx.flags.flavours) {
    const dir = path.join(ctx.paths.converted, name);
    for (const file of await listFiles(dir, ".conv.json")) {
      const doc = await readJsonIfExists(path.join(dir, file));
      if (!doc) continue;
      counterFiles += 1;
      libraryDiscarded += (doc.discardedSafariRules ?? 0) + (doc.errorsCount ?? 0);
    }
    if (counterFiles > 0) break; // one flavour is enough for a drift check
  }
  const reconciliation =
    counterFiles === 0
      ? { available: false, ours: predictedConvertDrops }
      : {
          available: true,
          ours: predictedConvertDrops,
          library: libraryDiscarded,
          deltaFraction:
            libraryDiscarded === 0
              ? predictedConvertDrops > 0
                ? 1
                : 0
              : Math.abs(predictedConvertDrops - libraryDiscarded) / libraryDiscarded,
        };
  reconciliation.agrees =
    !reconciliation.available || reconciliation.deltaFraction <= RECONCILIATION_TOLERANCE;

  for (const report of reports.values()) {
    report.byModifier = sortObject(report.byModifier);
    report.byScriptlet = sortObject(report.byScriptlet);
    report.byCause = sortObject(report.byCause);
    report.samples.sort((a, b) => byCodeUnit(a.cause, b.cause) || a.line - b.line);
    await writeJson(ctx.file.dropped(report.listId), report);
  }

  const markdown = await buildMarkdown(ctx, reports, reconciliation);
  await writeText(ctx.paths.droppedMarkdown, markdown);

  const summary = {
    stage: "report",
    lists: reports.size,
    dropped: [...reports.values()].reduce((total, report) => total + report.counts.dropped, 0),
    reconciliation,
    watched: WATCHED_DOMAINS,
  };
  ctx.log.info("done", {
    lists: reports.size,
    dropped: summary.dropped,
    reconciles: reconciliation.agrees,
  });
  return summary;
}

/** The watched set: DESIGN 3.3 step 4's sites plus every domain in the Janus list. */
async function watchedDomains(ctx) {
  const watched = new Set(WATCHED_DOMAINS);
  const sitefix = ctx.lists.find((list) => list.role === "sitefix");
  if (sitefix) {
    const lines = (await readLines(ctx.file.prepared(sitefix.id))) ?? [];
    for (const line of lines) {
      const rule = parseRule(line);
      if (rule === null) continue;
      for (const domain of rule.domains) {
        const key = etldPlusOne(domain);
        if (key) watched.add(key);
      }
      if (rule.type === "network" && rule.host) {
        const key = etldPlusOne(rule.host);
        if (key) watched.add(key);
      }
    }
  }
  return sortStrings([...watched]);
}

async function buildMarkdown(ctx, reports, reconciliation) {
  const watched = await watchedDomains(ctx);
  const baseline = ctx.flags.baseline;
  const lines = [];
  lines.push("# Dropped rules");
  lines.push("");
  lines.push(
    "Losses are expected and permanent. What matters is that they are visible, and that " +
      "the ones that matter become site-fix entries (DESIGN 3.3 step 4).",
  );
  lines.push("");

  lines.push("## Watched sites");
  lines.push("");
  lines.push(`Watching: ${watched.join(", ")}`);
  lines.push("");
  let watchedRows = 0;
  for (const report of [...reports.values()].sort((a, b) => byCodeUnit(a.listId, b.listId))) {
    for (const sample of report.samples) {
      const lowered = sample.rule.toLowerCase();
      if (!watched.some((domain) => lowered.includes(domain))) continue;
      if (watchedRows === 0) {
        lines.push("| List | Rule | Cause | Raw line |");
        lines.push("|---|---|---|---|");
      }
      watchedRows += 1;
      if (watchedRows > 200) break;
      lines.push(
        `| ${report.listId} | \`${sample.rule.replace(/\|/g, "\\|")}\` | **${sample.cause}** | ${sample.line} |`,
      );
    }
  }
  if (watchedRows === 0) lines.push("No rule mentioning a watched site was dropped today.");
  lines.push("");

  lines.push("## Per list");
  lines.push("");
  lines.push("| List | In | Kept | Dropped | Delta vs baseline |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const report of [...reports.values()].sort((a, b) => byCodeUnit(a.listId, b.listId))) {
    let delta = "-";
    if (baseline) {
      const previous = await readJsonIfExists(path.join(baseline, "dropped", `${report.listId}.json`));
      if (previous) {
        const difference = report.counts.dropped - (previous.counts?.dropped ?? 0);
        const kept = Math.max(1, report.counts.kept);
        const flagged = Math.abs(difference) > 0.1 * kept;
        delta = flagged ? `**${difference > 0 ? "+" : ""}${difference}**` : `${difference > 0 ? "+" : ""}${difference}`;
      }
    }
    lines.push(
      `| ${report.listId} | ${report.counts.in} | ${report.counts.kept} | ${report.counts.dropped} | ${delta} |`,
    );
  }
  lines.push("");

  const histogram = {};
  const scriptlets = {};
  for (const report of reports.values()) {
    for (const [modifier, count] of Object.entries(report.byModifier)) {
      histogram[modifier] = (histogram[modifier] ?? 0) + count;
    }
    for (const [name, count] of Object.entries(report.byScriptlet)) {
      scriptlets[name] = (scriptlets[name] ?? 0) + count;
    }
  }
  lines.push("## Modifier histogram");
  lines.push("");
  lines.push("| Modifier | Rules |");
  lines.push("|---|---:|");
  for (const [modifier, count] of Object.entries(histogram).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${modifier} | ${count} |`);
  }
  if (Object.keys(histogram).length === 0) lines.push("| (none) | 0 |");
  lines.push("");

  lines.push("## Scriptlets without an AdGuard equivalent");
  lines.push("");
  const scriptletRows = Object.entries(scriptlets).sort((a, b) => b[1] - a[1]);
  if (scriptletRows.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Scriptlet | Rules |");
    lines.push("|---|---:|");
    for (const [name, count] of scriptletRows) lines.push(`| ${name} | ${count} |`);
  }
  lines.push("");

  lines.push("## Reconciliation with the converter's counters");
  lines.push("");
  if (!reconciliation.available) {
    lines.push(
      `No \`*.conv.json\` counters in this tree (the macOS convert stage has not run). ` +
        `Our own classification found ${reconciliation.ours} unconvertible rules.`,
    );
  } else {
    const percent = (reconciliation.deltaFraction * 100).toFixed(2);
    lines.push(
      `Our classification: ${reconciliation.ours}. Library discarded plus errors: ` +
        `${reconciliation.library}. Difference: ${percent} %.`,
    );
    if (!reconciliation.agrees) {
      lines.push("");
      lines.push(
        "**The two disagree by more than 1 %.** Either the library changed what it drops or " +
          "our table in `src/stages/report.mjs` is out of date; reconcile before trusting the " +
          "per-list numbers above.",
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
