# janus-filters build pipeline

Status: normative for milestone M2a. Version 1 of the pipeline contract.
Governing spec: `Janus/docs/DESIGN.md` sections 1, 3, 9, 10 (private repo). Where this
document and DESIGN disagree, DESIGN wins and this document is wrong and must be fixed.

This document defines, for every stage: its inputs, its outputs, its algorithm, its exit
codes and its budgets. `docs/CONTRACT.md` defines what leaves this repo and what the Janus
app is allowed to assume. Nothing in this repository contains personal data, credentials or
app source; the only secret is the signing key, read from the environment inside one job.

---

## 1. What this repository does

The Janus iPhone browser blocks at uBlock Origin level, but WebKit only accepts compiled
`WKContentRuleList` JSON plus, for everything content rules cannot express, an advanced-rules
payload answered per URL by SafariConverterLib's `FilterEngine`. This repository is the
factory: every day it turns public filter lists into a **signed, versioned, compile-validated
bundle** that the app downloads without credentials.

Three properties matter more than anything else.

1. **Fail closed.** A partial, unvalidated or unsigned set is never published. The previous
   release stays `latest` and the app keeps the filters it already has. There is no state in
   which the app sees half a bundle.
2. **Stable identity.** A bucket whose rules did not change keeps byte-identical JSON and
   therefore the same SHA-256, so a daily update re-downloads and recompiles only what moved.
   Every stage is deterministic: same inputs, same bytes.
3. **Honest losses.** Everything the converter cannot express is counted, categorised and
   reported per list and per day. Blocking that silently disappears is worse than blocking
   that is known to be missing.

The pipeline is a straight line of pure stages. Each stage reads files written by the previous
stage and writes its own; no stage mutates another stage's output. That makes every stage
independently testable, re-runnable and diffable, and it is why the dry run on Windows can
execute everything except the two macOS-only stages.

```
lists.json --> fetch --> preprocess --> trust gate --> translate --> bucket --> active
                 |            |              |             |            |          |
             build/raw   build/prepared  build/trusted  build/xlated  build/buckets/*.txt
                                                             |                      |
                                                        build/auxdata/*.json            |
                                                                                    v
                                       (macOS)  convert --> validate --> compress --> pack
                                                    |           |            |          |
                                         build/converted  build/validate  build/dist  manifest.json
                                                                                          |
                                                                       (environment filters-release)
                                                                                   sign --> publish
```

---

## 2. Repository layout

Committed files. `build/` and `node_modules/` are the only generated trees and both are
ignored by git.

```
janus-filters/
|- README.md                     what this is, how the app uses it, no personal data
|- LICENSE                       GPL-3.0-or-later (our code)
|- NOTICE                        per-list attribution, licences, source URLs
|- VERSIONS.json                 every pin: npm, SwiftPM, tools, sha256, min Xcode
|- package.json                  Node 24, type: module, scripts, pinned deps
|- .gitignore
|- lists.json                    the default and opt-in list set (schema in section 5)
|- config/
|  |- env.json                   the !#if environment (section 7.2)
|  |- trust.json                 trust levels and the gate's strip rules (section 8)
|  |- ubo-alias.json             generated uBO -> AdGuard scriptlet alias map (section 9.1)
|  |- surrogates.json            surrogate patterns and redirect targets (section 11)
|  |- buckets.json               families, bucket counts B, budgets (section 10)
|  \- sitefix.txt                the hand-maintained Janus site-fix list
|- src/
|  |- cli.mjs                    `janus-filters <stage|command>` entry point
|  |- stages/                    one module per stage, each exporting run(ctx)
|  |  |- fetch.mjs preprocess.mjs trustgate.mjs translate.mjs
|  |  |- bucket.mjs active.mjs report.mjs pack.mjs
|  |  \- sign.mjs verify.mjs
|  \- lib/                       shared: rule parsing, hashing, PSL, fs, logging
|- test/
|  |- *.test.mjs                 node:test suites, one per stage plus lib
|  \- fixtures/                  tiny hand-written lists and expected outputs
|- Tools/
|  |- JanusConvert/              SwiftPM CLI, SafariConverterLib 4.3.0 (section 12)
|  \- RuleListValidate/          SwiftPM CLI, WKContentRuleListStore (section 13)
|- scripts/
|  |- pin-check.mjs              verifies every VERSIONS.json pin
|  \- gen-alias.mjs              regenerates config/ubo-alias.json (section 9.1)
|- docs/
|  |- PIPELINE.md                this file
|  \- CONTRACT.md                the app-facing interface
\- .github/workflows/
   |- filters.yml                daily build, convert, validate, sign, publish
   \- test.yml                   node:test on push and pull request
```

### 2.1 The build tree

Every generated path is under `build/`. Names are fixed: CI jobs, the dry run and the tests
all address them literally.

```
build/
|- cache/                        HTTP cache: <listId>.body, <listId>.meta.json
|- raw/<listId>.txt              exactly what the network returned, LF-normalised
|- prepared/<listId>.txt         after preprocess (includes expanded, !#if resolved)
|- prepared/<listId>.stats.json  kept and dropped counts for that list
|- trusted/<listId>.txt          after the trust gate
|- trusted/<listId>.gate.json    what the trust gate stripped, with line numbers
|- xlated/<listId>.txt           after translation (aliases applied)
|- xlated/<listId>.xlate.json    aliases applied, rules rewritten, rules dropped
|- previous-manifest.json        the published manifest this run is a delta against
|- merged.txt                    deduped union, in list order
|- merged.provenance.jsonl       one record per surviving rule: {rule, listId, line}
|- buckets/
|  |- <bucketId>.txt             converter input, one rule per line, final order
|  \- index.json                 bucket -> {family, optIn, optInSlug, ruleCount, sourceLists}
|- auxdata/
|  |- linkcleaner.json           $removeparam distilled for the app's LinkCleaner
|  |- popup-index.json           popup-domain index
|  |- sitefix.json               $csp translations and Janus site fixes
|  |- active-redirects.json      janus.active redirect rules and folded exceptions
|  |- active-splice.<flavour>.json  what pack --splice-active did (idempotency marker)
|  \- killswitches.json          defaults for the manifest kill switches
|- converted/<flavour>/
|  |- <bucketId>.json            WKContentRuleList JSON from JanusConvert
|  |- <bucketId>.conv.json       ConversionResult counters for that bucket
|  |- advanced.txt               advanced-rules text of the default-on buckets
|  |- advanced.<optInSlug>.txt   advanced-rules text of one opt-in list's buckets
|  |- engine.tar                 deterministic ustar of engine/.webext (pack builds it)
|  |- engine/engine.json         JanusConvert engine's JSON summary, incl. engineSchemaVersion
|  \- engine/.webext/*           FilterEngine binary (optional payload)
|- validate/<flavour>/
|  |- report.json                per bucket: ruleCount, compileMs, error, bisect log
|  \- dropped-bisect.jsonl       rules removed by the bisector, with reasons
|- reports/
|  |- dropped/<listId>.json      unconverted rules grouped by cause (section 14)
|  |- dropped.md                 human summary with day-over-day deltas
|  |- surrogates.json            which surrogates and ignore tails janus.active carries
|  \- budget.json                per-bucket counts against soft and hard caps
\- dist/
   |- <bucketId>.<flavour>.json.lzfse
   |- advanced.<flavour>.txt.lzfse
   |- advanced.<flavour>.<optInSlug>.txt.lzfse
   |- engine.<flavour>.tar.lzfse
   |- linkcleaner.json.lzfse popup-index.json.lzfse sitefix.json.lzfse
   |- manifest.json
   \- manifest.json.sig
```

---

## 3. Conventions that every stage obeys

**Determinism.** No timestamps, no map-iteration order, no locale collation, no randomness in
any file that feeds a SHA-256 in the manifest. Sorting is by UTF-16 code unit with an explicit
comparator on the raw string, never `localeCompare`. JSON written by the pipeline uses
`JSON.stringify(value, null, 2)` with keys emitted in a fixed order defined by the writer, and
ends with exactly one `\n`. Rule text files use LF endings, no BOM, and end with one `\n`.

**The only clock** is `issuedAt`, set once by the pack stage from `SOURCE_DATE_EPOCH` when it
is set and otherwise from the run's start time. No other stage reads the clock, so re-running
the pipeline on unchanged inputs reproduces every bucket byte for byte.

**Logging.** Stages log to stderr as one JSON object per line:
`{"stage","event","level", ...fields}`. stdout carries only a stage's machine-readable summary.
Never log a rule's full text at `info`; never log anything read from the environment.

**Exit codes.** Identical across the Node CLI and both Swift tools.

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected internal error (bug); stack trace on stderr |
| 2 | usage error: bad arguments, missing input file |
| 3 | budget or policy violation: bucket over cap, required list missing, stale cache |
| 4 | network failure with no usable cache |
| 5 | integrity failure: hash mismatch, signature invalid, verify step failed |

Any non-zero exit from any stage aborts the run. The publish job never starts.

**Rule identity.** A rule is one normalised line of filter text. Two rules are identical when
their normalised text is byte-identical (section 7.3). Rule identity is what the dedupe, the
badfilter pass, the bucket hash and the reports all key on.

---

## 4. The stage runner and the local dry run

`src/cli.mjs` is the only entry point. Every stage is also a command, so any stage can be run
alone against the tree left by the previous one.

```
node src/cli.mjs fetch        [--offline] [--only <listId,...>] [--force]
node src/cli.mjs preprocess   [--only <listId,...>]
node src/cli.mjs trustgate
node src/cli.mjs translate
node src/cli.mjs bucket       [--plan]
node src/cli.mjs active
node src/cli.mjs report       [--baseline <dir with yesterday's reports>]
node src/cli.mjs pack         [--version <int>] [--flavours ios17,ios26]
                              [--splice-active] [--prepare-payloads]
                              [--previous <manifest>] [--mirrors <url,...>]
node src/cli.mjs sign         --manifest build/dist/manifest.json [--sig <path>]
node src/cli.mjs verify       --manifest <path> --sig <path> [--key <base64>]
                              [--dir <payload dir>] [--require-complete]
                              [--skip-age] [--skip-hashes]
node src/cli.mjs build        [--offline] [--only <listId,...>]
```

Global flags: `--build-dir <path>` (default `build`), `--config-dir <path>` (default `config`),
`--lists <path>` (default `lists.json`), `--json` (summary to stdout), `--quiet`.

`build` forwards `--only` to every stage it runs, which is how the workflow's `lists`
dispatch input debugs one list end to end. `--version` on `pack` only raises the floor: the
version is still `max(previous + 1, YYYYMMDD00)`, never less.

`pack`, `sign` and `verify` depend on `node:` built-ins alone and parse their own kebab-case
flags, so they also run as plain modules (`node src/stages/pack.mjs --prepare-payloads`). The
CLI passes them the flags verbatim; both spellings behave identically, and CI uses the CLI form
so every stage reports through one exit-code table.

**Dry run.** `npm run dry-run` executes `build --offline` against `test/fixtures/lists/`,
producing a complete `build/` tree, reports and bucket inputs, on Windows, with no network and
no macOS. It is the command a contributor runs before opening a pull request, and it must
finish in under 60 seconds on the fixture set. `npm run dry-run:live` does the same against the
real lists (network, several minutes) and is what CI's `prepare` job runs.

The two macOS stages are represented in the dry run by `--plan` output only: `bucket --plan`
prints the projected converted-rule count per bucket from the previous run's
`build/validate/<flavour>/report.json` when one is present, so a Windows contributor can still
see whether a change is heading for a budget breach.

---

## 5. `lists.json`

The list set from DESIGN section 3.2. One file, one array, no comments; every field below is
required unless marked optional.

```json
{
  "schemaVersion": 1,
  "lists": [
    {
      "id": "adguard.base",
      "title": "AdGuard Base filter",
      "url": "https://filters.adtidy.org/ios/filters/2.txt",
      "mirrors": ["https://filters.adtidy.org/extension/safari/filters/2.txt"],
      "format": "adblock",
      "family": "net.ads",
      "trust": "trusted",
      "default": true,
      "required": true,
      "license": "GPL-3.0-only",
      "licenseUrl": "https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE",
      "homepage": "https://adguard.com/kb/general/ad-filtering/adguard-filters/",
      "attribution": "AdGuard Base filter (c) AdGuard Software Ltd.",
      "notes": "Includes EasyList; never add EasyList separately.",
      "role": "rules"
    }
  ]
}
```

- `id` — stable, `[a-z0-9.-]+`, never reused for a different source. It names every derived
  file and every report, and it is what the app shows in the filter picker.
- `format` — `"adblock"` or `"hosts"`. Hosts files are rewritten in preprocess (section 7.4).
- `family` — the default network family for this list: `net.ads`, `net.privacy` or
  `net.security`. Cosmetic rules from any list are routed by genericness to `cos.generic` or
  `cos.specific` (section 10.2), not by this field.
- `trust` — `"trusted"` or `"untrusted"`; drives the gate in section 8. `trusted` is reserved
  for uAssets, AdGuard official filters and the Janus site-fix list, exactly as DESIGN 3.2
  requires. Nothing else may be marked trusted.
- `default` — on by default in the app. `required` — a fetch failure fails the whole run.
- `role` (optional, default `"rules"`) says what the list is consumed for when it is not a
  plain rule source:
  - `"removeparam"` — consumed only by the LinkCleaner extractor and contributing no content
    rules (`privacy-removeparam.txt`, DESIGN 3.2 "LinkCleaner only").
  - `"popup-index"` — consumed only by the popup-domain index builder.
  - `"sitefix"` — the Janus list, read from `config/sitefix.txt` instead of the network.

**Default-on set** (DESIGN 3.2): AdGuard Base `ios/filters/2.txt`; AdGuard Mobile Ads `11.txt`;
uAssets `filters`, `quick-fixes`, `unbreak`, `privacy`, `badware`, `annoyances-cookies`,
`annoyances-others`; EasyPrivacy; Peter Lowe (hosts format); URLhaus
`urlhaus-filter-ag-online.txt`; AdGuard Popups `19.txt`, Cookie Notices `18.txt`, Mobile App
Banners `20.txt`, Other Annoyances `21.txt`; EasyList Notifications; `privacy-removeparam.txt`
(role `removeparam`); the Janus site-fix list (role `sitefix`); the popup-domain index (role
`popup-index`, built from the EasyList popup lists plus every `$popup` rule in the whole set).

**Opt-in set** (`"default": false`, `"required": false`): AdGuard Social `4.txt`, EasyList
Social, AdGuard Widgets `22.txt`, EasyList Newsletters, EasyList Chat, AdGuard Tracking
Protection `ios/filters/3.txt`.

Opt-in lists are fetched, converted and published like any other, in their own buckets; the app
enables them per the owner's settings. Tracking Protection's bucket count is sized from
**converter output**, never from source line count (DESIGN 1.3): the iOS flavour is about 105k
lines, and the number that decides its `B` comes from `build/validate/<flavour>/report.json`.

**Licences.** `license`, `licenseUrl` and `attribution` are mandatory and are what generates
`NOTICE`. `npm run notice:check` regenerates NOTICE from `lists.json` and fails when the
committed file differs, so a list cannot be added without its attribution.

---

## 6. Stage: fetch

**In:** `lists.json`, `build/cache/`. **Out:** `build/raw/<listId>.txt`, refreshed
`build/cache/<listId>.{body,meta.json}`, stdout summary.

Every list with `role != "sitefix"` is fetched. `sitefix` is copied from `config/sitefix.txt`
into `build/raw/janus.sitefix.txt` unchanged.

**Algorithm.**

1. Read `build/cache/<listId>.meta.json` when present:
   `{"url","etag","lastModified","sha256","fetchedAt","status"}`.
2. Request `url` with `node:fetch`, `redirect: "follow"` (max 5 hops, HTTPS only; an
   http: hop is a hard failure), headers `accept: text/plain`,
   `user-agent: janus-filters/1 (+https://github.com/mioutic/janus-filters)`, plus
   `if-none-match` / `if-modified-since` from the cache meta. 30 s connect, 120 s total.
3. `304` — reuse `build/cache/<listId>.body` and record `fromCache: true`.
4. `200` — accept the body, subject to the sanity checks below.
5. Any other status, a network error, or a failed sanity check — retry the same URL with
   exponential backoff and full jitter: 4 attempts, base 1 s, cap 20 s. Then try each entry of
   `mirrors` in order with the same retry policy (conditional headers are not sent to a mirror,
   because ETags are per-origin).
6. All URLs exhausted — fall back to the cached body if there is one. Otherwise the list fails.

**Sanity checks on a 200 body** (any failure makes the response a retryable error):
non-empty; at most 64 MiB; decodes as UTF-8 (invalid sequences are a failure, not a silent
replacement); contains at least one line that parses as a rule; and, when a cached body exists,
the new body has at least 50 % of the cached body's rule count. That last check is what stops a
mirror that answers 200 with an error page or a truncated file from wiping out a list.

**Failure policy.** A list with `"required": true` that ends with no body fails the run with
exit 4. A list with `"required": false` and no body is skipped, and the skip is recorded in the
stage summary and in `reports/budget.json`; because the published set must be complete, the
pack stage (section 15) refuses to build a manifest when any **default-on** list was skipped.
A non-default opt-in list may be skipped without failing the run, and its buckets are then
absent from the manifest for that day.

**Staleness.** A body served from cache whose `fetchedAt` is more than 7 days old logs a
warning; more than 14 days old fails the run with exit 3. The 14-day number is deliberately the
same as the app's manifest age limit (DESIGN 3.4): filters that the app would refuse to trust
must never be built into a bundle in the first place.

**Normalisation on write.** CRLF and CR become LF, a leading UTF-8 BOM is removed, and the file
ends with exactly one LF. Nothing else is touched: `build/raw/` is evidence, and the dropped
report quotes it by line number.

**Cache in CI.** `build/cache/` is restored and saved with `actions/cache` (section 17.2). A
cold cache is normal and harmless: it only means every list is fetched in full.

---

## 7. Stage: preprocess

**In:** `build/raw/*.txt`, `config/env.json`. **Out:** `build/prepared/<listId>.txt`, plus per
list `build/prepared/<listId>.stats.json`.

This stage resolves everything that makes a list file conditional or indirect, then normalises
what remains, so that from here on the pipeline handles one flat, comparable rule stream.

### 7.1 `!#include` expansion

`!#include <path>` is expanded in place, depth-first.

- The path is resolved against the **including file's URL**. Only a same-origin result is
  expanded: the resolved URL must have scheme `https:` and the identical host and port as the
  list's own `url`. A cross-origin include is dropped, counted as
  `include.cross_origin` and reported. This is a security boundary, not an optimisation: an
  include is remote code for the blocker, and a list must not be able to pull rules from a host
  its maintainers do not control.
- `..` segments that escape the list's directory are rejected the same way.
- Maximum depth 5, maximum 64 includes per list, and a cycle (a URL already on the include
  stack) is dropped with `include.cycle`.
- Included bodies are fetched with the same policy as section 6 and cached under
  `build/cache/include/<sha256 of url>.body`.
- The directive line is replaced by the included content, which is itself preprocessed. The
  stats file records `{url, lines, depth}` per expansion.

### 7.2 `!#if` evaluation

`config/env.json` holds the environment exactly as DESIGN 3.3 fixes it. True:
`env_safari`, `env_mobile`, `ext_ublock`. False: `env_mv3`, `cap_html_filtering`, `adguard`.
Every other identifier is **false**, and an unknown identifier is counted as
`if.unknown_identifier` so that a new upstream capability token shows up in the report the day
it appears instead of silently disabling a block of rules.

Grammar: `!#if <expr>`, `!#else`, `!#endif`, nesting to depth 16. `<expr>` supports `!`, `&&`,
`||` and parentheses over identifiers, with C precedence (`!` > `&&` > `||`). A malformed
expression makes the whole `!#if` block evaluate to false and is counted as `if.parse_error`.
An unterminated `!#if` at end of file is an error for that list (exit 3): a truncated download
that passed the size check must not silently produce half a list.

The AdGuard directives `!#safari_cb_affinity(...)` and `!#safari_cb_affinity` (close) are
**consumed, not forwarded**: the rules inside the block are kept, the directive lines are
removed, and the count goes to `stats.affinityBlocks`. Affinity is AdGuard's way of pinning
rules to one of its six Safari content blockers; Janus assigns buckets itself (section 10), so
forwarding the directive to the converter would let an upstream list override the Janus bucket
layout. Any affinity group observed is listed in the report so a deliberate upstream split can
be reviewed.

### 7.3 Normalisation

Applied to every surviving line, in this order:

1. Trim leading and trailing whitespace (including U+00A0 and other Unicode spaces).
2. Drop empty lines and comments. A line is a comment when it starts with `!`, or with `#`
   followed by whitespace or end of line, or with `[` and ends with `]` (the
   `[Adblock Plus 2.0]` header). `##`, `#@#`, `#?#`, `#$#`, `#%#`, `#@%#` and their variants
   are **cosmetic or scriptlet rules, not comments**.
3. Reject any line containing a control character below U+0020 other than none, or U+FEFF, and
   count it as `normalise.control_char`.
4. Lower-case the domain portion of network rules (`||EXAMPLE.com^` -> `||example.com^`) and of
   `if-domain`-style modifier values and cosmetic rule domain prefixes. Paths, query strings,
   regex bodies and CSS selectors keep their case.
5. Convert IDN hostnames to punycode with `node:url`'s `domainToASCII` (UTS-46). A hostname
   that fails to convert is dropped with `normalise.bad_idn`.
6. Sort the modifier list of a network rule into a canonical order (alphabetical by modifier
   name, values untouched) and collapse duplicate modifiers. Canonical modifier order is what
   makes dedupe and `$badfilter` matching reliable across lists that write the same rule with
   the options in a different order.
7. Collapse internal runs of whitespace in cosmetic selectors only where they are outside
   quotes and brackets; if that cannot be determined cheaply, leave the selector alone. A
   mangled selector is worse than a duplicate.

### 7.4 Hosts format

For `"format": "hosts"`, each line is `<ip> <host> [<host> ...]` with optional `#` comment.
Only `0.0.0.0`, `127.0.0.1` and `::1` are accepted as the sink address; any other address makes
the line a no-op that is counted as `hosts.non_sink`. Each host becomes `||<host>^`.
`localhost`, `localhost.localdomain`, `broadcasthost`, `local` and any host without a dot are
skipped. Hosts are punycoded as in section 7.3.

### 7.5 `$badfilter`

`$badfilter` is applied here, across the merged set, because the converter does not promise to
honour it and because a badfilter in `unbreak.txt` must be able to disable a rule that came
from AdGuard Base.

Algorithm: collect every rule whose modifier list contains `badfilter`; for each, compute its
**neutralised form** by removing the `badfilter` modifier and re-canonicalising (section 7.3
step 6); remove from the set every rule whose normalised text equals that neutralised form;
then drop the badfilter rule itself. `$badfilter` rules that match nothing are kept in the
report as `badfilter.no_match` — an unmatched badfilter usually means an upstream rule changed
and the exception is now dead weight.

### 7.6 Dedupe and merge

`build/merged.txt` is the concatenation of the prepared lists **in `lists.json` order**, with
exact-duplicate normalised rules removed, first occurrence winning. `merged.provenance.jsonl`
records `{"rule","listId","line"}` for each surviving rule and is what the dropped-rule report
uses to attribute a loss to a list. Order is preserved because filter semantics inside a
compiled list are order-dependent (section 10.3): dedupe may never reorder.

Counts recorded per list: `in`, `comments`, `kept`, `duplicateOfEarlierList`, plus every drop
category above.

---

## 8. Stage: trust gate

**In:** `build/prepared/*.txt`, `config/trust.json`, the `trust` field of each list.
**Out:** `build/trusted/<listId>.txt`, `build/trusted/<listId>.gate.json`.

DESIGN 3.2 is the rule: *`trusted-*` scriptlets and `#%#` JavaScript are kept only from
uAssets, AdGuard official lists and the Janus list; CI strips them elsewhere.* The gate exists
because a list-supplied `#%#` body is remote code that the app will run on matching sites
(DESIGN 3.5), and the only thing standing behind it is the upstream maintainer's judgement plus
this repository's signature.

**Trusted lists** pass through untouched.

**Untrusted lists** lose, and only lose:

| Pattern | Why |
|---|---|
| `#%#` and `#@%#` rules whose body is **not** `//scriptlet(...)` | raw JavaScript injection |
| `##+js(...)` / `#@#+js(...)` (uBO) and `#%#//scriptlet(...)` whose scriptlet name begins with `trusted-` | trusted scriptlets can set cookies, patch storage, fetch |
| `$jsinject`, `$stealth`, `$extension`, `$app`, `$hls`, `$jsonprune`, `$xmlprune`, `$replace`, `$urltransform`, `$removeheader` | either remote code or modifiers the converter drops anyway; stripping here keeps the dropped report meaningful |
| `!#include` that survived preprocess (there are none by construction) | defence in depth |

Everything else from an untrusted list survives: network rules, cosmetic rules (including
procedural `#?#` and `#$?#`), and ordinary non-`trusted-` scriptlets. That is DESIGN's line, and
it is deliberately less strict than "network and cosmetic only": ordinary AdGuard scriptlet
bodies ship **inside the app** (DESIGN 3.5), so an untrusted list can only choose which bundled
function runs with which arguments, not supply code.

`config/trust.json` carries the switch for the stricter reading:

```json
{
  "mode": "design",
  "strippedModifiers": ["jsinject", "stealth", "extension", "app", "hls",
                        "jsonprune", "xmlprune", "replace", "urltransform", "removeheader"],
  "trustedScriptletPrefix": "trusted-"
}
```

`"mode": "strict"` additionally drops **all** scriptlet invocations from untrusted lists,
reducing them to network and cosmetic rules. The default stays `"design"`. Changing the mode is
a reviewed change with a visible diff in the dropped report, not a flag someone flips in CI.

Every stripped rule is written to `build/trusted/<listId>.gate.json` as
`{"rule","line","reason"}` and flows into `reports/dropped/<listId>.json` under the
`trust-gate` cause, so a list losing a scriptlet is visible rather than silently weaker.

---

## 9. Stage: translate

**In:** `build/trusted/*.txt`, `config/ubo-alias.json`, `config/surrogates.json`.
**Out:** `build/xlated/<listId>.txt`, `build/auxdata/{linkcleaner,sitefix,popup-index}.json`,
`build/xlated/<listId>.xlate.json` (per-rule record of every transform).

DESIGN 3.3 step 2: *translate losses before converting.* Every transform here exists because
the converter would otherwise discard the rule.

### 9.1 The uBO -> AdGuard scriptlet alias map

`config/ubo-alias.json` is **generated and committed**, never hand-edited in place.
`scripts/gen-alias.mjs` builds it from the pinned `@adguard/scriptlets` package (version in
`VERSIONS.json`, 2.5.1 for M2a) using its compatibility table plus the scriptlet and redirect
name lists in `dist/`, and writes the file deterministically. CI runs
`node scripts/gen-alias.mjs --check`, which regenerates into a temporary directory and fails
when the result differs from the committed file. That keeps the map reviewable in a diff while
making it impossible for it to drift from the pinned package.

Schema:

```json
{
  "schemaVersion": 1,
  "generatedFrom": { "package": "@adguard/scriptlets", "version": "2.5.1" },
  "scriptlets": {
    "rmnt.js":  { "adguard": "remove-node-text", "args": "identity" },
    "nowoif.js": { "adguard": "prevent-window-open", "args": "identity" },
    "aopr.js":  { "adguard": "abort-on-property-read", "args": "identity" },
    "set-cookie.js": { "adguard": "trusted-set-cookie", "args": "identity", "trusted": true }
  },
  "redirects": {
    "google-ima.js": { "adguard": "google-ima3" },
    "amazon_apstag.js": { "adguard": "amazon-apstag" }
  },
  "adguardNames": ["abort-on-property-read", "remove-node-text", "set-constant"],
  "unmapped": ["hd-main.js", "outbrain-widget.js", "doubleclick_instream_ad_status.js"]
}
```

- `args: "identity"` passes arguments through. Any other value names a transform implemented in
  `src/lib/alias-transforms.mjs` and unit-tested with fixtures; a transform is added only with
  a test that pins the before and after text of a real rule.
- An entry with `"trusted": true` maps a uBO name onto an AdGuard `trusted-*` scriptlet. Such a
  mapping is applied **only for trusted lists**; for an untrusted list the rule is dropped with
  cause `alias.trusted-target`. Otherwise the alias map would be a way around section 8.
- Names in `unmapped` are dropped with cause `scriptlet.no-alias` and are the input to the
  Ghostery diff triage in M2c.
- `adguardNames` is the package's own canonical scriptlet-name inventory. uAssets carries a few
  thousand rules that use uBO's `##+js(...)` syntax while naming an AdGuard scriptlet directly;
  without this list they look like unmapped uBO names and the converter discards them. With it,
  translate re-syntaxes them to `#%#//scriptlet(...)` and changes nothing else. A name in
  `adguardNames` beginning `trusted-` falls under the same trust rule as a `trusted` alias entry.
- Note on the pinned package: 2.5.1's compatibility table maps `set-cookie.js` to the
  non-trusted `set-cookie`, and no uBO alias in it points at a `trusted-*` scriptlet. The
  `"trusted": true` entry above is illustrative; the `alias.trusted-target` refusal is pinned by
  a unit test with a synthetic map rather than by a real alias.

Application: for every `##+js(name, args...)` or `#%#//scriptlet('name', ...)` rule, look up
`name` (with and without the `.js` suffix); on a hit, rewrite to AdGuard syntax
`#%#//scriptlet('<adguard-name>', ...)` with the transformed arguments; on a miss, leave the
rule untouched and record the miss (the converter will drop it and the dropped report will
carry it).

### 9.2 `$csp` to site fixes

The converter does not emit `$csp` (verified against SafariConverterLib 4.3.0's README). Each
`$csp` rule on a **specific** domain becomes an entry in `build/auxdata/sitefix.json`:

```json
{
  "schemaVersion": 1,
  "entries": [
    { "domains": ["example.com"], "csp": "script-src 'self'", "source": "ubo.filters#1234" }
  ]
}
```

DESIGN 3.3 step 2 gates delivery: the app only injects a document-start `<meta http-equiv>` CSP
if the M3 spike proves WebKit honours it; until then the app uses the scriptlet equivalent where
one exists, and otherwise the entry is inert. The pipeline publishes the payload either way;
choosing to act on it is the app's decision, recorded in `docs/CONTRACT.md` section 9.
Generic `$csp` rules (no domain) are dropped with cause `csp.generic`.

### 9.3 `$removeparam` to LinkCleaner

`$removeparam` is **never** emitted as content rules (DESIGN 3.3 step 6). Every `$removeparam`
rule, from any list and above all from `privacy-removeparam.txt`, is distilled into
`build/auxdata/linkcleaner.json`:

```json
{
  "schemaVersion": 1,
  "global": ["utm_source", "utm_medium", "fbclid", "gclid"],
  "byDomain": { "amazon.com": ["ref", "pd_rd_r"] },
  "regex": [{ "domains": ["example.com"], "pattern": "^ad_[0-9]+$" }]
}
```

Rules with an inverted (`~`) parameter set, or with a value-matching form the app cannot
express, are dropped with cause `removeparam.unsupported`. The app applies this only to
top-level navigations (DESIGN 3.8, "top-level LinkCleaner").

### 9.4 The popup-domain index

`build/auxdata/popup-index.json` holds every domain carrying a `$popup` rule anywhere in the set,
plus the domains from the EasyList popup lists, sorted, deduped, punycode:

```json
{ "schemaVersion": 1, "domains": ["example.com", "popads.net"] }
```

`$popup` rules are **also** left in the stream: the converter turns them into document blocking,
which is the correct content-rule behaviour. The index is what FLASH SUPPRESSANT loads in M2b
for its trust model (DESIGN 4.2), which is why it ships as its own payload rather than as rules.

### 9.5 Surrogate annotation

Translate does not build `janus.active` (that is section 11), but it does mark the rules that
section 11 will need: for every rule whose pattern matches an entry in `config/surrogates.json`,
and for every `@@` exception whose pattern overlaps one, it writes a record into
`build/xlated/surrogate-candidates.jsonl` as
`{"rule","kind":"block"|"exception","surrogate":"<id>","listId"}`. Keeping the scan here means
section 11 works from one small file instead of re-scanning the whole merged set.

---

## 10. Stage: bucket

**In:** `build/merged.txt` (rebuilt from `build/xlated/`), `config/buckets.json`,
`build/validate/<flavour>/report.json` from the previous run when present.
**Out:** `build/buckets/<bucketId>.txt`, `build/buckets/index.json`, `build/reports/budget.json`.

A single `WKContentRuleList` accepts at most 150,000 rules and fails **as a whole** on one
unsupported regex ([V-ae]); the NFA has its own 75,000-node ceiling. So the set is split. The
split has to be *stable*, or every daily update would rewrite every bucket and the app would
recompile everything — the opposite of DESIGN 3.4's "compile only missing ones".

### 10.1 Bucket identifiers

`janus.<family>.<NN>` with `NN` zero-padded to two digits, plus `janus.<family>.gen<NN>` for the
host-less buckets of that family, plus the single `janus.active`. Examples:
`janus.net.ads.03`, `janus.cos.specific.11`, `janus.net.security.gen00`, `janus.active`.

The identifier the **app** hands to `WKContentRuleListStore` is not this string: it is
`<bucketId>.<sha8>` where `sha8` is the first 8 hex characters of the SHA-256 of the
uncompressed JSON (`docs/CONTRACT.md` section 8). The bucket id is the stable name; the suffix
makes a changed bucket a different compiled list, which is what lets the app keep the old one
until the new one compiles. Because DESIGN 3.7 allowlists by prefix
(`exceptions:[janus.net.security.*]`), the family must stay a literal prefix of the identifier:
never rename a family, never move the sha8 anywhere but the end.

### 10.2 Families and routing

Five families (DESIGN 3.3 step 5) plus the surrogate list:

| Family | Contents |
|---|---|
| `net.ads` | network rules from lists whose `family` is `net.ads` (AdGuard Base, Mobile Ads, uAssets ads/quick-fixes/unbreak, the annoyance lists, EasyList Notifications) |
| `net.privacy` | network rules from EasyPrivacy, uAssets privacy, Peter Lowe, Tracking Protection when enabled |
| `net.security` | network rules from URLhaus and uAssets badware |
| `cos.generic` | cosmetic rules with no domain restriction, from any list |
| `cos.specific` | cosmetic rules with a domain restriction, from any list |
| `janus.active` | the surrogate redirect list (section 11); not hashed, never split |

Routing a rule:

1. Cosmetic rule (`##`, `#@#`, `#?#`, `#$#`, `#$?#`, `#@$#`, ...) — `cos.specific` when it has a
   domain prefix, `cos.generic` otherwise. Its bucket key is its **first** domain (lowercased,
   punycode, reduced to eTLD+1); generic cosmetics have no key.
2. Network rule — the family of its source list. Its bucket key is the eTLD+1 of the rule's own
   host when the pattern is host-anchored (`||host^`, `://host/`, `|https://host/`), else the
   eTLD+1 of the **first** value of `$domain=` / `if-domain`, else no key.
3. A rule that is both (an `$elemhide`-style modifier, `$specifichide`, `$generichide`) follows
   its network family.

`net.security` is kept separate for one reason: DESIGN 3.7 keeps it enabled even when a site is
allowlisted. Malware blocking is not something the owner turns off by tapping "trust this site".

### 10.3 The hash and the split

```
key    = eTLD+1 of the rule's host or first if-domain, lowercased, punycode; "" when host-less
bucket = key === ""  ?  "gen" + pad2(fnv1a32(normalisedRuleText) % G[family])
                     :  pad2(fnv1a32(key) % B[family])
```

`fnv1a32` is the 32-bit FNV-1a of the **UTF-8 bytes** of the key, offset basis `0x811c9dc5`,
prime `0x01000193`, accumulated with `Math.imul` and returned `>>> 0`. It is implemented once in
`src/lib/hash.mjs` and pinned by a unit test with known vectors, because changing it silently
would reshuffle every bucket and force a full re-download.

Hashing on eTLD+1 rather than on the rule text is what makes the scoped exception replication in
section 10.5 sound: every rule that concerns `example.com` — the block, its exception, its
cosmetic rules — lands in the same bucket of its family, so an exception can neutralise its
block without being copied everywhere.

`B` and `G` per family live in `config/buckets.json`:

```json
{
  "schemaVersion": 1,
  "families": {
    "net.ads":      { "B": 4, "G": 1, "softCap": 80000, "hardCap": 110000 },
    "net.privacy":  { "B": 2, "G": 1, "softCap": 80000, "hardCap": 110000 },
    "net.security": { "B": 1, "G": 1, "softCap": 80000, "hardCap": 110000 },
    "cos.generic":  { "B": 0, "G": 2, "softCap": 80000, "hardCap": 110000 },
    "cos.specific": { "B": 3, "G": 0, "softCap": 80000, "hardCap": 110000 }
  },
  "webkitLimit": 150000,
  "optIn": { "adguard.tracking": { "family": "net.privacy", "B": 2 } }
}
```

The values above are the M2a starting point, sized from the line counts in DESIGN's research
(about 175k network, 116k cosmetic). **They are provisional until the first CI run reports real
converted counts**, and they are then set from `build/validate/<flavour>/report.json` — DESIGN
1.3 is explicit that bucket counts come from converter output, not source lines.

**Raising `B` is a planned, announced event** (DESIGN 3.3 step 5): it re-keys every rule in the
family and therefore re-downloads it. `B` may only change in a commit that also bumps
`manifest.layoutVersion` (section 15.2), which tells the app to expect a full-family refresh
rather than a delta. `B` is never changed automatically by the pipeline.

### 10.4 Ordering inside a bucket

Order is semantics, not style. WebKit evaluates a list in order and later `ignore-previous-rules`
wins, so DESIGN 3.3 step 5 fixes the order and the bucket stage emits exactly it:

```
1. blocks                                  (plain block rules)
2. non-important exceptions                (@@ without $important)
3. important blocks                        ($important)
4. important exceptions and $document allowlists  ($important @@, $document, $urlblock)
5. surrogate ignore-previous-rules tail    (section 11.3, network families only)
```

Within each of those five sections, rules keep **merged order** (list order, then original line
order). Stable order plus stable keys is what produces an unchanged SHA-256 for an unchanged
bucket, which is the M2a acceptance criterion "two consecutive daily manifests share the sha256
of every bucket whose rules did not change".

**This order governs the bucket's input bytes, not the converted output.** SafariConverterLib's
`SafariCbBuilder.createEntries` re-groups every entry it emits into its own canonical sequence —
`cssBlockingWide`, `cssBlockingGenericDomainSensitive`, `cssBlockingGenericHideExceptions`,
`cssBlockingDomainSensitive`, `cssElemhideExceptions`, `urlBlocking`, `otherExceptions`,
`important`, `importantExceptions`, `documentExceptions` — so the input order above is discarded
by the converter. Two things follow, and both are load-bearing:

- The five sections exist to keep a bucket's **input** bytes stable from one run to the next. That
  is what the delta accounting in section 8.3 of the contract depends on.
- Where output order actually matters, it has to be bought in the converter's own vocabulary: an
  exception that must beat an `$important` block in the same bucket is emitted **as** an
  `$important` allowlist so it lands in `importantExceptions` (section 11.3), and the only output
  ordering the pipeline controls directly is the `janus.active` splice of section 15.1.

### 10.5 Scoped exception replication

An exception only works inside its own list ([V-ae], DESIGN 3.8). Copying every exception into
every bucket would be correct and enormous; copying none would break sites. DESIGN 3.3 step 5
fixes the middle path, and the stage implements it literally:

- **Host-scoped exception** (has a host in its pattern or a single-domain `$domain=`): copied
  into the bucket its host hashes to, **and** into every `gen*` bucket of the same family.
  Rationale: the rule it must neutralise is either in its host's bucket (host-keyed) or in a
  generic bucket (host-less), and nowhere else.
- **Truly generic exception** (no host, no domain restriction): copied into **every** bucket of
  the family, generic ones included.
- **Multi-domain exception** (`$domain=a.com|b.com`): treated as a host-scoped exception once
  per domain, so it lands in each of those domains' buckets plus the generic buckets, and is
  written once per bucket with its full original text.
- `$document` / `$urlblock` allowlists are replicated like truly generic exceptions within their
  family, because a page-level allowlist must beat anything in that family.
- Cosmetic exceptions (`#@#`, `#@?#`) replicate by the same rules inside `cos.*`.
- A **network** exception whose modifiers include `$elemhide`, `$generichide`, `$specifichide`
  (or their `ghide` / `shide` spellings) or `$content` has cosmetic scope: the rules it must
  neutralise are cosmetic, and `ignore-previous-rules` only acts inside its own list. It is
  therefore replicated into the `cos.*` groups, by the cosmetic rules above, and **not** into the
  network family its list belongs to, where it would be inert.

Replication happens **after** routing and **before** ordering, and replicated copies are byte
-identical to the original rule text. `build/buckets/index.json` records, per bucket,
`originalCount` and `replicatedCount` so the cost is visible.

### 10.6 Budgets and the plan mode

After emitting, the stage compares each bucket against `softCap` (80,000) and `hardCap`
(110,000) **converted** rule counts. On the first run of a day there is no converted count yet,
so it uses the previous run's ratio of converted to input rules per family (default 1.0) as the
estimate, and writes both estimate and basis into `build/reports/budget.json`.

- Estimate above `softCap`: warning, and the report names the family and the suggested new `B`.
- Estimate above `hardCap`: exit 3. The run stops before burning macOS minutes on a set that
  cannot ship.
- After the validate stage, real counts replace estimates and the same thresholds are applied
  again, this time fatally in both cases if `hardCap` is exceeded.

`bucket --plan` runs the estimator only and prints a table; it writes nothing except
`build/reports/budget.json`. It is the Windows-side early warning.

---

## 11. Stage: active (`janus.active`)

**In:** `config/surrogates.json`, `build/xlated/surrogate-candidates.jsonl`, the bucket outputs.
**Out:** `build/buckets/janus.active.txt`, the ignore tails appended to every network bucket,
`build/reports/surrogates.json`.

This is the highest-risk part of the pipeline and the one place where DESIGN overrides the
research. WebKit's `ContentExtensionsBackend` drops a redirect once a block has been recorded and
a block once a redirect has been recorded, and it visits lists in **hash order**, not attach
order ([V-ae]). A surrogate that competes with a block rule in another list therefore wins or
loses unpredictably, and the outcome can flip on any bundle update because the identifiers carry
a content hash.

### 11.1 Order inside `janus.active`

DESIGN 3.3 step 6 adopts [V-vp]'s ordering and **rejects** [V-ae]'s suggestion of an
`ignore-previous-rules` before each redirect:

```
1. every surrogate redirect rule, in config order
2. every matching fallback block rule, in the same order
   (no ignore-previous-rules between the two sections)
```

Within one list, WebKit's block-action de-duplication already yields *redirect when the pattern
is granted by the active action patterns, block when it is not*, so the extra ignore rules add
nothing and would only create a third way for the order to matter.

### 11.2 The surrogate set

`config/surrogates.json`, one entry per target from DESIGN 3.6:

```json
{
  "schemaVersion": 1,
  "redirectSource": { "package": "@adguard/scriptlets", "version": "2.5.1",
                      "dir": "dist/redirect-files" },
  "surrogates": [
    {
      "id": "googletagservices-gpt",
      "file": "googletagservices-gpt.js",
      "mime": "text/javascript",
      "patterns": ["https?://securepubads\\.g\\.doubleclick\\.net/tag/js/gpt\\.js"],
      "resourceTypes": ["script"]
    },
    {
      "id": "noopmp4-1s",
      "file": "noopmp4-1s.mp4",
      "mime": "video/mp4",
      "patterns": ["..."],
      "resourceTypes": ["media"]
    }
  ]
}
```

Targets for M2a: `google-ima3`, `googletagservices-gpt`, `googlesyndication-adsbygoogle`,
`amazon-apstag`, `prebid`, `noopvast-4.0`, `noopvmap-1.0`, `noopmp4-1s`. The redirect action is

```json
{ "trigger": { "url-filter": "<pattern>", "resource-type": ["script"] },
  "action": { "type": "redirect",
              "redirect": { "url": "data:text/javascript;base64,<base64 of the file>" } } }
```

`action.redirect` is an **object**, not a flat `action.url`: WebKit's `RedirectAction::parse`
requires the nested dictionary and answers `JSONRedirectMissing` without it, which fails the whole
`janus.active` list. An `--offline` run writes `action.redirect.dataUrlFrom` instead, naming the
file whose bytes the networked run must embed.

`resource-type` never contains `document`, `top-document`, `child-document` or `image`: a
main-frame redirect to `data:` is re-issued as a fresh navigation and an image surrogate buys
nothing. The base64 bodies come from the pinned `@adguard/scriptlets` tarball; the file's sha256
is recorded in `VERSIONS.json` and re-checked at build time, because these bytes execute in the
page.

`janus.active` is emitted as filter text like every other bucket only where SafariConverterLib
can express it; the redirect rules themselves are **written directly as content-rule JSON** by
the pack stage, since the converter does not support `$redirect` at all. The file
`build/buckets/janus.active.txt` therefore holds only the fallback block rules, and
`build/auxdata/active-redirects.json` holds the redirect actions; JanusConvert converts the first,
and `pack` splices the second in front of it (section 15.1). The splice is validated by
compiling the result like any other bucket (section 13).

### 11.3 The ignore tail in every other network bucket

Every network bucket other than `janus.active` ends with, per surrogate pattern:

```json
{ "trigger": { "url-filter": "<pattern>", "resource-type": ["script"] },
  "action": { "type": "ignore-previous-rules" } }
```

with the same `resource-type` set as the surrogate. That neutralises any block for that exact
pattern *inside that bucket*, so no other list can pre-empt the redirect regardless of hash
order. These tails are appended as section 5 of the bucket order (section 10.4) and are counted
in the budget.

The tail is written as filter text — `@@/<pattern>/$<types>,important` — and the `$important` is
not decoration. `SafariCbBuilder.createEntries` emits `otherExceptions` **before** `important` and
`importantExceptions` (section 10.4), so a plain `@@` tail would still lose to an `$important`
block for the same URL in that bucket; as an important allowlist it lands in
`importantExceptions`, which the converter emits last. That is what makes DESIGN 3.3 step 6's "no
other list pre-empts the redirect" true of the bytes the phone compiles.

### 11.4 Folded unbreak exceptions

Every `@@` rule whose pattern overlaps a surrogate pattern is folded **into** that surrogate's
redirect and fallback block as `unless-domain` / `unless-top-url`, so the real SDK loads on the
sites the unbreak lists say it must:

1. Collect exception candidates from `surrogate-candidates.jsonl`.
2. For an exception scoped to domains, add those domains to the surrogate's `unless-domain` on
   both the redirect rule and the fallback block rule.
3. For an exception scoped by `$domain` with a path or `~` form the trigger cannot express, do
   not fold: append it at the **end** of `janus.active`, after the fallback blocks, as an
   `ignore-previous-rules` rule (DESIGN 3.3 step 6).
4. `unless-domain` values are lowercased punycode eTLD+1 or exact host, deduped and sorted.

`build/reports/surrogates.json` records, per surrogate, the pattern, the folded domains, the
appended exceptions, and the count of ignore tails emitted. The app's surrogate JavaScript layer
(DESIGN 3.6a) consumes the same folded domain set, so a site that is unbroken here is also
skipped by the payload — one source of truth, published in `sitefix.json`.

---

## 12. Tool: `Tools/JanusConvert` (macOS only)

A SwiftPM executable that wraps SafariConverterLib **4.3.0 exact**. It runs only on
`macos-26` in CI; there is no Swift toolchain on the development machine, so it must compile on
the first CI run.

**Package.** `swift-tools-version:5.9`, `platforms: [.macOS(.v13)]`, one executable target
`JanusConvert`, dependencies: `https://github.com/AdguardTeam/SafariConverterLib` `.exact("4.3.0")`
(product `ContentBlockerConverter`, which vends both the `ContentBlockerConverter` and
`FilterEngine` modules) and `swift-argument-parser` `.exact("1.5.0")` — the same version
SafariConverterLib pins, so SwiftPM resolves one copy.

**Verified API** (read from the v4.3.0 tag, not from memory):

```swift
public func convertArray(
    rules: [String],
    safariVersion: SafariVersion = .safari13,
    advancedBlocking: Bool = false,
    maxJsonSizeBytes: Int? = nil,
    progress: Progress? = nil
) -> ConversionResult

public struct ConversionResult: CustomStringConvertible, Encodable {
    public let sourceRulesCount: Int
    public let sourceSafariCompatibleRulesCount: Int
    public let safariRulesCount: Int
    public let advancedRulesCount: Int
    public let discardedSafariRules: Int
    public let errorsCount: Int
    public let safariRulesJSON: String
    public let advancedRulesText: String?
}
```

Both defaults are wrong for Janus and **every argument is passed explicitly**: Safari 13 and
advanced blocking off would silently produce a weak, vocabulary-poor list.

**Flavour to `SafariVersion`.** `SafariVersion.init(_ version: Double)` maps
`version > 26 -> .latest(version)`, `16.4 <= version < 26 -> .safari16_4`, then a major switch
for 13/14/15/16/26 and `default -> .safari13`. Consequences that matter:

| Flavour | `--safari-version` | Resolved case | Vocabulary |
|---|---|---|---|
| `ios17` | `17` | `.safari16_4` | no `request-method`, no `unless-frame-url` |
| `ios26` | `26` | `.safari26` | `$method` via `request-method`, domain wildcards via `if-frame-url` |

Passing `17` is correct and intentional: it resolves to `.safari16_4`, the newest vocabulary
Safari 17 actually understands. Never pass a value below 16.4 for the `ios17` flavour — anything
in 11..16.3 falls into `default` and silently becomes Safari 13.

**CLI.**

```
JanusConvert convert
    --input <file>            one bucket's rule text (build/buckets/<bucketId>.txt)
    --bucket-id <id>          e.g. janus.net.ads.03
    --flavour <ios17|ios26>
    --out-json <file>         build/converted/<flavour>/<bucketId>.json
    --out-stats <file>        build/converted/<flavour>/<bucketId>.conv.json
    [--advanced <file>]       append advanced-rules text here (see below)
    [--max-json-bytes <int>]  default 0 = no limit
    [--strict]                exit 3 when the converter reports any rule error
JanusConvert engine
    --input <advanced.txt>
    --flavour <ios17|ios26>
    --out-dir <dir>           a container dir; the library writes <dir>/.webext/*
JanusConvert version         prints tool, SafariConverterLib and schema versions as JSON
```

`convert` calls `convertArray(rules:safariVersion:advancedBlocking:true,maxJsonSizeBytes:nil,progress:nil)`,
writes `safariRulesJSON` to `--out-json`, appends `advancedRulesText` to `--advanced` when that
flag is given, and writes `bucketId`, `flavour`, the source rule count and the `ConversionResult`
numbers to `--out-stats`: the six `Int` counters (`sourceRulesCount`,
`sourceSafariCompatibleRulesCount`, `safariRulesCount`, `advancedRulesCount`,
`discardedSafariRules`, `errorsCount`) plus `safariRulesBytes` and `advancedRulesBytes`, since
the struct's remaining two fields are the payloads themselves, not counters.

Advanced rules are accumulated across buckets in bucket-id order, but **not** into one file:
`FilterEngine` has no per-list switch, so a scriptlet that reaches the payload runs for everyone
who installs it. The target is therefore chosen per bucket, and `scripts/advanced-targets.mjs`
prints the mapping from `build/buckets/index.json` (`optInSlug`):

- every default-on bucket appends to `build/converted/<flavour>/advanced.txt`;
- every opt-in bucket appends to `build/converted/<flavour>/advanced.<optInSlug>.txt`.

`--advanced` **appends**, so CI truncates every target once per flavour before the bucket loop and
iterates the buckets under `LC_ALL=C`. After the loop each payload is passed through an
order-preserving line dedupe (first occurrence wins): an exception replicated into N buckets is
converted N times, and the duplicates would only make the payload and the on-device index bigger.
The app feeds `FilterEngine` the default payload plus the opt-in payloads whose list it has
enabled (CONTRACT 9.1).

`engine` builds the optional `FilterEngine` payload through
`WebExtension(containerURL:version:).buildFilterEngine(rules:)`, which writes
`.webext/{rules.txt, rules.bin, engine.bin, meta.bin}` plus a `lock` (and, on an upgrade, a
`migration`) file; the tool deletes those two afterwards so the directory holds exactly the four
files the engine tar may contain (CONTRACT 9.3). Its serialisation schema is `Schema.VERSION`
(1 in 4.3.0). The tool prints its JSON summary, including `engineSchemaVersion`, on stdout; CI
redirects it to `build/converted/<flavour>/engine/engine.json`, which is where pack reads that
number for the manifest so the app can fall back to rebuilding from `advanced.txt` when its own
library disagrees. `engine` needs at least one advanced rule, so CI skips it (and pack reports
`engine.absent`) when `advanced.txt` is empty.

The engine payload is deliberately exempt from the determinism rule below: `FilterEngine`
stamps a timestamp into `meta.bin`, so `engine.bin`, `meta.bin` and `engine.<flavour>.tar.lzfse`
differ between two runs over identical input. Delta accounting ignores that payload.

**Exit codes.** Section 3, plus: exit 3 when `errorsCount > 0` and `--strict` is set (CI sets
it for `janus.active` only, where a conversion error is never acceptable), and exit 5 when the
output JSON does not parse as an array of objects.

**Determinism.** The tool writes files with `Data.write(to:options:.atomic)` and no timestamps.
`safariRulesJSON` is emitted exactly as the library produces it; the pipeline does not reformat
it, because the SHA-256 in the manifest is over these bytes.

---

## 13. Tool: `Tools/RuleListValidate` (macOS only)

A SwiftPM executable that compiles every produced bucket with the real WebKit compiler, which is
the only authority on whether a list will load on the phone. `platforms: [.macOS(.v13)]`, no
external dependencies, links `WebKit`.

**CLI.**

```
RuleListValidate
    --dir <build/converted/<flavour>>   directory of <bucketId>.json files
    --flavour <ios17|ios26>
    --out <build/validate/<flavour>/report.json>
    [--store <path>]                    scratch WKContentRuleListStore directory
    [--soft-cap 80000] [--hard-cap 110000]
    [--compile-budget-ms 20000]         warn above this compile time
    [--compile-budget-fatal]            make that budget fatal (CI never passes it)
    [--bisect] [--max-bisect 40]        minimum attempts per bisect, raised per bucket
    [--compress <build/dist>]           also write <bucketId>.<flavour>.json.lzfse
    [--self-test]                       compile one trivial list, print the result, exit
    [--verify-lzfse <src=dst,...>]      decode payloads this tool did not compress
                                        through NSData.decompressed(using:.lzfse)
```

**Algorithm.** For each bucket, in sorted id order: read the JSON off the main thread, hash it,
then hop to `@MainActor` and call
`WKContentRuleListStore.default().compileContentRuleList(forIdentifier:encodedContentRuleList:completionHandler:)`
one at a time, measuring wall time. Compilation is initiated on the main thread deliberately —
that is Brave's fix for the iOS 26 crash (brave-core #31483) and WebKit already does the work on
its own queue. The store directory is removed and recreated at the start of a run so a stale
compiled list can never make a broken bucket look healthy.

Recorded per bucket: `bucketId`, `ruleCount` (top-level array length), `bytes`, `sha256`,
`compileMs`, `error` (nil or the `WKErrorDomain` code and message), `bisect` (see below).

`--self-test` compiles a single one-rule list through that same code path and exits. Driving
`WKContentRuleListStore` from an unbundled command-line tool by pumping the main run loop is the
one dependency of this stage that cannot be exercised on the Windows dev machine, so CI runs the
self test as the first thing in the convert step: if it misbehaves on a new runner image the run
fails in seconds instead of after the whole 45-minute convert loop.

**Failure handling.** A compile error is one of `JSONTooManyRules` (over 150,000),
`JSONInvalidRegex` (an unsupported `url-filter`, `if-top-url` or `if-frame-url` regex), or an
invalid action or trigger string. With `--bisect`, the tool halves the rule array to find the
smallest failing set, up to `--max-bisect` iterations, drops the offending rules, writes them
with their index and the compiler's message to `build/validate/<flavour>/dropped-bisect.jsonl`,
rewrites the bucket JSON, and re-compiles. A bucket that still fails after bisecting fails the
run with exit 5.

Precise isolation costs about `2*log2(n)` compiles — roughly 31 for the 40k-rule buckets this set
currently produces — so `--max-bisect` is a **floor**, not a ceiling: the tool raises it per bucket
to `2*ceil(log2(n)) + 4`, and CI passes 40. When the budget does run out, the smallest failing
segment that *was* identified is dropped as a unit, every rule in it is written to
`dropped-bisect.jsonl` with `precise: false`, the bucket's report entry carries
`budgetExhausted: true`, **and the run fails with exit 5**: dropping a whole range means hundreds
of live rules vanishing on a budget accident, which is not something to publish quietly. For the
same reason, any bisect drop from `janus.active` fails the run — surrogates and folded unbreak
exceptions are all-or-nothing (section 18), so a `janus.active` that compiles only after rules were
removed is not a `janus.active` worth shipping.

Separately, when both halves of a bucket compile on their own
the failure is `JSONTooManyRules`, a bucketing-budget problem that dropping rules would only
hide: the tool drops nothing, marks `sizeFailure`, and exits 3 so `B` gets raised instead.

A bucket the bisector rewrote is re-serialised with `JSONSerialization` (sorted keys, compact,
slashes unescaped), so its bytes differ from SafariConverterLib's formatting; the report marks it
`rewritten: true`. That is safe because pack hashes the file on disk, never a remembered value,
and an untouched bucket keeps the library's exact bytes.

Note that invalid `css-display-none` selectors are *silently skipped* by WebKit rather than
failing the list, so the compiler cannot be used to police cosmetic quality — only the Tier B
emulator and the live suites can.

**Budgets.** Exit 3 when any bucket exceeds `--hard-cap` rules, and a warning (recorded, not
fatal) above `--soft-cap`. Exceeding `--compile-budget-ms` is **also only a warning**: it sets
`compileBudgetExceeded: true` on the bucket's row and is fatal only with the explicit
`--compile-budget-fatal`, which CI does not pass. `compileMs` on the runner is not a phone number
and is never presented as one — DESIGN 3.4 treats it as a regression signal and a cost hint, and a
slow hosted runner is not a reason to withhold a correct bundle. It feeds `manifest`'s `compileMs`
field so the app can order its own compile queue sensibly.

**Compression.** With `--compress`, the tool writes each bucket as LZFSE using Apple's
`compression` framework (`COMPRESSION_LZFSE`), the same codec `NSData.decompressed(using:.lzfse)`
reads on the device, and records both the uncompressed sha256 and the compressed file's sha256
and size. Doing it here rather than shelling out to `compression_tool` keeps one implementation
and lets the tool verify a round trip in memory before writing — a corrupted payload that only
fails on the phone is exactly the failure mode this pipeline must not have.

---

## 14. Stage: report (dropped rules)

**In:** every stage's drop record, `build/converted/<flavour>/*.conv.json`,
`merged.provenance.jsonl`, optionally yesterday's `build/reports/` as `--baseline`.
**Out:** `build/reports/dropped/<listId>.json`, `build/reports/dropped.md`.

A rule can disappear at seven points, and each one is a different problem, so they are never
merged into a single "dropped" number.

| Cause prefix | Where | Meaning |
|---|---|---|
| `fetch.*` | section 6 | list or include unavailable, body rejected |
| `include.*`, `if.*`, `normalise.*`, `hosts.*`, `badfilter.*` | section 7 | preprocessing |
| `trust-gate` | section 8 | stripped because the list is untrusted |
| `alias.*`, `scriptlet.no-alias`, `csp.*`, `removeparam.*` | section 9 | translation could not save it |
| `bucket.*` | section 10 | over budget, unroutable |
| `convert.*` | section 12 | SafariConverterLib discarded it |
| `compile.bisect` | section 13 | WebKit refused it |

The converter does not hand back the text of what it discarded, only counters. The pipeline
recovers the detail itself: `src/stages/report.mjs` re-parses each bucket's input and classifies
every rule the converter cannot express, using the modifier and syntax table from
SafariConverterLib 4.3.0's README, then reconciles its own classification against
`discardedSafariRules` and `errorsCount`. When the two disagree by more than 1 %, the report
says so — a silent drift between what we believe is unsupported and what the library actually
drops is exactly the regression this report exists to catch.

`reports/dropped/<listId>.json`:

```json
{
  "schemaVersion": 1,
  "listId": "ubo.filters",
  "counts": { "in": 6512, "kept": 6180, "dropped": 332 },
  "byModifier": { "$csp": 41, "$redirect-rule": 12, "$removeparam": 88,
                  "$replace": 3, "##^": 7, "$permissions": 2, "other": 9 },
  "byScriptlet": { "hd-main.js": 4, "outbrain-widget.js": 2 },
  "byCause": { "trust-gate": 0, "scriptlet.no-alias": 6, "convert.unsupported-modifier": 162 },
  "samples": [ { "rule": "example.com##^script:has-text(ads)", "cause": "convert.html-filtering",
                 "line": 1204 } ]
}
```

`samples` holds at most 20 rules per cause, chosen by first occurrence so the set is stable
between runs.

`reports/dropped.md` is the human view. It leads with the sites DESIGN 3.3 step 4 names —
`reddit.com`, `gofile.io` and the owner's three video sites — listing every rule mentioning
those domains that did not survive, with the cause. Then per-list totals with **day-over-day
deltas** against `--baseline`, then the global modifier histogram. A delta larger than 10 % of a
list's kept count, or any new cause appearing for a watched site, is flagged in bold; CI posts
this file as a job summary so the change is visible without downloading an artifact.

The report never fails the run on its own. Losses are expected and permanent; what matters is
that they are visible and that they become site-fix entries when they matter (DESIGN 3.3 step 4).

---

## 15. Stage: pack

**In:** `build/converted/`, `build/validate/`, `build/auxdata/`, `build/reports/`, the previous
published manifest (downloaded by CI as `build/previous-manifest.json` when one exists).
**Out:** `build/dist/` complete except the signature.

### 15.1 Assembling the payloads

Steps 1 and 2 need macOS, so they run in the `convert` job, not in `publish`: LZFSE lives on
macOS and the splice has to happen before WebKit sees `janus.active`. Both are modes of the
pack stage, and `build/dist/` then travels to `publish` inside the `converted` artifact, where
step 3 hashes exactly the bytes that will be uploaded. `pack` without a mode refuses to invent
a missing `.lzfse` (exit 3) rather than compress on the wrong runner.

1. Splice `janus.active` — `node src/cli.mjs pack --splice-active --flavours <flavour>`, on
   macOS, after `convert` and before `RuleListValidate`: prepend
   `build/auxdata/active-redirects.json`'s redirect actions to the converted `janus.active` JSON
   array in the order of section 11.1, then append the folded exceptions. `RuleListValidate`
   then compiles the spliced file like any other bucket; a splice that does not compile is
   exit 5. The pass is idempotent and records what it did in
   `build/auxdata/active-splice.<flavour>.json` — under `build/auxdata/`, never beside the buckets,
   where `RuleListValidate --dir` would mistake it for one.
2. Compress — `node src/cli.mjs pack --prepare-payloads --flavours <flavours>`, on macOS, after
   `RuleListValidate`: build the engine tar, then LZFSE every payload that is not compressed
   yet. `RuleListValidate --compress build/dist` has already written the bucket payloads
   through `COMPRESSION_LZFSE`, so this pass normally covers `advanced.<flavour>.txt`, each
   `advanced.<flavour>.<optInSlug>.txt`, the three aux payloads and the engine tar. An advanced
   payload that is empty is skipped rather than compressed — LZFSE refuses empty input — and the
   manifest then carries `ruleCount: 0` with no `file`. The encoder is
   `compression_tool -encode -a lzfse` (never `-A`, which writes a `pbz<algo>` block container
   the app could not read); every file written is immediately decoded again and compared with
   its source, so no stream ships that this build could not read back. File names are exactly
   those in section 2.1. Because that round trip only exercises `compression_tool` against
   itself, CI then runs `RuleListValidate --verify-lzfse <source>=<compressed>,...` over the
   engine tar, the advanced texts and the three aux payloads: that decodes them through
   `NSData.decompressed(using: .lzfse)`, the exact API the device calls, which is the check that
   proves the phone can read the bytes. The bucket payloads are written by the validator itself
   and have already passed it.
3. Hash: `sha256` over the **uncompressed** bytes, `downloadSha256` over the `.lzfse` file.
   `build/validate/<flavour>/report.json` is a **required** input of this step, not a nicety:
   pack exits 3 when a flavour has no rows, when `status` is not `ok`, or when a bucket it is
   about to sign has no row, and exits 5 when a row's `sha256` or `ruleCount` disagrees with the
   bytes on disk. Nothing is signed on the strength of a warning; `--allow-unvalidated` exists
   for local experiments and CI never passes it.
   Uncompressed is the identity of a bucket (it is what the app compiles and what the previous
   manifest is compared against); the compressed hash lets the app reject a corrupted download
   before it decompresses anything.
4. Carry forward: for each bucket, compare `sha256` against the previous manifest. Unchanged
   buckets keep `compileMs` from the previous entry; `downloadSha256` and `downloadSize`
   are always measured fresh, because they must describe the bytes actually uploaded. The
   count of changed buckets and the total changed compressed bytes go into the manifest as
   `delta`, which is how DESIGN 3.4's "under 5 MB, under 3 recompiled buckets" target is
   measured in M2b. `delta` reports the worst flavour, since a device installs one flavour,
   and carries a `byFlavour` breakdown beside it. A `.lzfse` that re-compresses to different
   bytes from identical input logs `compress.nondeterministic`.

### 15.2 The manifest

`build/dist/manifest.json` is the only file the app parses before it trusts anything. Its exact
schema, field by field, with a full example, is `docs/CONTRACT.md` section 4; that document is
normative for the app and this one must not restate it loosely. The pack stage's obligations:

- `version` is a monotonic integer, `YYYYMMDD * 100 + N` where `N` is the run of that UTC day
  (00..99). It is computed as `max(previous.version + 1, dateComponent)` so it is monotonic even
  if a clock or a re-run misbehaves. Exit 3 if the result is not strictly greater than the
  previous published version. That guarantee only holds if `build/previous-manifest.json` really
  is the published manifest, so CI distinguishes "no release yet" from "the fetch failed": a
  failed download while any release exists fails the run (section 17.1), and the publish job
  re-reads the live signed manifest and compares versions again immediately before it moves
  `releases/latest`.
- `issuedAt` is RFC 3339 UTC, the single clock read of the whole run. `expiresAt` is
  `issuedAt + 14 days`, matching the app's staleness rule (DESIGN 3.4).
- `layoutVersion` increments whenever `B` or `G` changes for any family, or a family is added or
  removed. The app treats a `layoutVersion` change as "download the whole set".
- `keyId` is the signing key's id (section 15.3) and must equal the id derived from the public
  key in `docs/CONTRACT.md`.
- `minAppBuild` is read from `config/buckets.json`'s `minAppBuild` field and is raised only when
  a payload uses something older app builds cannot parse.
- Every bucket entry carries `id`, `family`, `flavour`, `file`, `sha256`, `size`,
  `downloadSha256`, `downloadSize`, `ruleCount`, `compileMs`.
- `optIn` on a bucket entry is copied from `build/buckets/index.json`, which the bucket stage
  wrote: it is a property of the bucket **group**, not something to re-derive from `sourceLists`.
  A default list's exceptions are replicated into opt-in groups (section 10.5), so every opt-in
  bucket has default lists among its sources and re-deriving would publish it as `optIn: false` —
  installing lists the owner never enabled.
- `advancedRules.<flavour>` describes the default-on payload and carries one `optIn[]` entry per
  opt-in payload, each naming its `lists` (CONTRACT 9.1).
- A flavour named in `--flavours` must be built in full, and a bundle must carry every flavour of
  the contract: pack exits 3 otherwise, because a device whose flavour is missing finds no bucket
  files at all. `--allow-partial-flavours` waives it for a local experiment only.
- `dropped` carries the global summary counts from section 14, not the detail.
- `killSwitches` comes from `build/auxdata/killswitches.json`, which the active stage writes as
  `{ schemaVersion, note, killSwitches: { ... } }`; pack also accepts a bare map of the five
  booleans. It lets the owner disable
  list-supplied JavaScript, surrogates or advanced rules remotely without shipping an app
  update (DESIGN 3.5).

The manifest is serialised with a fixed key order and two-space indentation, UTF-8, LF, and no
trailing newline after the final `}` — the bytes on disk are the bytes that are signed and the
bytes the app must hash, so there is exactly one byte sequence and no canonicalisation step for
the app to get wrong.

### 15.3 Stage: sign

**In:** `build/dist/manifest.json`, `JANUS_FILTER_SIGNING_KEY` from the environment.
**Out:** `build/dist/manifest.json.sig`.

```js
const key = crypto.createPrivateKey(process.env.JANUS_FILTER_SIGNING_KEY); // PKCS#8 PEM, Ed25519
const sig = crypto.sign(null, manifestBytes, key);                          // 64 raw bytes
await writeFile(sigPath, sig.toString("base64") + "\n");
```

Rules the implementation must follow:

- The key is read from the environment at run time only. It is never written to disk, never
  logged, never interpolated into a command line, never included in an artifact, and never part
  of an error message. On any failure the stage prints the key's **id**, never its material.
- `crypto.sign(null, ...)` is the only correct call for Ed25519 in Node; passing a digest name
  throws. The signature is over the file's exact bytes, with no canonicalisation, no detached
  header and no length prefix.
- `keyId` = the first 16 hex characters of the SHA-256 of the **raw 32-byte public key**
  (`createPublicKey(key).export({format:"jwk"})`, base64url-decode `x`). The stage recomputes it
  and exits 5 if it does not match `manifest.keyId`. For M2a that value is `d6ff9fb88ae9b930`.
- Immediately after signing, the stage runs the verify path (section 15.4) in-process against
  the **public** key constant. A signature that does not verify with the shipped public key is a
  release-stopping bug, and it is better to find it here than on the phone.

### 15.4 Stage: verify

`node src/cli.mjs verify --manifest <path> --sig <path> [--key <base64>] [--dir <payload dir>]
[--require-complete] [--skip-age] [--skip-hashes]` is standalone, has no dependency on the
private key, and is what CI runs twice: once against `build/dist/` right after signing, and
once against the re-downloaded release assets. `--dir` says where the payloads are (default:
the manifest's own directory), `--require-complete` turns a payload the manifest names but the
directory does not hold into a failure instead of a count, and the two `--skip-` flags exist
for the unit tests. Default key: the raw 32-byte public key

```
wFAZ/lFdpErWYl+lJvB02kKnHUOoKm9qqhgJckY8oAY=   keyId d6ff9fb88ae9b930
```

built into a key object with `crypto.createPublicKey({ key: derFromRaw, format: "der", type: "spki" })`
after wrapping the 32 raw bytes in the 12-byte Ed25519 SPKI prefix
`302a300506032b6570032100`. The command:

1. reads the manifest bytes exactly as stored (over 4 MiB is refused unread),
2. checks `manifest.keyId` against the key's derived id,
3. `crypto.verify(null, manifestBytes, publicKey, Buffer.from(sigBase64, "base64"))`,
4. checks `contractVersion`, that `baseUrl` and every mirror sit under a pinned origin, and
   freshness: age at most 14 days, `issuedAt` no more than 24 h in the future, and
   `expiresAt` exactly `issuedAt + 14 days`,
5. re-hashes every file named in the manifest that is present on disk and compares `sha256` and
   `downloadSha256`,
6. exits 0 or 5. Every rejection inside verify is exit 5, including a stale or mis-dated
   manifest: this stage either certifies a bundle or it does not.

This is also the routine the app mirrors; `docs/CONTRACT.md` section 6 specifies the same steps
in the same order so a disagreement between the two is a test failure, not a field mystery.

---

## 16. Stage: publish

DESIGN 3.3 step 9 pins the mechanism: *published as a Release asset plus Pages*, and only the
publish job runs in the GitHub environment `filters-release`, restricted to `main`, holding
`JANUS_FILTER_SIGNING_KEY`.

**Release.** Tag `filters-<version>` on the `main` commit that built the set, release title
`Filters <version>`, body = the top of `reports/dropped.md` plus the delta summary. Assets are
the flat contents of `build/dist/` (GitHub releases have no directories, which is why bucket
files carry the flavour in the name).

The switch is atomic by construction:

1. create the release as a **draft**,
2. upload every asset and confirm each one's size and sha256 by re-downloading it,
3. run `verify` against the re-downloaded `manifest.json` and `manifest.json.sig`,
4. only then mark the release non-draft, which is the instant `releases/latest/download/...`
   starts resolving to it.

A failure at any step leaves a draft release that no URL resolves to, and the previous release
stays `latest`. Drafts older than 7 days are deleted by the next successful run.

**Pages mirror.** The same `build/dist/` is deployed to GitHub Pages under `/latest/` and
`/v/<version>/`, giving the app a second origin with identical bytes. Pages is a mirror, never
the source of truth: the app prefers the Release URLs and falls back to Pages
(`docs/CONTRACT.md` section 3).

**Stable URLs** (normative form in `docs/CONTRACT.md` section 3):

```
https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json
https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json.sig
https://github.com/mioutic/janus-filters/releases/latest/download/<file>
https://github.com/mioutic/janus-filters/releases/download/filters-<version>/<file>
https://mioutic.github.io/janus-filters/latest/<file>
```

---

## 17. CI

### 17.1 Job graph: `.github/workflows/filters.yml`

Triggers: `schedule` at `17 4 * * *` UTC, and `workflow_dispatch` with inputs
`publish` (boolean, default true), `flavours` (default `ios17,ios26`) and `lists` (optional
comma-separated subset for debugging).

```
prepare (ubuntu-latest, ~6 min)
  node 24, npm ci, npm test, pin-check --online
  fetch the live manifest: a failed download with a release live fails the run
  cli build  (fetch .. active, report)
  artifact: janus-filters-input-<run_id>
        |
        v
convert (macos-26, ~10 min)                     needs: prepare
  swift build JanusConvert, RuleListValidate, RuleListValidate --self-test
  per flavour: convert every bucket (advanced rules routed per opt-in list, then
               deduped), pack --splice-active, build engine,
               validate (+ --compress build/dist), then pack --prepare-payloads
  report (again: section 14 needs the per-bucket converted counters)
  artifacts: janus-filters-converted-<run_id> (converted/, validate/, dist/),
             janus-filters-reports-<run_id>
        |
        v
publish (ubuntu-latest, ~2 min)                 needs: convert
  environment: filters-release       if: github.ref == 'refs/heads/main'
                                     && inputs.publish != false
  pack, sign, verify, draft release, upload, verify downloads,
  re-check the live latest is older, undraft
  no `npm ci`: pack/sign/verify need only node: built-ins, and no third-party
  install script runs in the job that can see the signing key
  artifact: janus-filters-dist-<run_id>
        |
        v
pages (ubuntu-latest, ~1 min)                   needs: publish
  environment: github-pages          continue-on-error: true
  mirror build/dist under /latest/ and /v/<version>/
```

Pages is its own job, not a step of `publish`: `actions/deploy-pages` requires the
`github-pages` environment and a job may declare only one, so folding it in would put the
signing environment and the Pages deployment in the same job. It is also `continue-on-error`,
because the Release is authoritative and is already live by then. A Pages deploy replaces the
whole site, so that origin serves only `/latest/` and the current `/v/<version>/`; older
versions stay available from Releases.

The `report` stage therefore runs twice, once per side: `prepare` produces the per-list causes,
`convert` re-runs it so the converted counters from `*.conv.json` and the bisector's
`dropped-bisect.jsonl` reach `reports/dropped.md`. That is why the `prepare` artifact carries
the small per-list sidecars (`build/prepared/*.stats.json`, `build/trusted/*.gate.json`,
`build/xlated/*.xlate.json`) alongside the buckets: the full prepared texts are large and
recoverable from upstream, but the sidecars are what section 14 reconciles against and what
pack reads per-list rule counts from.

`prepare` and `convert` hold **no secrets**; the environment is attached to `publish` alone, so
the signing key is unreachable from any job that executes third-party filter content.

**Permissions.** Workflow-level `permissions: contents: read`. `publish` overrides with
`contents: write` (release), `pages: write` and `id-token: write` (Pages deployment). No job
gets `actions: write` or `packages: write`.

**Concurrency.** `group: filters-${{ github.ref }}`, `cancel-in-progress: false`. A publish must
never be cancelled between uploading assets and undrafting the release; a queued second run is
cheap, a half-published release is not.

**Timeouts.** `prepare` 20 min, `convert` 45 min, `publish` 15 min. macOS minutes are free for
this public repo, but a hung job still holds the concurrency group.

**Job summaries.** `convert` appends the budget table; `publish` appends the delta summary and
the release URL.

### 17.2 Caching

| Cache | Key | Restore keys |
|---|---|---|
| npm | `npm-${{ hashFiles('package-lock.json') }}` | `npm-` |
| filter bodies | `filters-cache-${{ github.run_id }}` | `filters-cache-` |
| SwiftPM | `spm-${{ runner.os }}-${{ hashFiles('Tools/**/Package.resolved') }}-xcode26.6` | `spm-${{ runner.os }}-` |
| Swift build products | `swiftbuild-${{ hashFiles('Tools/**/*.swift','Tools/**/Package.resolved') }}-xcode26.6` | `swiftbuild-` |
| previous manifest | not cached — downloaded from the latest release | — |

The filter-body cache is keyed on the UTC day plus `hashFiles('lists.json')`, with a prefix
restore so a run that finds no exact key still reads the newest previous entry. A key that can
repeat matters: a per-run key would write a brand-new ~200 MB entry every night and evict the npm
and SwiftPM entries it shares the repository's 10 GB cache budget with, while a daily key is
refreshed in place. Conditional requests keep working either way — the 7/14-day staleness rule in
section 6 is the real guard, never the cache.

`Package.resolved` is **committed** for every Swift tool that has a dependency to resolve, so
the exact SafariConverterLib commit is pinned and reviewable, and CI uses it rather than
resolving fresh. `Tools/RuleListValidate` declares no external package — it links WebKit,
CryptoKit and Compression from the SDK and parses its own arguments — so SwiftPM writes no
`Package.resolved` for it and `pin-check` does not ask for one.

`package-lock.json` is committed, so both workflows use `npm ci` and the npm cache key is a real
hash. The lockfile has exactly one direct dependency, `@adguard/scriptlets` 2.5.1: the alias
generator derives `config/ubo-alias.json` from it and the active stage reads redirect resource
bodies out of it. Public-suffix lookups use the committed subset in `src/lib/psl-data.mjs`
instead of a package, because changing that data re-keys every bucket and therefore has to be a
reviewable diff with a `layoutVersion` bump, not a transitive version bump.

### 17.3 Artifacts

| Name | Contents | Retention |
|---|---|---|
| `janus-filters-input-<run_id>` | `build/buckets/`, `build/auxdata/`, `build/prepared/*.stats.json`, `build/trusted/*.gate.json`, `build/xlated/*.xlate.json`, `build/merged.provenance.jsonl`, `build/previous-manifest.json`, config snapshot | 14 d |

The per-list sidecars in the input artifact are not decoration: they are the only evidence that
travels for a list whose full text does not, so `pack` proves "this list was built" from
`<listId>.stats.json` / `.gate.json` / `.xlate.json` and not from a `build/prepared/*.txt` that was
never uploaded. Both consumers of that artifact assert `build/buckets/index.json`,
`build/auxdata/killswitches.json` and `config/buckets.json` exist after the download, because the
artifact's root depends on the least-common-ancestor of its path list: dropping `config/` from it
would silently retarget everything to `build/` and unpack the buckets at the repository root.
| `janus-filters-converted-<run_id>` | `build/converted/`, `build/validate/`, `build/dist/` (the `.lzfse` payloads: LZFSE is produced on macOS and `publish` hashes those exact bytes) | 7 d |
| `janus-filters-reports-<run_id>` | `build/reports/` | 30 d |
| `janus-filters-dist-<run_id>` | `build/dist/` minus nothing (the signature is public) | 30 d |

Raw list bodies (`build/raw/`) are **not** uploaded: they are large, they are public upstream,
and the provenance file already ties every rule to a list and a line.

### 17.4 `.github/workflows/test.yml`

`push` on `main` and `pull_request` — the push trigger is branch-filtered because
`pull_request` already covers topic branches and an unfiltered `push` runs every job twice per
commit (the concurrency group keys on `github.ref`, which differs between the two events).
ubuntu-latest, Node 24, `npm ci`, `npm test` (node:test with `--experimental-test-coverage`),
`node scripts/pin-check.mjs --online`, `node scripts/gen-alias.mjs --check`,
`npm run notice:check`, and `npm run dry-run` against the fixtures. No network beyond npm, the
GitHub API and the npm registry; no macOS in this job, no secrets, `permissions: contents: read`.
This is the gate that must be green before anything merges to `main`.

A second job, `swift-build` on `macos-26`, runs `swift build -c release` for both tools when any
file under `Tools/**` changed. It runs on `pull_request` **from this repository only**: `swift
build` executes the package manifest and any plugins, so a fork pull request would run its own
code on our runner, and macOS minutes are the cost. It also attempts `swift test`, whose output is
captured once — a package with no test target reports "no tests found", which is tolerated rather
than treated as a failure, and re-running the suite just to grep it would double the job. The job
converts nothing; it exists so a Swift syntax error is caught by the PR and not by the nightly.

---

## 18. Failure policy

**A partial or unvalidated set is never published.** That single rule decides every case below.

| Condition | Outcome |
|---|---|
| Required list unfetchable, no cache | exit 4 in `prepare`; no publish |
| Any default-on list skipped | exit 3 in `pack`; no publish |
| Cached body older than 14 days | exit 3 in `prepare`; no publish |
| Unterminated `!#if`, malformed list structure | exit 3 for that list; no publish |
| Bucket over `hardCap` (estimated or real) | exit 3; no publish |
| A bucket fails to compile and bisect isolates the bad rules precisely | continue, record in `dropped-bisect.jsonl` and the report |
| A bisect drops a whole range (`precise: false`) | exit 5; no publish |
| A bisect drops anything from `janus.active` | exit 5; no publish |
| A bucket fails to compile after bisect | exit 5; no publish |
| Runner `compileMs` over `--compile-budget-ms` | warning on the bucket's row; publish continues |
| `build/validate/<flavour>/report.json` missing, not `ok`, or disagreeing with the packed bytes | exit 3 or 5 in `pack`; no publish |
| `janus.active` conversion or splice error | exit 5; no publish (surrogates are all-or-nothing) |
| Converter `errorsCount > 0` outside `janus.active` | warning, recorded per bucket |
| Missing flavour: one of `ios17`/`ios26` incomplete | exit 3; no publish |
| Signature does not verify locally | exit 5; no publish |
| Version not strictly greater than the published one | exit 3; no publish |
| Asset upload or re-download mismatch | exit 5; release stays a draft |
| Pages deployment fails after the release is live | warning only; Release is authoritative |

When a run does not publish, the previous release remains `latest`, the app keeps compiling what
it already has, and the only visible consequence is the manifest ageing. At 14 days the app
shows "Filters stale" (DESIGN 3.4). That is a designed, observable degradation, not an outage.

Nothing in the pipeline retries a publish automatically. A failed nightly is investigated from
its artifacts and re-run with `workflow_dispatch`.

---

## 19. Tests

`node:test` only; no test framework dependency. `npm test` runs everything in `test/`.

| Suite | What it pins |
|---|---|
| `hash.test.mjs` | FNV-1a vectors, eTLD+1 extraction, punycode, sha8 derivation |
| `preprocess.test.mjs` | include expansion and its cross-origin refusal, `!#if` truth table for the DESIGN environment, nesting, malformed expressions, affinity stripping, hosts conversion, normalisation, `$badfilter` |
| `trustgate.test.mjs` | every strip rule, both modes, trusted lists untouched, gate report contents |
| `translate.test.mjs` | alias application with and without `.js`, trusted-target refusal for untrusted lists, `$csp`/`$removeparam`/`$popup` extraction |
| `bucket.test.mjs` | routing, key selection, stability across a rule insertion, the five-section order, every replication case, budget estimation |
| `active.test.mjs` | redirect-then-block order, no ignore rules between, ignore tails in every network bucket, unbreak folding and the fallback append |
| `report.test.mjs` | cause classification, reconciliation with converter counters, baseline deltas |
| `golden.test.mjs` | the committed fixture `build/` tree, byte for byte: the determinism gate |
| `release.test.mjs` | manifest field order and byte-exact serialisation, version monotonicity, delta, the 14-day window, both `killswitches.json` shapes, pack's refusal to invent a payload; sign/verify round trip with a **test-only** generated key, keyId derivation, tamper detection, refusal of any key but the pinned one, exit 2 when the signing environment is absent |

Fixtures live in `test/fixtures/` and are deliberately tiny and hand-written: a 40-line fake
AdGuard list, a 20-line fake uAssets list with scriptlets and an unbreak exception, a 10-line
hosts file, an include chain, an `!#if` matrix, and a golden `build/` tree for the dry run. Real
upstream lists are never committed — they are large, they change daily, and they carry their own
licences.

Every test asserts **bytes**, not shapes, wherever the output feeds a hash. A golden-file diff is
the only way a determinism regression gets caught before it costs the phone a full re-download.

---

## 20. Public-repo hygiene

This repository is public and permanently so. The following are hard rules, enforced by review
and by `npm test`:

- No secrets, tokens, private keys, personal data, real names, email addresses, local Windows
  paths, device identifiers, or any Janus app source. The signing key exists only as a GitHub
  environment secret and only inside the `publish` job.
- The public key and its keyId are public by design and appear in code, docs and the app.
- Our code is **GPL-3.0-or-later** (`LICENSE`), which is required: SafariConverterLib and
  AdGuard's scriptlet and extended-css libraries are GPL-3.0.
- Every filter list keeps its licence and source URL in `lists.json` and its attribution in
  `NOTICE`; GPL and CC BY-SA terms are preserved, and `notice:check` fails the build if NOTICE
  drifts from `lists.json`.
- Logs and artifacts never contain environment values. The dropped report quotes filter rules,
  which are public upstream text, and nothing else.
- Issue templates and CI logs must not invite anyone to paste browsing history or device logs.

---

## 21. What this pipeline does not do yet

Out of scope for M2a, listed so the boundaries are explicit:

- **ProbeHost and `spike.yml`** — the simulator compile and feature-canary suites
  (DESIGN 9.3, 10.2). `runtimes.yml` compiles every bucket in every installed simulator runtime
  on converter or runtime bumps; it lands with M2c.
- **`live.yml`** adblock and video suites, and the Ghostery reference diff (M2c).
- **Injected page scripts** (`web/sentinel.js`, `janus-core.js`, `media-hooks.js`,
  `casie-lite.js`) and their unit tests, which the app syncs via `scripts/sync-web.mjs`.
- **App-side Swift**: `RuleListCompiler`, `RuleListRegistry`, `ProtectionGate`, `BundleUpdater`.
  Their obligations are specified in `docs/CONTRACT.md`, not implemented here.

Two numbers in this document are provisional and must be replaced from measurement, not
adjusted by feel: the per-family bucket counts `B`/`G` (from the first real converted counts) and
the compile-time budget (from phone signposts in M2a, runner numbers being only a regression
signal).
