// Stage: active (`janus.active`). PIPELINE section 11.
//
// The highest-risk part of the pipeline. WebKit visits lists in hash order and
// drops a redirect once a block has been recorded, so a surrogate that competes
// with a block rule in another list wins or loses unpredictably. DESIGN 3.3
// step 6 fixes the shape and this stage emits exactly it:
//   1. every surrogate redirect rule, in config order   (pack splices these in)
//   2. every matching fallback block rule, same order    (janus.active.txt)
//   3. non-foldable unbreak exceptions, appended last    (janus.active.txt)
// with no ignore-previous-rules between sections 1 and 2, and one
// ignore-previous-rules tail per surrogate pattern at the end of every other
// network bucket.

import path from "node:path";
import { integrityError, policyError } from "../lib/errors.mjs";
import {
  ensureDir,
  exists,
  readBytes,
  readJson,
  readJsonIfExists,
  readJsonl,
  readLines,
  sortStrings,
  writeJson,
  writeLines,
} from "../lib/io.mjs";
import { parseRule } from "../lib/rule.mjs";
import { normaliseHost } from "../lib/psl.mjs";
import { ACTIVE_BUCKET_ID } from "../lib/ctx.mjs";
import { sha256hex } from "../lib/hash.mjs";

/** WebKit resource-type -> the filter modifier that makes the converter emit it. */
const TYPE_TO_MODIFIER = {
  script: "script",
  raw: "xmlhttprequest",
  media: "media",
  font: "font",
  "style-sheet": "stylesheet",
  websocket: "websocket",
  ping: "ping",
  other: "other",
};

const FORBIDDEN_TYPES = new Set(["document", "top-document", "child-document", "image"]);

function modifiersFor(resourceTypes) {
  const modifiers = [];
  for (const type of resourceTypes) {
    if (FORBIDDEN_TYPES.has(type)) {
      throw policyError(
        `config/surrogates.json uses resource type ${type}, which PIPELINE 11.2 forbids`,
        { type },
      );
    }
    const modifier = TYPE_TO_MODIFIER[type];
    if (!modifier) {
      throw policyError(`config/surrogates.json uses unknown resource type ${type}`, { type });
    }
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return modifiers;
}

/** `/<regex>/$script` - the filter-text form of a pattern-scoped rule. */
export function regexRuleText(
  pattern,
  resourceTypes,
  { exception = false, unlessDomains = [], important = false } = {},
) {
  const modifiers = modifiersFor(resourceTypes);
  if (unlessDomains.length > 0) {
    modifiers.push(`domain=${unlessDomains.map((domain) => `~${domain}`).join("|")}`);
  }
  // SafariCbBuilder.createEntries emits otherExceptions BEFORE important and
  // importantExceptions, so a plain `@@` tail would still lose to an $important
  // block in the same bucket. `$important` on the exception puts it in
  // importantExceptions, which is emitted last (PIPELINE 11.3, DESIGN 3.3 step 6).
  if (important) modifiers.push("important");
  return `${exception ? "@@" : ""}/${pattern}/$${modifiers.join(",")}`;
}

/** An exception folds into a trigger only when it is scoped by positive domains. */
export function foldDecision(rule) {
  if (rule === null || rule.type !== "network") return { fold: false, reason: "not-network" };
  if (rule.negatedDomains.length > 0) return { fold: false, reason: "negated-domain" };
  const domains = [];
  for (const domain of rule.domains) {
    const host = normaliseHost(domain);
    if (host) domains.push(host);
  }
  if (domains.length === 0) return { fold: false, reason: "unscoped" };
  return { fold: true, domains };
}

/**
 * The redirect body, as a data: URL, read from the pinned @adguard/scriptlets
 * package and checked against the sha256 in config/surrogates.json - these bytes
 * execute in the page, so an unverified byte never reaches a bundle.
 *
 * An --offline run (the dry run and the tests) never reads the package: the
 * bodies are an external input like a filter list, and leaving the placeholder in
 * keeps the offline tree reproducible on a machine with no node_modules. A
 * networked run refuses to continue without them.
 */
async function loadRedirectBody(ctx, surrogate, source) {
  // Deliberately first: an offline tree must be identical on a machine with
  // node_modules and on one without.
  if (ctx.flags.offline) return null;
  const packageName = source?.package ?? "@adguard/scriptlets";
  const directory = source?.dir ?? "dist/redirect-files";
  const file = path.resolve(
    process.cwd(),
    "node_modules",
    ...packageName.split("/"),
    ...directory.split("/"),
    surrogate.file,
  );
  if (!exists(file)) {
    throw policyError(
      `${packageName} is not installed, so the ${surrogate.id} surrogate body cannot be embedded; run npm ci`,
      { surrogate: surrogate.id, file },
    );
  }
  const bytes = await readBytes(file);
  const digest = sha256hex(bytes);
  if (surrogate.sha256 && digest !== surrogate.sha256) {
    throw integrityError(
      `${surrogate.file} does not match the sha256 in config/surrogates.json`,
      { surrogate: surrogate.id, expected: surrogate.sha256, actual: digest },
    );
  }
  return `data:${surrogate.mime};base64,${bytes.toString("base64")}`;
}

export async function run(ctx) {
  const config = await ctx.config.surrogates();
  const surrogates = config.surrogates ?? [];
  if (surrogates.length === 0) throw policyError("config/surrogates.json lists no surrogates");

  const candidates = (await readJsonl(ctx.paths.surrogateCandidates)) ?? [];
  const byId = new Map(surrogates.map((surrogate) => [surrogate.id, surrogate]));
  const folded = new Map(surrogates.map((surrogate) => [surrogate.id, new Set()]));
  const appended = [];
  const stats = new Map(
    surrogates.map((surrogate) => [surrogate.id, { blocks: 0, exceptions: 0, notFolded: 0 }]),
  );

  for (const candidate of candidates) {
    const surrogate = byId.get(candidate.surrogate);
    if (!surrogate) continue;
    const entry = stats.get(candidate.surrogate);
    if (candidate.kind === "block") {
      entry.blocks += 1;
      continue;
    }
    entry.exceptions += 1;
    const rule = parseRule(candidate.rule);
    const decision = foldDecision(rule);
    if (decision.fold) {
      for (const domain of decision.domains) folded.get(candidate.surrogate).add(domain);
      continue;
    }
    entry.notFolded += 1;
    // PIPELINE 11.4 step 3: what a trigger cannot express is appended at the end
    // of janus.active, after the fallback blocks, as ignore-previous-rules.
    if (!appended.some((item) => item.rule === candidate.rule)) {
      appended.push({ rule: candidate.rule, surrogate: candidate.surrogate, reason: decision.reason });
    }
  }

  // janus.active.txt: the fallback blocks in config order, then the appended
  // exceptions. The redirects live in auxdata/active-redirects.json because the
  // converter does not support $redirect at all.
  const activeLines = [];
  const redirectRules = [];
  const report = { schemaVersion: 1, surrogates: [], ignoreTails: 0, appended: [] };

  let embedded = 0;
  for (const surrogate of surrogates) {
    const unlessDomains = sortStrings([...folded.get(surrogate.id)]);
    const dataUrl = await loadRedirectBody(ctx, surrogate, config.redirectSource);
    if (dataUrl !== null) embedded += 1;
    for (const pattern of surrogate.patterns) {
      redirectRules.push({
        surrogate: surrogate.id,
        trigger: {
          "url-filter": pattern,
          "resource-type": surrogate.resourceTypes,
          ...(unlessDomains.length > 0
            ? { "unless-domain": unlessDomains.map((domain) => `*${domain}`) }
            : {}),
        },
        // WebKit's RedirectAction::parse requires action.redirect to be an
        // object; a flat action.url is JSONRedirectMissing and the whole list
        // fails to compile.
        action:
          dataUrl === null
            ? {
                type: "redirect",
                redirect: {
                  dataUrlFrom: {
                    file: surrogate.file,
                    mime: surrogate.mime,
                    sha256: surrogate.sha256 ?? null,
                  },
                },
              }
            : { type: "redirect", redirect: { url: dataUrl } },
      });
    }
  }
  for (const surrogate of surrogates) {
    const unlessDomains = sortStrings([...folded.get(surrogate.id)]);
    for (const pattern of surrogate.patterns) {
      activeLines.push(regexRuleText(pattern, surrogate.resourceTypes, { unlessDomains }));
    }
  }
  for (const item of appended) activeLines.push(item.rule);

  await ensureDir(ctx.paths.buckets);
  await writeLines(ctx.file.bucket(ACTIVE_BUCKET_ID), activeLines);
  await writeJson(ctx.paths.activeRedirects, {
    schemaVersion: 1,
    note:
      "rules are content rules ready to splice in front of the converted janus.active bucket " +
      "(PIPELINE 11.2, 15.1). action.redirect.url carries the redirect body as a data: URL, " +
      "built from the pinned @adguard/scriptlets file after its sha256 was checked. An --offline " +
      "run leaves action.redirect.dataUrlFrom instead, naming the file the body must come from.",
    embedded: embedded === surrogates.length,
    redirectSource: config.redirectSource ?? null,
    rules: redirectRules,
  });

  // The ignore tail in every other network bucket (PIPELINE 11.3).
  const index = (await readJsonIfExists(ctx.paths.bucketIndex)) ?? { buckets: {} };
  const tailLines = [];
  for (const surrogate of surrogates) {
    for (const pattern of surrogate.patterns) {
      tailLines.push(
        regexRuleText(pattern, surrogate.resourceTypes, { exception: true, important: true }),
      );
    }
  }
  let tailed = 0;
  const tailCounts = {};
  for (const [bucketId, entry] of Object.entries(index.buckets ?? {})) {
    if (bucketId === ACTIVE_BUCKET_ID) continue;
    if (!entry.family?.startsWith("net.")) continue;
    const file = ctx.file.bucket(bucketId);
    if (!exists(file)) continue;
    const lines = (await readLines(file)) ?? [];
    const withoutTail = lines.filter((line) => !tailLines.includes(line));
    await writeLines(file, [...withoutTail, ...tailLines]);
    entry.ruleCount = withoutTail.length + tailLines.length;
    entry.surrogateTailCount = tailLines.length;
    tailCounts[bucketId] = tailLines.length;
    tailed += 1;
    report.ignoreTails += tailLines.length;
  }
  index.buckets[ACTIVE_BUCKET_ID] = {
    family: "active",
    optIn: false,
    optInSlug: null,
    ruleCount: activeLines.length,
    originalCount: activeLines.length,
    replicatedCount: 0,
    redirectRules: redirectRules.length,
    sourceLists: ["config/surrogates.json"],
  };
  await writeJson(ctx.paths.bucketIndex, index);

  // Budget: the tails are rules like any other, so they count (PIPELINE 11.3).
  const budget = await readJsonIfExists(ctx.paths.budget);
  if (budget?.buckets) {
    for (const row of budget.buckets) {
      const tail = tailCounts[row.id] ?? 0;
      if (tail === 0) continue;
      row.surrogateTailCount = tail;
      row.inputCount += tail;
      row.estimatedConverted = Math.round(row.inputCount * (row.ratio ?? 1));
      row.state =
        row.estimatedConverted > row.hardCap
          ? "over-hard"
          : row.estimatedConverted > row.softCap
            ? "over-soft"
            : "ok";
    }
    await writeJson(ctx.paths.budget, budget);
    const overHard = budget.buckets.filter((row) => row.state === "over-hard");
    if (overHard.length > 0) {
      throw policyError(
        `${overHard.length} bucket(s) exceed the hard cap once the surrogate tails are counted`,
        { buckets: overHard.map((row) => row.id) },
      );
    }
  }

  for (const surrogate of surrogates) {
    const entry = stats.get(surrogate.id);
    report.surrogates.push({
      id: surrogate.id,
      file: surrogate.file,
      mime: surrogate.mime,
      patterns: surrogate.patterns,
      resourceTypes: surrogate.resourceTypes,
      globals: surrogate.globals ?? [],
      unlessDomains: sortStrings([...folded.get(surrogate.id)]),
      candidateBlocks: entry.blocks,
      candidateExceptions: entry.exceptions,
      notFolded: entry.notFolded,
    });
  }
  report.appended = appended;
  await writeJson(ctx.paths.surrogateReport, report);

  // One source of truth: the app's surrogate JavaScript layer reads the same
  // folded domain set out of the site-fix payload (DESIGN 3.6a, CONTRACT 10.3).
  const sitefix = (await readJsonIfExists(ctx.paths.sitefix)) ?? {
    schemaVersion: 1,
    entries: [],
    csp: [],
    notes: [],
  };
  sitefix.surrogates = report.surrogates.map((surrogate) => ({
    id: surrogate.id,
    patterns: surrogate.patterns,
    resourceTypes: surrogate.resourceTypes,
    unlessDomains: surrogate.unlessDomains,
    globals: surrogate.globals,
  }));
  await writeJson(ctx.paths.sitefix, sitefix);

  // CONTRACT 10.4: every kill switch is true in a normal bundle. They exist so a
  // capability can be turned off remotely without an app update; nothing here can
  // ever turn one on, and the owner's own settings still win.
  await writeJson(ctx.paths.killswitches, {
    schemaVersion: 1,
    note: "Defaults for manifest.killSwitches (CONTRACT 10.4). A switch may only make Janus less active.",
    killSwitches: {
      listSuppliedJavaScript: true,
      scriptlets: true,
      surrogates: true,
      advancedRules: true,
      extendedCss: true,
    },
  });

  const summary = {
    stage: "active",
    surrogates: surrogates.length,
    embeddedBodies: embedded,
    redirectRules: redirectRules.length,
    fallbackBlocks: activeLines.length - appended.length,
    appendedExceptions: appended.length,
    bucketsTailed: tailed,
    ignoreTails: report.ignoreTails,
    foldedDomains: Object.fromEntries(
      report.surrogates.map((surrogate) => [surrogate.id, surrogate.unlessDomains.length]),
    ),
  };
  ctx.log.info("done", {
    redirectRules: redirectRules.length,
    bucketsTailed: tailed,
    appended: appended.length,
  });
  return summary;
}
