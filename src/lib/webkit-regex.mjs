// WebKit content-rule regex lint. PIPELINE 11.2, config/surrogates.json.
//
// WKContentRuleListStore accepts only a subset of regular expressions, and the
// patterns we write ourselves (the surrogate fallback blocks) reach the
// converter verbatim. SafariConverterLib reports a rejected pattern only as a
// COUNT, so one bad character surfaces in CI as "N rule error(s)" with nothing
// naming the rule. This lint names it here, before a run starts.
//
// Found the hard way on 2026-09-13: seven fallback patterns wrote an escaped
// hyphen inside a character class ("[a-z0-9.\-]"), which WebKit rejects. A
// hyphen placed last in the class ("[a-z0-9.-]") means the same thing and is
// accepted.

import { policyError } from "./errors.mjs";

/** Constructs WebKit's URL filter parser does not accept, with the fix to apply. */
const UNSUPPORTED = [
  [/\\-/, 'an escaped hyphen: put "-" last inside the character class instead'],
  [/\(\?/, 'a group modifier "(?": WebKit supports neither lookaround nor non-capturing groups'],
  [/\{\d+(,\d*)?\}/, 'a counted quantifier "{n,m}"'],
  [/\\[1-9]/, "a backreference"],
  [/\\[bBdDwWsS]/, 'a class escape such as \\d or \\w: spell it as a character class'],
];

/** The reason `pattern` would be rejected, or null when it is acceptable. */
export function webKitRegexProblem(pattern) {
  for (const [probe, why] of UNSUPPORTED) {
    if (probe.test(pattern)) return why;
  }
  return null;
}

/** Throws a policy error naming the pattern and why WebKit would reject it. */
export function assertWebKitRegex(pattern, context = {}) {
  const problem = webKitRegexProblem(pattern);
  if (!problem) return;
  throw policyError(`WebKit will reject this url-filter regex: it contains ${problem}`, {
    ...context,
    pattern,
  });
}
