// Rule parsing, normalisation and identity. PIPELINE sections 7.3 and 10.2.
//
// A rule is one normalised line of filter text; two rules are identical when
// their normalised text is byte-identical. Everything downstream - dedupe,
// $badfilter, the bucket hash, the reports - keys on what this module returns,
// so the normalisation here is part of the wire format, not a convenience.

import { byCodeUnit } from "./io.mjs";
import { etldPlusOne, normaliseHost } from "./psl.mjs";

/** Cosmetic separators, longest first so "#@$?#" wins over "#@#". */
export const COSMETIC_SEPARATORS = [
  "#@$?#",
  "#@%#",
  "#@$#",
  "#@?#",
  "#$?#",
  "#@#",
  "#$#",
  "#%#",
  "#?#",
  "##",
];

/** Modifier names the pipeline knows. Used to split values that contain commas. */
export const KNOWN_MODIFIERS = new Set([
  "1p", "3p", "all", "app", "badfilter", "beacon", "cname", "content", "cookie",
  "csp", "csp-report", "css", "denyallow", "doc", "document", "domain", "ehide",
  "elemhide", "empty", "extension", "first-party", "font", "frame", "from",
  "generichide", "genericblock", "ghide", "header", "hls", "image", "important",
  "inline-font", "inline-script", "jsinject", "jsonprune", "match-case", "media",
  "method", "mp4", "network", "noop", "object", "object-subrequest", "other",
  "permissions", "ping", "popup", "popunder", "redirect", "redirect-rule",
  "referrerpolicy", "removeheader", "removeparam", "replace", "script",
  "shide", "specifichide", "speculationrules", "stealth", "strict1p", "strict3p",
  "stylesheet", "subdocument", "third-party", "to", "urlblock", "uritransform",
  "urltransform", "webbundle", "websocket", "webrtc", "xhr", "xmlhttprequest",
  "xmlprune",
]);

/** Modifiers that make an exception a page-level allowlist (PIPELINE 10.4 section 4). */
export const DOCUMENT_ALLOWLIST_MODIFIERS = new Set(["document", "doc", "urlblock"]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f\ufeff]/;

export function isEmptyLine(line) {
  return line.trim().length === 0;
}

/** PIPELINE 7.3 step 2. Cosmetic markers are rules, not comments. */
export function isComment(line) {
  if (line.startsWith("!")) return true;
  if (line.startsWith("[") && line.endsWith("]")) return true;
  if (line.startsWith("#")) {
    if (line.length === 1) return true;
    const next = line[1];
    if (next === " " || next === "\t") return true;
  }
  return false;
}

/** `!#include`, `!#if`, `!#else`, `!#endif`, `!#safari_cb_affinity`. */
export function directiveOf(line) {
  if (!line.startsWith("!#")) return null;
  const match = /^!#([a-z_]+)\s*(.*)$/i.exec(line);
  if (!match) return null;
  return { name: match[1].toLowerCase(), argument: match[2].trim() };
}

/** Index and separator of the cosmetic marker, or null for a network rule. */
export function findCosmeticSeparator(line) {
  let best = null;
  for (const separator of COSMETIC_SEPARATORS) {
    const index = line.indexOf(separator);
    if (index === -1) continue;
    if (best === null || index < best.index || (index === best.index && separator.length > best.separator.length)) {
      best = { index, separator };
    }
  }
  if (best === null) return null;
  // A "#" inside a URL pattern is a fragment, not a cosmetic marker.
  const prefix = line.slice(0, best.index);
  if (/[/^$*|]/.test(prefix)) return null;
  return best;
}

/**
 * uBO writes `example.com>>` for "this domain anywhere in the frame ancestry".
 * WebKit has no such trigger, so the decoration is dropped and the rule is kept
 * scoped to the domain itself, which is what the author meant on that site.
 */
export function stripDomainDecorations(value) {
  return value.endsWith(">>") ? value.slice(0, -2) : value;
}

function splitDomainList(text) {
  const domains = [];
  const negated = [];
  for (const part of text.split(/[,|]/)) {
    const value = stripDomainDecorations(part.trim());
    if (value.length === 0) continue;
    if (value.startsWith("~")) {
      const host = normaliseHost(value.slice(1));
      if (host) negated.push(host);
    } else {
      const host = normaliseHost(value);
      if (host) domains.push(host);
    }
  }
  return { domains, negated };
}

/** True when `rest` begins with a modifier we know, so a comma before it splits. */
function startsWithKnownModifier(rest) {
  const match = /^~?([a-z0-9_-]+)\s*(=|,|$)/i.exec(rest);
  if (!match) return false;
  return KNOWN_MODIFIERS.has(match[1].toLowerCase());
}

/**
 * Splits the modifier section on commas, keeping commas that sit inside a value
 * such as `$replace=/a,b/c/` or a regex `$removeparam=/^ad_[0-9],x/`.
 */
export function splitModifierSection(section) {
  const parts = [];
  let current = "";
  for (let i = 0; i < section.length; i += 1) {
    const ch = section[i];
    if (ch === "\\") {
      current += ch + (section[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === ",") {
      if (startsWithKnownModifier(section.slice(i + 1))) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.filter((part) => part.length > 0);
}

/** Finds the `$` that starts the modifier section, or -1. */
function modifierStart(text) {
  // A regex pattern (/.../) may contain $; the modifiers begin after its close.
  let searchFrom = 0;
  if (text.startsWith("/")) {
    const close = text.indexOf("/", 1);
    if (close !== -1) searchFrom = close + 1;
  }
  for (let i = searchFrom; i < text.length; i += 1) {
    if (text[i] !== "$") continue;
    if (i > 0 && text[i - 1] === "\\") continue;
    // AdGuard HTML filtering uses "$$" / "$@$"; that is not a modifier section.
    if (text[i + 1] === "$") return -1;
    if (text[i + 1] === "@" && text[i + 2] === "$") return -1;
    return i;
  }
  return -1;
}

export function parseModifier(token) {
  const negated = token.startsWith("~");
  const body = negated ? token.slice(1) : token;
  const eq = body.indexOf("=");
  if (eq === -1) return { name: body.toLowerCase(), negated, value: null };
  return { name: body.slice(0, eq).toLowerCase(), negated, value: body.slice(eq + 1) };
}

export function serialiseModifier(modifier) {
  const head = (modifier.negated ? "~" : "") + modifier.name;
  return modifier.value === null ? head : `${head}=${modifier.value}`;
}

/**
 * Canonical modifier order: alphabetical by name, values untouched, duplicates
 * collapsed (PIPELINE 7.3 step 6). This is what makes dedupe and $badfilter
 * matching reliable across lists that write the same rule differently.
 */
export function canonicaliseModifiers(modifiers) {
  const seen = new Set();
  const unique = [];
  for (const modifier of modifiers) {
    const key = serialiseModifier(modifier);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(modifier);
  }
  return unique.sort((a, b) => {
    const byName = byCodeUnit(a.name, b.name);
    if (byName !== 0) return byName;
    if (a.negated !== b.negated) return a.negated ? 1 : -1;
    return byCodeUnit(a.value ?? "", b.value ?? "");
  });
}

/** Extracts a host from a network pattern, or null when there is none to key on. */
export function hostFromPattern(pattern) {
  let text = pattern;
  if (text.startsWith("@@")) text = text.slice(2);
  if (text.startsWith("/") && text.endsWith("/") && text.length > 2) return null; // regex rule
  let host = null;
  if (text.startsWith("||")) {
    host = text.slice(2);
  } else {
    const scheme = /^\|?(?:https?|wss?|ftp):\/\/([^/^*?|]+)/i.exec(text);
    if (scheme) {
      host = scheme[1];
    } else if (text.startsWith("://")) {
      host = text.slice(3);
    } else {
      const bare = /^\|?([a-z0-9*_-]+(?:\.[a-z0-9*_-]+)+)[/^:]/i.exec(text);
      if (bare) host = bare[1];
    }
  }
  if (host === null) return null;
  host = host.split(/[/^:?*|]/)[0];
  if (host.startsWith("*.")) host = host.slice(2);
  if (host.length === 0 || !host.includes(".")) return null;
  if (host.includes("*")) return null;
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1); // strip userinfo
  return normaliseHost(host);
}

/** Lower-cases the host inside a network pattern, leaving path and query alone. */
function lowerCasePatternHost(pattern) {
  const apply = (prefix, host, rest) => {
    const normalised = host.includes("*") ? host.toLowerCase() : (normaliseHost(host) ?? host.toLowerCase());
    return prefix + normalised + rest;
  };
  let match = /^(\|\|)([^/^*?|$]+)(.*)$/s.exec(pattern);
  if (match) return apply(match[1], match[2], match[3]);
  match = /^(\|?(?:https?|wss?|ftp):\/\/)([^/^*?|$]+)(.*)$/is.exec(pattern);
  if (match) return apply(match[1].toLowerCase(), match[2], match[3]);
  match = /^(:\/\/)([^/^*?|$]+)(.*)$/s.exec(pattern);
  if (match) return apply(match[1], match[2], match[3]);
  return pattern;
}

/** Lower-cases and punycodes the host values of domain-like modifiers. */
function normaliseModifierValue(modifier) {
  const domainLike = new Set(["domain", "from", "to", "denyallow", "app"]);
  if (!domainLike.has(modifier.name) || modifier.value === null) return modifier;
  const parts = modifier.value.split("|").map((part) => {
    const negated = part.startsWith("~");
    const raw = negated ? part.slice(1) : part;
    if (raw.startsWith("/") && raw.endsWith("/")) return part; // regex domain value
    const host = normaliseHost(raw);
    return (negated ? "~" : "") + (host ?? raw.toLowerCase());
  });
  return { ...modifier, value: parts.join("|") };
}

export function parseNetworkRule(text) {
  const exception = text.startsWith("@@");
  const body = exception ? text.slice(2) : text;
  const dollar = modifierStart(body);
  const pattern = dollar === -1 ? body : body.slice(0, dollar);
  const section = dollar === -1 ? "" : body.slice(dollar + 1);
  const modifiers = section.length === 0 ? [] : splitModifierSection(section).map(parseModifier);
  const domainModifier = modifiers.find((m) => m.name === "domain" || m.name === "from");
  const { domains, negated } = domainModifier?.value
    ? splitDomainList(domainModifier.value)
    : { domains: [], negated: [] };
  return {
    type: "network",
    text,
    exception,
    pattern,
    modifiers,
    domains,
    negatedDomains: negated,
    important: modifiers.some((m) => m.name === "important" && !m.negated),
    host: hostFromPattern(pattern),
  };
}

export function serialiseNetworkRule(rule) {
  const head = (rule.exception ? "@@" : "") + rule.pattern;
  if (rule.modifiers.length === 0) return head;
  return `${head}$${rule.modifiers.map(serialiseModifier).join(",")}`;
}

export function parseCosmeticRule(text) {
  const found = findCosmeticSeparator(text);
  if (found === null) return null;
  const { index, separator } = found;
  const prefix = text.slice(0, index);
  const body = text.slice(index + separator.length);
  const { domains, negated } = splitDomainList(prefix);
  const exception = separator.includes("@");
  const isScriptlet =
    body.startsWith("//scriptlet") || body.startsWith("+js(") || separator.includes("%");
  return {
    type: "cosmetic",
    text,
    separator,
    prefix,
    body,
    domains,
    negatedDomains: negated,
    exception,
    important: false,
    isScriptlet,
    isJavaScript: separator.includes("%") && !body.startsWith("//scriptlet"),
    generic: domains.length === 0,
  };
}

export function serialiseCosmeticRule(rule) {
  return rule.prefix + rule.separator + rule.body;
}

/** Parses one already-trimmed, non-comment line. */
export function parseRule(text) {
  const cosmetic = parseCosmeticRule(text);
  if (cosmetic !== null) return cosmetic;
  return parseNetworkRule(text);
}

export function serialiseRule(rule) {
  return rule.type === "cosmetic" ? serialiseCosmeticRule(rule) : serialiseNetworkRule(rule);
}

/** Collapses whitespace runs in a selector when that is unambiguous (7.3 step 7). */
function tidyCosmeticBody(body) {
  if (/["'()[\]]/.test(body)) return body;
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Normalises one line. PIPELINE 7.3.
 * @param {string} line raw line, any whitespace
 * @returns {{status:"empty"|"comment"|"directive"|"rule"|"drop", text?:string, rule?:object, cause?:string, directive?:object}}
 */
export function normaliseLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { status: "empty" };
  const directive = directiveOf(trimmed);
  if (directive !== null) return { status: "directive", directive, text: trimmed };
  if (isComment(trimmed)) return { status: "comment" };
  if (CONTROL_CHARS.test(trimmed)) return { status: "drop", cause: "normalise.control_char" };

  const parsed = parseRule(trimmed);
  if (parsed === null) return { status: "drop", cause: "normalise.unparsable" };

  if (parsed.type === "cosmetic") {
    const prefixParts = [];
    for (const part of parsed.prefix.split(",")) {
      const value = stripDomainDecorations(part.trim());
      if (value.length === 0) continue;
      const negated = value.startsWith("~");
      const raw = negated ? value.slice(1) : value;
      const host = normaliseHost(raw);
      if (host === null) return { status: "drop", cause: "normalise.bad_idn" };
      prefixParts.push((negated ? "~" : "") + host);
    }
    const normalised = {
      ...parsed,
      prefix: prefixParts.join(","),
      body: tidyCosmeticBody(parsed.body),
    };
    normalised.text = serialiseCosmeticRule(normalised);
    return { status: "rule", text: normalised.text, rule: normalised };
  }

  // A host-anchored pattern whose host cannot be punycoded is dropped. A host
  // with a wildcard in it (||ad-host-*.example.com^) is not a broken host: the
  // converter handles it, so it must survive normalisation.
  const rawHost = /^\|\|([^/^?|$]+)/.exec(parsed.pattern)?.[1].split(":")[0] ?? null;
  if (rawHost !== null && !rawHost.includes("*") && normaliseHost(rawHost) === null) {
    return { status: "drop", cause: "normalise.bad_idn" };
  }
  const normalised = {
    ...parsed,
    pattern: lowerCasePatternHost(parsed.pattern),
    modifiers: canonicaliseModifiers(parsed.modifiers.map(normaliseModifierValue)),
  };
  normalised.host = hostFromPattern(normalised.pattern);
  const domainModifier = normalised.modifiers.find((m) => m.name === "domain" || m.name === "from");
  const split = domainModifier?.value
    ? splitDomainList(domainModifier.value)
    : { domains: [], negated: [] };
  normalised.domains = split.domains;
  normalised.negatedDomains = split.negated;
  normalised.text = serialiseNetworkRule(normalised);
  return { status: "rule", text: normalised.text, rule: normalised };
}

export function hasModifier(rule, name) {
  return rule.type === "network" && rule.modifiers.some((m) => m.name === name);
}

export function getModifier(rule, name) {
  if (rule.type !== "network") return null;
  return rule.modifiers.find((m) => m.name === name) ?? null;
}

/** `$badfilter` neutralised form: the same rule without the badfilter modifier. */
export function neutralisedBadfilterText(rule) {
  if (!hasModifier(rule, "badfilter")) return null;
  const modifiers = rule.modifiers.filter((m) => m.name !== "badfilter");
  return serialiseNetworkRule({ ...rule, modifiers: canonicaliseModifiers(modifiers) });
}

/** True for an exception that allowlists a whole page within its family. */
export function isDocumentAllowlist(rule) {
  if (rule.type !== "network" || !rule.exception) return false;
  return rule.modifiers.some((m) => !m.negated && DOCUMENT_ALLOWLIST_MODIFIERS.has(m.name));
}

/**
 * The bucket key: eTLD+1 of the rule's own host, else of its first positive
 * domain, else "" for a host-less rule. PIPELINE 10.2 and 10.3.
 */
export function bucketKey(rule) {
  if (rule.type === "cosmetic") {
    if (rule.domains.length === 0) return "";
    return etldPlusOne(rule.domains[0]) ?? "";
  }
  if (rule.host) {
    const key = etldPlusOne(rule.host);
    if (key) return key;
  }
  if (rule.domains.length > 0) {
    return etldPlusOne(rule.domains[0]) ?? "";
  }
  return "";
}

/** Every eTLD+1 an exception is scoped to (PIPELINE 10.5, multi-domain case). */
export function scopeKeys(rule) {
  const keys = new Set();
  if (rule.type === "network" && rule.host) {
    const key = etldPlusOne(rule.host);
    if (key) keys.add(key);
  }
  for (const domain of rule.domains) {
    const key = etldPlusOne(domain);
    if (key) keys.add(key);
  }
  return [...keys].sort(byCodeUnit);
}
