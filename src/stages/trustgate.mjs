// Stage: trust gate. PIPELINE section 8.
// DESIGN 3.2: trusted-* scriptlets and #%# JavaScript are kept only from uAssets,
// AdGuard official lists and the Janus list; CI strips them everywhere else.
// A list-supplied #%# body is remote code the app will run on matching sites, and
// the only thing behind it is the upstream maintainer plus this repo's signature.

import { policyError } from "../lib/errors.mjs";
import { ensureDir, exists, readLines, writeJson, writeLines } from "../lib/io.mjs";
import { parseAdguardScriptletBody, parseUboScriptletBody } from "../lib/alias-transforms.mjs";
import { parseRule } from "../lib/rule.mjs";

/**
 * Any spelling of a scriptlet call, whatever syntax it is dressed in:
 * `+js(name`, `+JS(name`, `script:inject(name`. Group 1 is the name.
 */
const SCRIPTLET_CALL = /(?:^|:)\s*(?:\+js|script:inject)\s*\(\s*['"]?\s*([^,)'"]+)/i;

/**
 * Decides what an untrusted list loses.
 * @returns {{keep: boolean, reason?: string}}
 */
export function gateDecision(text, trustConfig) {
  const strict = trustConfig.mode === "strict";
  const prefix = trustConfig.trustedScriptletPrefix ?? "trusted-";
  const stripped = new Set(trustConfig.strippedModifiers ?? []);

  if (text.startsWith("!#")) return { keep: false, reason: "include" };

  const rule = parseRule(text);
  if (rule === null) return { keep: true };

  if (rule.type === "cosmetic") {
    // A scriptlet call the converter of the day happens not to recognise is still
    // a scriptlet call: `+JS(` and `script:inject(` are the same request in
    // different clothes, and a converter upgrade would turn a miss here into a
    // live bypass of DESIGN 3.2. Judge the body, not the spelling.
    const call = SCRIPTLET_CALL.exec(rule.body);
    if (call) {
      if (call[1].toLowerCase().startsWith(prefix)) {
        return { keep: false, reason: "trusted-scriptlet" };
      }
      if (strict) return { keep: false, reason: "strict-mode-scriptlet" };
    }
    const isJsSeparator = rule.separator === "#%#" || rule.separator === "#@%#";
    if (isJsSeparator) {
      const call = parseAdguardScriptletBody(rule.body);
      if (call === null) return { keep: false, reason: "raw-javascript" };
      if (call.name.startsWith(prefix)) return { keep: false, reason: "trusted-scriptlet" };
      if (strict) return { keep: false, reason: "strict-mode-scriptlet" };
      return { keep: true };
    }
    const ubo = parseUboScriptletBody(rule.body);
    if (ubo !== null) {
      if (ubo.name.startsWith(prefix)) return { keep: false, reason: "trusted-scriptlet" };
      if (strict) return { keep: false, reason: "strict-mode-scriptlet" };
      return { keep: true };
    }
    return { keep: true };
  }

  for (const modifier of rule.modifiers) {
    if (stripped.has(modifier.name)) {
      return { keep: false, reason: `stripped-modifier:${modifier.name}` };
    }
  }
  return { keep: true };
}

function validateTrustConfig(config) {
  if (config?.mode !== "design" && config?.mode !== "strict") {
    throw policyError(
      `config/trust.json mode must be "design" or "strict", got ${JSON.stringify(config?.mode)}`,
    );
  }
  if (!Array.isArray(config.strippedModifiers)) {
    throw policyError("config/trust.json needs a strippedModifiers array");
  }
}

export async function run(ctx) {
  const trustConfig = await ctx.config.trust();
  validateTrustConfig(trustConfig);
  await ensureDir(ctx.paths.trusted);

  const perList = {};
  let totalStripped = 0;
  for (const list of ctx.selectedLists()) {
    const file = ctx.file.prepared(list.id);
    if (!exists(file)) {
      ctx.log.warn("no-prepared-body", { listId: list.id });
      continue;
    }
    const lines = (await readLines(file)) ?? [];
    const kept = [];
    const strippedRules = [];

    if (list.trust === "trusted") {
      // push(...lines) would spread 137k arguments onto the call stack.
      for (const text of lines) kept.push(text);
    } else {
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index];
        const decision = gateDecision(text, trustConfig);
        if (decision.keep) {
          kept.push(text);
          continue;
        }
        strippedRules.push({ rule: text, line: index + 1, reason: decision.reason });
      }
    }

    await writeLines(ctx.file.trusted(list.id), kept);
    await writeJson(ctx.file.gate(list.id), {
      schemaVersion: 1,
      listId: list.id,
      trust: list.trust,
      mode: trustConfig.mode,
      note: "line is the 1-based line number in build/prepared/<listId>.txt",
      counts: { in: lines.length, kept: kept.length, stripped: strippedRules.length },
      stripped: strippedRules,
    });

    totalStripped += strippedRules.length;
    perList[list.id] = {
      trust: list.trust,
      in: lines.length,
      kept: kept.length,
      stripped: strippedRules.length,
    };
    ctx.log.info("list", {
      listId: list.id,
      trust: list.trust,
      kept: kept.length,
      stripped: strippedRules.length,
    });
  }

  return { stage: "trustgate", mode: trustConfig.mode, stripped: totalStripped, perList };
}
