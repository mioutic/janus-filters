// Pattern matching, used only to decide which rules concern a surrogate
// (PIPELINE 9.5 and 11.4). It never decides what the phone blocks - WebKit does
// that - so it may be approximate in one direction only: a false positive adds a
// surrogate candidate a human sees in build/reports/surrogates.json, while a
// false negative would silently leave an unbreak exception unfolded. The tests
// pin both directions for the patterns in config/surrogates.json.

const MAX_ALTERNATION_EXPANSIONS = 8;

/** Expands `(a|b)` groups into separate strings, capped so a pathological pattern cannot blow up. */
function expandAlternations(pattern) {
  const open = pattern.indexOf("(");
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === "\\") {
      i += 1;
      continue;
    }
    if (pattern[i] === "(") depth += 1;
    if (pattern[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const body = pattern.slice(open + 1, close).replace(/^\?:/, "");
  const tail = pattern.slice(close + 1);
  const out = [];
  for (const alternative of body.split("|")) {
    for (const expanded of expandAlternations(head + alternative + tail)) {
      out.push(expanded);
      if (out.length >= MAX_ALTERNATION_EXPANSIONS) return out;
    }
  }
  return out;
}

/**
 * Turns a WebKit url-filter regex into concrete URLs it would match, so a filter
 * rule can be tested against them.
 * @returns {string[]} zero URLs when the pattern is too complex to reduce
 */
export function regexToProbeUrls(pattern) {
  const urls = new Set();
  for (const alternative of expandAlternations(pattern)) {
    let text = alternative.replace(/https\?/g, "https");
    if (text.startsWith("^")) text = text.slice(1);
    if (text.endsWith("$")) text = text.slice(0, -1);
    for (let candidate of reduceVariants(text)) {
      if (candidate.startsWith("/")) candidate = `https://probe.invalid${candidate}`;
      if (!/^https?:\/\//.test(candidate)) continue;
      urls.add(candidate);
    }
  }
  return [...urls];
}

/**
 * Reduces a regex body to the concrete strings it can match, branching on every
 * optional construct: `[0-9a-z]*` yields both "" and a filler character, so
 * `/prebid[0-9a-z._-]*\.js` produces probes for `/prebid.js` and `/prebidx.js`.
 * @returns {string[]} empty when the body uses a construct with no useful probe
 */
function reduceVariants(body) {
  let variants = [""];
  const push = (options) => {
    const next = [];
    for (const variant of variants) {
      for (const option of options) {
        next.push(variant + option);
        if (next.length >= MAX_ALTERNATION_EXPANSIONS) break;
      }
      if (next.length >= MAX_ALTERNATION_EXPANSIONS) break;
    }
    variants = next;
  };
  let index = 0;
  while (index < body.length) {
    const rest = body.slice(index);
    let match = /^\\(.)([*?+]?)/.exec(rest);
    if (match) {
      push(match[2] === "*" || match[2] === "?" ? ["", match[1]] : [match[1]]);
      index += match[0].length;
      continue;
    }
    match = /^\[[^\]]*\]([*?+]?)/.exec(rest);
    if (match) {
      push(match[1] === "*" || match[1] === "?" ? ["", "x"] : ["x"]);
      index += match[0].length;
      continue;
    }
    match = /^\.([*?+]?)/.exec(rest);
    if (match) {
      const quantifier = match[1];
      const tail = body.slice(index + match[0].length);
      const options = quantifier === "*" || quantifier === "?" ? ["", "x"] : ["x"];
      // A wildcard before a query parameter is nearly always the "?" itself.
      if (quantifier !== "" && tail.includes("=") && !variants.some((v) => v.includes("?"))) {
        options.unshift("?");
      }
      push(options);
      index += match[0].length;
      continue;
    }
    match = /^([A-Za-z0-9:/._~=&%,;@-])([*?+]?)/.exec(rest);
    if (match) {
      push(match[2] === "*" || match[2] === "?" ? ["", match[1]] : [match[1]]);
      index += match[0].length;
      continue;
    }
    if (rest.startsWith("^") || rest.startsWith("$")) {
      index += 1;
      continue;
    }
    return [];
  }
  return variants;
}

/** Converts an adblock network pattern into a RegExp, or null when it cannot. */
export function patternToRegExp(pattern) {
  if (pattern.length === 0) return null;
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      return new RegExp(pattern.slice(1, -1), "i");
    } catch {
      return null;
    }
  }
  let source = "";
  let index = 0;
  if (pattern.startsWith("||")) {
    source += "^https?://([a-z0-9_-]+\\.)*";
    index = 2;
  } else if (pattern.startsWith("|")) {
    source += "^";
    index = 1;
  }
  for (; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === "*") {
      source += ".*";
    } else if (ch === "^") {
      source += "([/:?&=,;]|$)";
    } else if (ch === "|" && index === pattern.length - 1) {
      source += "$";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/** True when an adblock pattern matches a concrete URL. */
export function matchesUrl(pattern, url) {
  const regex = patternToRegExp(pattern);
  if (regex === null) return false;
  return regex.test(url);
}
