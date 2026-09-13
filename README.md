# janus-filters

The public filter factory for **Janus**, a personal iPhone browser. Every day this
repository turns public filter lists into a signed, versioned, compile-validated
bundle of WebKit content-blocking rules, and publishes it as a GitHub Release that
the app downloads without credentials.

This repository is public and permanently so. It contains **no personal data**: no
browsing history, no device identifiers, no account information, and no Janus app
source. The only secret in the build is the bundle signing key, which exists only
as a GitHub environment secret and is read from the environment inside a single CI
job — never written to a file, never logged, never uploaded in an artifact.

- **How the bundle is built:** [`docs/PIPELINE.md`](docs/PIPELINE.md) — every stage,
  its inputs, outputs, algorithm, exit codes and budgets.
- **What the app is allowed to assume:** [`docs/CONTRACT.md`](docs/CONTRACT.md) —
  URLs, manifest schema, signature, verification order, failure behaviour. That
  document is normative for the app; this README is an overview.
- **Proof that the bundle blocks:** [`docs/PROBEHOST.md`](docs/PROBEHOST.md) —
  what each measured number means, which are trustworthy and which are only
  indicative, and what the runner's datacentre IP changes about a page.

## What the app downloads

```
https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json
https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json.sig
```

`manifest.json` is the only file parsed before anything is trusted. It names every
payload with its size and SHA-256, and it is covered by an Ed25519 signature over
its exact bytes. Payloads are standalone LZFSE-compressed files: one compiled
`WKContentRuleList` JSON per bucket per flavour, the advanced-rules text that
content rules cannot express, an optional prebuilt match engine, and three small
JSON payloads (link cleaner, popup index, site fixes).

The verification order the app follows — signature first, then version and age,
then per-file hashes, then compilation, then an all-or-nothing swap — is specified
in `docs/CONTRACT.md` section 6 and implemented here by `src/stages/verify.mjs`, so
the pipeline and the app check the same things in the same order.

**Signing key (public half, public by design):**

```
Ed25519 raw public key (base64):  wFAZ/lFdpErWYl+lJvB02kKnHUOoKm9qqhgJckY8oAY=
keyId (sha256 of those 32 bytes, first 16 hex chars):  d6ff9fb88ae9b930
```

The app pins that key by id. An unknown `keyId` is a rejection, never a prompt and
never a key fetched from the network: rolling the key requires an app update, which
is the point — a compromised pipeline cannot introduce its own key.

A GitHub Pages mirror (`https://mioutic.github.io/janus-filters/latest/…`) carries
byte-identical copies as a fallback origin. The Release is always the source of
truth.

## Why a bundle at all

WebKit only accepts compiled content rules, with hard limits and a vocabulary that
cannot express procedural cosmetics, scriptlets or redirects on its own. Doing the
conversion on a phone would be slow, unverifiable and impossible to audit. Doing it
here means the phone receives rules that a real WebKit compiler has already
accepted, with counts, compile times and a full accounting of what had to be
dropped. Three properties are non-negotiable:

1. **Fail closed.** A partial, unvalidated or unsigned set is never published. The
   previous release stays `latest` and the app keeps the filters it already has.
2. **Stable identity.** A bucket whose rules did not change keeps byte-identical
   JSON and therefore the same SHA-256, so a daily update re-downloads and
   recompiles only what moved.
3. **Honest losses.** Everything the converter cannot express is counted,
   categorised and reported per list and per day.

## Layout

```
lists.json          the list set: source URLs, mirrors, licences, trust levels
config/             the !#if environment, trust rules, bucket families, site fixes
src/cli.mjs         `janus-filters <stage>` — the only entry point
src/stages/         fetch, preprocess, trustgate, translate, bucket, active,
                    report, pack, sign, verify
Tools/JanusConvert  SwiftPM CLI over SafariConverterLib 4.3.0 (macOS CI only)
Tools/RuleListValidate  compiles every bucket with WKContentRuleListStore (macOS CI only)
Tools/ProbeHost     a minimal iOS app that consumes a published bundle and measures
                    what it blocks (simulator only, built in CI)
Tools/ProbeRunner   boots a simulator, runs every scenario in both modes, writes
                    the report, the job summary and the trend record
scripts/            pin-check, advanced-rules targets, NOTICE and alias generators
test/               node:test suites and tiny hand-written fixtures
VERSIONS.json       every pin: npm, SwiftPM, runners, Xcode, actions, budgets
```

`build/` is the only generated tree and is never committed.

## Building locally

Node 24 is the only requirement for everything except the two macOS stages. There
is no Swift toolchain needed to work on the pipeline.

```sh
npm ci               # one dependency: @adguard/scriptlets, pinned exactly
npm test             # node:test suites with coverage
npm run dry-run      # every non-macOS stage, offline, against the fixtures
npm run pin-check    # VERSIONS.json against package.json, workflows, Swift pins
                     # add -- --online to resolve every pin upstream, as CI does
npm run alias:check  # config/ubo-alias.json still matches the pinned package
npm run notice:check # NOTICE is regenerated from lists.json and must match
npm run ci:check     # all of the above, in the order CI runs them
```

`npm run dry-run:live` does the same against the real lists and needs network.
Conversion and WebKit compile validation run only on `macos-26` in CI.

To inspect a published bundle:

```sh
curl -fsSLO https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json
curl -fsSLO https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json.sig
node src/cli.mjs verify --manifest manifest.json --sig manifest.json.sig
```

`verify` needs no key material: the public key above is built into it.

## Continuous integration

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/test.yml` | push to `main`, pull request | Node tests, pins (online), generated files, fixture dry run; on a same-repository pull request that touches `Tools/`, a macOS Swift build |
| `.github/workflows/filters.yml` | daily at 04:17 UTC, manual | `prepare` (ubuntu) → `convert` (macOS) → `publish` (ubuntu, environment `filters-release`, `main` only) → `pages` |
| `.github/workflows/live.yml` | Mondays at 05:23 UTC, manual | Builds ProbeHost, loads every scenario on an iOS simulator with the published rules attached and again without them, and uploads the measurements |
| `.github/workflows/spike.yml` | manual | The M0 capability probes that need a real simulator, once per installed iOS runtime, offline against the app's own fixtures |

`prepare` and `convert` hold no secrets, which matters because they are the jobs
that execute third-party filter content. The signing key is attached to `publish`
alone, and only to the one step that signs. Every action is pinned to a commit
SHA recorded in `VERSIONS.json`, and `pin-check` fails the build if a pin drifts.

A failed run publishes nothing. The app then simply keeps using what it has; at 14
days it says so in its own UI. That is a designed, observable degradation rather
than an outage, and it is why nothing here retries a publish automatically.

## Does it actually block?

Claiming that a bundle blocks is easy; measuring it is the point of the `live`
workflow. It builds a small instrument app, `Tools/ProbeHost`, which downloads the
published manifest, verifies its signature and hashes exactly as
[`docs/CONTRACT.md`](docs/CONTRACT.md) describes, compiles the buckets with
`WKContentRuleListStore`, and then loads each site twice on an iOS simulator: once
with the rule lists attached and once without. The difference between the two runs
is the measurement — requests blocked, ad elements still visible, popups attempted,
overlays, load time.

Every run uploads its JSON, its screenshots and a small trend record as artifacts,
and writes the per-scenario table into the run's job summary. Neither workflow uses
a secret or an environment: ProbeHost verifies with the public key above, which is
the only key a client ever needs.

The numbers are not all equal in weight, and
[`docs/PROBEHOST.md`](docs/PROBEHOST.md) says which is which: blocked-request
counts and DOM counts are trustworthy, timings inside a virtualised simulator are
indicative at best, and a hosted runner reaches some sites from a datacentre
address that answers with a bot wall rather than a page. When that happens the run
records it and says so instead of pretending it measured blocking.

```sh
npm run probe -- --app <path to ProbeHost.app>   # macOS with Xcode, one simulator
npm run probe:report -- --dir build/probe/<runId>
```

## Licences and attribution

Our code is **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)), which is required:
SafariConverterLib and AdGuard's scriptlet and extended-css libraries are GPL-3.0.

Every filter list keeps its licence, licence URL, source URL and attribution in
`lists.json`, and [`NOTICE`](NOTICE) is generated from that file. GPL and CC BY-SA
terms are preserved, and `npm run notice:check` runs in CI, so a list cannot be
added without its attribution. The published bundles are derived works of those
lists and carry their terms.

If you maintain a list used here and want the attribution corrected, or want the
list removed, open an issue and it will be changed.

## Contributing

Pull requests are welcome for the pipeline, the tools and the tests. Two rules
matter most:

- **Adding a list** means adding its `license`, `licenseUrl` and `attribution` in
  `lists.json` and running `npm run notice`. The trust level stays `untrusted`
  unless the list is an official AdGuard or uAssets list.
- **Never paste personal data into an issue.** Do not send browsing history,
  device logs or URLs you visited. A failing rule can always be described with the
  rule text and the public page it applies to, both of which are public upstream.

Security: if you find a way to make the app accept a bundle it should have
rejected, that is a signature or verification bug. Open a minimal, private report
through GitHub's security advisories rather than a public issue.
