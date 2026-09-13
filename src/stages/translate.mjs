// Stage: translate. PIPELINE section 9.
// DESIGN 3.3 step 2: translate losses before converting. Every transform here
// exists because the converter would otherwise discard the rule.

import { ensureDir, byCodeUnit, exists, readLines, writeJson, writeJsonl, writeLines, sortStrings } from "../lib/io.mjs";
import {
  formatAdguardScriptletBody,
  parseAdguardScriptletBody,
  parseUboScriptletBody,
  applyTransform,
} from "../lib/alias-transforms.mjs";
import { getModifier, hasModifier, parseRule, serialiseRule } from "../lib/rule.mjs";
import { etldPlusOne } from "../lib/psl.mjs";
import { matchesUrl, regexToProbeUrls } from "../lib/match.mjs";

const MAX_SAMPLES_PER_CAUSE = 20;

function stripJs(name) {
  return name.endsWith(".js") ? name.slice(0, -3) : name;
}

/** Alias lookup that accepts a name with or without the .js suffix. */
export function lookupAlias(map, name) {
  return map[name] ?? map[`${name}.js`] ?? map[stripJs(name)] ?? null;
}

const ADGUARD_NAME_SETS = new WeakMap();

/** The canonical AdGuard scriptlet names from the pinned package, as a Set. */
function adguardNames(alias) {
  let set = ADGUARD_NAME_SETS.get(alias);
  if (!set) {
    set = new Set(alias.adguardNames ?? []);
    ADGUARD_NAME_SETS.set(alias, set);
  }
  return set;
}

function isUnmapped(alias, name) {
  const bare = stripJs(name);
  return (alias.unmapped ?? []).some((entry) => stripJs(entry) === bare);
}

/** Probe URLs and cheap text hints for every surrogate, built once per run. */
export function surrogateProbes(surrogateConfig) {
  const probes = [];
  const hints = new Set();
  for (const surrogate of surrogateConfig.surrogates ?? []) {
    for (const pattern of surrogate.patterns ?? []) {
      for (const url of regexToProbeUrls(pattern)) {
        probes.push({ id: surrogate.id, url });
        try {
          const host = new URL(url).hostname.replace(/^x\./, "").replace(/^\./, "");
          const key = etldPlusOne(host);
          if (key) hints.add(key);
        } catch {
          // A probe that is not a URL is simply not a hint.
        }
      }
    }
  }
  return { probes, hints: [...hints].sort(byCodeUnit) };
}

function newRecord(list) {
  return {
    schemaVersion: 1,
    listId: list.id,
    counts: { in: 0, kept: 0, rewritten: 0, dropped: 0 },
    transforms: [],
    drops: [],
    dropCounts: {},
  };
}

function recordDrop(record, line, rule, cause) {
  record.counts.dropped += 1;
  record.dropCounts[cause] = (record.dropCounts[cause] ?? 0) + 1;
  const already = record.drops.filter((drop) => drop.cause === cause).length;
  if (already < MAX_SAMPLES_PER_CAUSE) record.drops.push({ line, rule, cause });
}

function recordTransform(record, line, from, to, kind) {
  record.counts.rewritten += 1;
  if (record.transforms.length < 2000) record.transforms.push({ line, from, to, kind });
}

/** Rewrites a scriptlet invocation to AdGuard syntax. PIPELINE 9.1. */
export function translateScriptlet(rule, list, alias, record, line) {
  const uboCall = parseUboScriptletBody(rule.body);
  const adguardCall = uboCall === null ? parseAdguardScriptletBody(rule.body) : null;
  const call = uboCall ?? adguardCall;
  if (call === null || call.name.length === 0) return { keep: true };

  const entry = lookupAlias(alias.scriptlets ?? {}, call.name);
  if (entry === null) {
    const bare = stripJs(call.name);
    // A uBO-syntax rule that already names an AdGuard scriptlet needs the syntax
    // rewrite and nothing else; without it the converter discards a rule we can
    // express. uAssets writes thousands of these.
    if (uboCall !== null && adguardNames(alias).has(bare)) {
      if (bare.startsWith("trusted-") && list.trust !== "trusted") {
        recordDrop(record, line, rule.text, "alias.trusted-target");
        return { keep: false };
      }
      const rewritten =
        rule.prefix +
        (rule.exception ? "#@%#" : "#%#") +
        formatAdguardScriptletBody(bare, applyTransform("identity", call.args));
      recordTransform(record, line, rule.text, rewritten, "scriptlet-syntax");
      return { keep: true, text: rewritten };
    }
    if (isUnmapped(alias, call.name)) {
      recordDrop(record, line, rule.text, "scriptlet.no-alias");
      return { keep: false };
    }
    if (uboCall !== null) {
      record.dropCounts["alias.miss"] = (record.dropCounts["alias.miss"] ?? 0) + 1;
    }
    return { keep: true };
  }
  if (entry.trusted === true && list.trust !== "trusted") {
    // Otherwise the alias map would be a way around the trust gate.
    recordDrop(record, line, rule.text, "alias.trusted-target");
    return { keep: false };
  }
  const args = applyTransform(entry.args ?? "identity", call.args);
  const body = formatAdguardScriptletBody(entry.adguard, args);
  const separator = rule.exception ? "#@%#" : "#%#";
  const text = rule.prefix + separator + body;
  if (text === rule.text) return { keep: true };
  recordTransform(record, line, rule.text, text, "scriptlet-alias");
  return { keep: true, text };
}

/** Maps a uBO redirect resource name onto its AdGuard name. */
function translateRedirect(rule, alias, record, line) {
  const modifier =
    getModifier(rule, "redirect") ??
    getModifier(rule, "redirect-rule") ??
    getModifier(rule, "rewrite");
  if (!modifier || !modifier.value) return { keep: true };
  const entry = lookupAlias(alias.redirects ?? {}, modifier.value);
  if (entry === null) {
    if (isUnmapped(alias, modifier.value)) {
      record.dropCounts["alias.redirect-unmapped"] =
        (record.dropCounts["alias.redirect-unmapped"] ?? 0) + 1;
    }
    return { keep: true };
  }
  if (entry.adguard === modifier.value) return { keep: true };
  const modifiers = rule.modifiers.map((candidate) =>
    candidate === modifier ? { ...candidate, value: entry.adguard } : candidate,
  );
  const text = serialiseRule({ ...rule, modifiers });
  recordTransform(record, line, rule.text, text, "redirect-alias");
  return { keep: true, text };
}

function addPopupDomains(rule, popupDomains) {
  if (rule.host) {
    const key = etldPlusOne(rule.host);
    if (key) popupDomains.add(key);
  }
  for (const domain of rule.domains) {
    const key = etldPlusOne(domain);
    if (key) popupDomains.add(key);
  }
}

/** $removeparam -> LinkCleaner. PIPELINE 9.3. */
function translateRemoveParam(rule, linkcleaner, record, line) {
  const modifier = getModifier(rule, "removeparam");
  if (!modifier) return { keep: true };
  // Scope: $domain when the rule has one, else the rule's own host. Only a rule
  // with neither is global, because a global parameter is applied everywhere.
  const domains = rule.domains.map((domain) => etldPlusOne(domain)).filter(Boolean);
  if (domains.length === 0 && rule.host) {
    const key = etldPlusOne(rule.host);
    if (key) domains.push(key);
  }
  const unsupported = (reason) => {
    recordDrop(record, line, rule.text, "removeparam.unsupported");
    return { keep: false, reason };
  };
  if (rule.exception) return unsupported("exception");
  if (modifier.value === null || modifier.value.length === 0) return unsupported("strip-all");
  if (modifier.negated || modifier.value.startsWith("~")) return unsupported("inverted");
  if (modifier.value.startsWith("/")) {
    const closing = modifier.value.lastIndexOf("/");
    if (closing <= 0) return unsupported("regex");
    linkcleaner.regex.push({
      domains: sortStrings(domains),
      pattern: modifier.value.slice(1, closing),
    });
    recordDrop(record, line, rule.text, "removeparam.translated");
    return { keep: false };
  }
  const params = modifier.value.split("|");
  for (const param of params) {
    if (param.startsWith("~") || param.includes("=")) return unsupported("value-matching");
  }
  for (const param of params) {
    if (domains.length === 0) {
      linkcleaner.global.add(param);
      continue;
    }
    for (const domain of domains) {
      if (!linkcleaner.byDomain.has(domain)) linkcleaner.byDomain.set(domain, new Set());
      linkcleaner.byDomain.get(domain).add(param);
    }
  }
  recordDrop(record, line, rule.text, "removeparam.translated");
  return { keep: false };
}

/** $csp -> site fix. PIPELINE 9.2. */
function translateCsp(rule, sitefixEntries, record, line, listId) {
  const modifier = getModifier(rule, "csp");
  if (!modifier) return { keep: true };
  if (rule.exception) {
    recordDrop(record, line, rule.text, "csp.exception");
    return { keep: false };
  }
  const domains = rule.domains.map((domain) => etldPlusOne(domain)).filter(Boolean);
  if (domains.length === 0 && rule.host) {
    const key = etldPlusOne(rule.host);
    if (key) domains.push(key);
  }
  if (domains.length === 0) {
    recordDrop(record, line, rule.text, "csp.generic");
    return { keep: false };
  }
  sitefixEntries.push({
    domains: sortStrings(domains),
    csp: modifier.value ?? "",
    source: `${listId}#${line}`,
  });
  recordDrop(record, line, rule.text, "csp.translated");
  return { keep: false };
}

export async function run(ctx) {
  const alias = await ctx.config.alias();
  const surrogateConfig = await ctx.config.surrogates();
  const { probes, hints } = surrogateProbes(surrogateConfig);
  await ensureDir(ctx.paths.xlated);
  await ensureDir(ctx.paths.aux);

  const linkcleaner = { global: new Set(), byDomain: new Map(), regex: [] };
  const popupDomains = new Set();
  const sitefixEntries = [];
  const candidates = [];
  const perList = {};

  for (const list of ctx.selectedLists()) {
    const file = ctx.file.trusted(list.id);
    if (!exists(file)) {
      ctx.log.warn("no-trusted-body", { listId: list.id });
      continue;
    }
    const lines = (await readLines(file)) ?? [];
    const record = newRecord(list);
    record.counts.in = lines.length;
    const out = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = index + 1;
      const text = lines[index];
      const rule = parseRule(text);
      if (rule === null) continue;

      // Lists with a non-rule role contribute payloads only, never content rules.
      if (list.role === "removeparam") {
        if (rule.type === "network" && hasModifier(rule, "removeparam")) {
          translateRemoveParam(rule, linkcleaner, record, line);
        } else {
          recordDrop(record, line, text, "role.removeparam-only");
        }
        continue;
      }
      if (list.role === "popup-index") {
        if (rule.type === "network") addPopupDomains(rule, popupDomains);
        recordDrop(record, line, text, "role.popup-index-only");
        continue;
      }

      let current = { ...rule, text };
      if (rule.type === "cosmetic") {
        if (rule.isScriptlet) {
          const result = translateScriptlet(current, list, alias, record, line);
          if (!result.keep) continue;
          if (result.text) current = { ...parseRule(result.text), text: result.text };
        }
        out.push(current.text);
        record.counts.kept += 1;
        continue;
      }

      const csp = translateCsp(current, sitefixEntries, record, line, list.id);
      if (!csp.keep) continue;
      const removeparam = translateRemoveParam(current, linkcleaner, record, line);
      if (!removeparam.keep) continue;
      if (hasModifier(current, "popup") && !current.exception) {
        addPopupDomains(current, popupDomains);
      }
      const redirect = translateRedirect(current, alias, record, line);
      if (redirect.text) current = { ...parseRule(redirect.text), text: redirect.text };

      // Surrogate annotation (PIPELINE 9.5): a cheap hint test first, because this
      // runs over the whole merged set.
      const lowered = current.text.toLowerCase();
      if (hints.some((hint) => lowered.includes(hint))) {
        const matched = new Set();
        for (const probe of probes) {
          if (matched.has(probe.id)) continue;
          if (!matchesUrl(current.pattern, probe.url)) continue;
          matched.add(probe.id);
          candidates.push({
            rule: current.text,
            kind: current.exception ? "exception" : "block",
            surrogate: probe.id,
            listId: list.id,
          });
        }
      }

      out.push(current.text);
      record.counts.kept += 1;
    }

    await writeLines(ctx.file.xlated(list.id), out);
    await writeJson(ctx.file.xlate(list.id), record);
    perList[list.id] = {
      in: record.counts.in,
      kept: record.counts.kept,
      rewritten: record.counts.rewritten,
      dropped: record.counts.dropped,
      causes: record.dropCounts,
    };
    ctx.log.info("list", {
      listId: list.id,
      kept: record.counts.kept,
      rewritten: record.counts.rewritten,
      dropped: record.counts.dropped,
    });
  }

  await writeJsonl(ctx.paths.surrogateCandidates, candidates);

  await writeJson(ctx.paths.linkcleaner, {
    schemaVersion: 1,
    global: sortStrings([...linkcleaner.global]),
    byDomain: Object.fromEntries(
      sortStrings([...linkcleaner.byDomain.keys()]).map((domain) => [
        domain,
        sortStrings([...linkcleaner.byDomain.get(domain)]),
      ]),
    ),
    regex: linkcleaner.regex
      .map((entry) => ({ domains: entry.domains, pattern: entry.pattern }))
      .sort((a, b) => byCodeUnit(a.pattern + a.domains.join("|"), b.pattern + b.domains.join("|"))),
  });

  await writeJson(ctx.paths.popupIndex, {
    schemaVersion: 1,
    domains: sortStrings([...popupDomains]),
  });

  const cspEntries = sitefixEntries.sort((a, b) =>
    byCodeUnit(a.domains.join("|") + a.csp + a.source, b.domains.join("|") + b.csp + b.source),
  );
  await writeJson(ctx.paths.sitefix, {
    schemaVersion: 1,
    note:
      "entries is the PIPELINE 9.2 shape with provenance (source is listId#line, the line " +
      "being the 1-based line in build/trusted/<listId>.txt); csp, surrogates and notes are the " +
      "payload shape the app reads (CONTRACT 10.3). surrogates is filled in by the active stage.",
    entries: cspEntries,
    csp: cspEntries.map((entry) => ({ domains: entry.domains, csp: entry.csp })),
    surrogates: [],
    notes: [],
  });

  const summary = {
    stage: "translate",
    lists: Object.keys(perList).length,
    linkcleaner: {
      global: linkcleaner.global.size,
      domains: linkcleaner.byDomain.size,
      regex: linkcleaner.regex.length,
    },
    popupDomains: popupDomains.size,
    csp: cspEntries.length,
    surrogateCandidates: candidates.length,
    perList,
  };
  ctx.log.info("done", {
    csp: cspEntries.length,
    popupDomains: popupDomains.size,
    candidates: candidates.length,
  });
  return summary;
}
