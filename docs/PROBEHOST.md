# Reading the ProbeHost numbers

ProbeHost is a small iOS app that downloads the **published** filter bundle exactly as
`docs/CONTRACT.md` describes it, compiles it, loads real pages in a `WKWebView` with and
without the rule lists attached, and writes down what happened. `.github/workflows/live.yml`
runs it on a free hosted macOS runner and attaches the numbers to the job summary.

This document is for the person reading those numbers. It says what each one means, what the
runner's network changes about it, and — the part that matters — **which numbers you may act
on and which you may only glance at**.

The design documents are in `docs/probehost/`: `00-index.md` (partition and flow),
`01-probehost.md` (the app), `02-runner.md` (the runner), `03-report.md` (the report,
summary and trend), `04-spike.md` (the M0 capability probes).

---

## 1. The shape of one measurement

Every scenario is loaded **twice**, in the same job, on the same simulator, minutes apart:

- **mode `blocked`** — every **non-opt-in** bucket the manifest names (CONTRACT §8.2; the
  `fx-optin` family is selected only when a run asks for it, and the scheduled suite does not)
  is compiled and attached.
- **mode `none`** — the same bundle is downloaded and verified payload by payload, and then
  nothing is compiled and nothing is attached. Compiling ~59 lists that no page would ever see
  cost the suite about 42 s per launch, so mode `none` stops after the hash check; its
  `compile.compileMs` values are therefore null, not zero.

Both modes do the same work up to the attach, so a difference between them is about the rule
lists and not about the bundle, the network or the device. Everything interesting is the
**delta**, written `b/n` in the job summary: `blocked` first, `none` second.

Before any site is touched, the harness runs `selftest-local` against fixtures it serves from
`127.0.0.1` inside the app: one URL that a rule *must* block, one that *must* load. Both are
judged by the **fixture server's own hit counts** — `/allowed.js` reached the server and
`/blocked.js` did not — rather than by "the document finished loading", so a rule set that
over-blocked the control cannot pass the gate. If that gate fails, the run stops. This is what separates "the filters did not block" from "the
harness was not measuring" — without it, `0 requests blocked` would be an ambiguous number
and this whole document would be worthless.

---

## 2. What each number is

| Number | Where it comes from | What it means |
|---|---|---|
| **Blocked** | WebKit's private rule-list action callback, one call per matching **list** per load | Distinct URLs (`blocked.distinctUrls`) whose load a content rule stopped. The raw callback count is beside it as `blocked.total` / `ruleListActions`: with ~59 overlapping shards attached, one blocked URL fires several callbacks, so the two differ and only the first is a request count. It is a **lower bound**: see the note below the table. Broken down by action, by bucket family, by host. |
| **Requests** | `PerformanceObserver({type:'resource'})` in every frame, including cross-origin iframes | Resources the **page** managed to fetch. In mode `blocked` this is what got through; in mode `none` it is the unfiltered baseline. |
| **Ads visible** | `querySelectorAll` over the scenario's selector list, in every frame | Distinct elements (`dom.uniqueVisible`) matching known ad markers that are actually **on screen**: non-zero rects, not `display:none`, not `visibility:hidden`, opacity ≥ 0.1, and inside a frame that is itself on screen. The DOM node may remain — hiding it is a success. `dom.totalVisible` beside it sums **per selector**, so an element matching three of the `@common` selectors appears three times there. |
| **Overlays** | Computed style scan | Fixed or sticky elements covering ≥ 25 % of the viewport. Consent walls, anti-adblock nags, interstitials. The count is `overlaysSummary.seen`; the `overlays` array is a capped **sample** (10 per frame, 10 in the record) and `overlaysSummary.truncated` says when it was cut. |
| **Popups** | Two counters: WebKit's `createWebViewWith` delegate call, and a `window.open` wrapper | The page *asked* for a window. ProbeHost always refuses, so nothing is ever opened. See §4 for why this number is weak. |
| **Dialogs** | `alert` / `confirm` / `prompt` delegate calls | Each is recorded and immediately dismissed with the neutral answer. |
| **Console errors** | `console.error`, `window.onerror`, `unhandledrejection`, CSP violations | Mostly noise — but a count that is **higher in `blocked` than in `none`** is a candidate breakage caused by our own rules, and the summary flags it. |
| **Load ms** | Navigation start to `didFinish` | How long the page took, on a virtualised 3-vCPU M1. |
| **State** | Selector and text matchers, run in **every** frame (most consent gates render inside a cross-origin iframe) | `ok`, `challenged`, `login-wall`, `consent-wall`, `error`, `unknown`. A body that matched a challenge wins over the HTTP status, so a bot wall served as `403` is `challenged`, not `error`; `pageState.httpStatus` keeps the status either way. Anything but `ok` makes the row advisory, and under `--strict` makes its expectation unmeasurable rather than missed. |
| **Compile** | `WKContentRuleListStore`, cold store, one bucket at a time on the main actor | Whether the published buckets compile in real WebKit, and roughly what each costs. Mode `blocked` only; the header's bucket and rule totals exclude the harness's own synthetic `probe.selftest.local` list. |

**What the blocked count cannot see.** WebKit notifies the app for *network-level* results
only: `blockedLoad`, `madeHTTPS`, `blockedCookies`, `redirected`, `modifiedHeaders` and
`notify`. A `css-display-none` rule produces **no callback at all**, so `blocked.byFamily` can
never contain `cos.generic` or `cos.specific` however well those buckets are working, and
`blocked.total` measures the `net.*` families and `active` alone. The record states this as
`blocked.spi.coversCosmetic: false`. The cosmetic families' only measurement in this harness
is **Ads visible** — read that row, not the blocked count, when judging them. Loads that
WebKit stops entirely inside the network process are also not reported to the app, which is
the other reason the blocked count is a lower bound rather than a total.

---

## 3. What the runner's IP changes

The simulator's network is the runner's network: an **Azure datacentre**. Every number is
taken from a machine that no consumer site believes is a phone in a house. That is not a
defect to work around — this project records what happens and does not attempt to evade bot
defences — but it changes four things, and you have to hold all four in your head.

1. **Some sites serve a challenge instead of the page.** Reddit is the usual one. The run is
   labelled `challenged` and its numbers describe an interstitial, not a feed. A `challenged`
   row with a low blocked count is not a blocking failure; it is a page with almost nothing on
   it. Read `State` before reading anything else in the row.
2. **Ad inventory is different, and usually thinner.** Programmatic demand for a datacentre
   IP is low. A site that serves eleven ad slots to a phone may serve three to the runner —
   in **both** modes. So the absolute "ads visible" number in mode `none` is a floor, and a
   small delta can mean "there was little to block", not "we blocked little". The delta tells
   you the direction; only a phone tells you the magnitude.
3. **Geography moves.** The runner region decides which consent regime a site applies, so
   `consent-wall` states and overlay counts can change between runs for reasons that have
   nothing to do with filters. Compare like with like: same runtime, same device type, same
   egress (`03-report.md` §4.2 lists the comparability keys, and the trend record carries all
   of them).
4. **Rate limits and A/B tests move too.** Two runs an hour apart can legitimately differ.
   That is why the stable benchmark (`canyoublockit-extreme`) exists: it is the scenario whose
   numbers should not move, so when it does move, something real changed.

Residential egress — running the suite through a home connection — is deliberately **not**
part of M2c. The right comparison for a live commercial site remains the owner's phone.

---

## 4. Trustworthy, indicative, and not evidence at all

### Trustworthy — act on these

- **Blocked-request counts.** They come from WebKit itself, with the rule-list identifier
  attached, so they are attributable to a bucket family and a host, and the self-check proves
  the mechanism fired in this very run. **Exact for what WebKit reports, a lower bound
  overall**: cosmetic hides are never reported (they show up in the DOM counts instead) and
  loads stopped inside the network process are not notified to the app. If mode `none` ever
  shows a non-zero blocked count, that is a harness bug and the report flags it — no number in
  that run is safe.
  DOM counts used to sit here; they moved to *Indicative* because `probe.js` runs in the page
  world and the blocked count is the only measurement a page cannot interfere with.
- **Compile success or failure, and rule counts.** Real WebKit compiled the real published
  bytes. A bucket that fails here would fail on the phone.
- **Contract verification.** Ed25519 signature, `keyId`, every payload hash and size, the URL
  allowlist, the 14-day age rule — all fifteen steps of CONTRACT §6, each recorded with its
  outcome. A failure here is the most important thing this repository can learn about itself,
  and it fails the job.
- **Page state.** A `challenged` label is a fact about what the runner was served.
- **The delta between modes within one scenario in one job.** Same device, same bundle, same
  minutes. The mode order alternates so warm DNS/TLS/CDN caches do not always favour the same
  mode: with `repeats ≥ 2` it reverses on even repeats, and at `repeats = 1` — the cron's
  setting and the workflow default — it reverses on odd-indexed scenarios instead, so each
  mode goes first about half the time **across the suite**. Within a single pair at
  `repeats = 1` the bias is *not* cancelled; `report.order` records exactly which alternation
  ran.
- **Spike verdicts of `pass` and `fail`** for API existence (`04-spike.md`). "Does this
  selector exist and fire" is a yes/no fact about the WebKit on that runtime.

### Indicative — read, do not act

- **DOM counts (`uniqueMatched` and `uniqueVisible`).** Deterministic queries over the loaded
  document, run in every frame, and the only measurement this harness has for the cosmetic
  buckets — `visible` is the one that matters, since an ad element left in the DOM with
  `display:none` is a cosmetic rule doing its job. They are *indicative* rather than
  trustworthy for one reason: `probe.js` runs in the **page world**, so a page can replace
  `window.__probe`, `console.error` or `window.open` after document start and change what is
  counted. Only the SPI-derived blocked count is page-proof. A count no frame answered is
  written as `null`, never `0`; `dom.framesAttempted` and `dom.frameErrors` say which frames
  went unanswered, and the phase evaluates at most the 64 newest frames under one wall clock.
- **`janus.active` scope.** The active rule list is granted the single wildcard pattern
  `*://*/*` rather than the surrogate pattern list the product uses (CONTRACT §8.6), so a
  redirect the real pattern set would not have authorised still fires here. Over-permissive by
  construction: read `janus.active` hits as an upper bound. `compile.activePatterns.scope`
  records the substitution.
- **All timings.** Compile ms, load ms, `_WKPageLoadTiming` values. A 3-vCPU virtualised M1
  with a cold disk cache is not a phone, and it is not even a consistent VM. The manifest's
  own `compileMs` says the same thing about itself (CONTRACT §4.4: "a relative cost hint for
  ordering the compile queue, never a phone estimate"). Use them to rank buckets, or to notice
  a 10× change, never as a number.
- **Observed-request counts and bytes.** A cross-origin resource without
  `Timing-Allow-Origin` reports `transferSize: 0`, so `transferBytesLowerBound` is exactly
  what its name says. Frames that never ran our script contribute nothing. The count is a
  good comparator between two modes in one run and a poor absolute.
- **Anything from a row whose `State` is not `ok`.** Reported, never discarded, never used to
  conclude something about filtering.
- **Absolute counts compared across jobs** taken on different runtimes, device types or days.
  Different viewport width alone changes lazy-loading and overlay area fractions.

### Not evidence — do not use these to decide anything

- **Popup counts.** ProbeHost's centre tap is **synthetic**: a dispatched pointer/click
  sequence with `isTrusted: false` and no user activation. Real popunders wait for a genuine
  gesture, so most of them never fire here. `0 popups` in mode `blocked` proves nothing about
  the popup shield, and the run's `tap.trusted: false` field says so. The JavaScript counter is
  also **page-defeatable**: it wraps `window.open` in the page world, and a page that replaces
  `window.open` afterwards is not counted. The native `createWebViewWith` count in the same
  record is the one WebKit cannot be talked out of; cross-check the two. Trusted taps need an
  XCUITest driver or the AXe CLI; that is FLASH SUPPRESSANT's territory, scheduled for M4,
  and it runs in the private probe (DESIGN 9.3). Popup counts are logged here because they
  are free and occasionally interesting, not because they mean anything yet.
- **Anything about media.** Simulator MSE/ManagedMediaSource availability and codec support
  differ from the phone; AV1 is hardware-only and the runners have no decoder. The spike
  *records* that difference (`04-spike.md` §3.5) precisely so nobody later mistakes a
  simulator result for a phone result.
- **Screenshots as a pass criterion.** They are evidence for a human, not a metric. No number
  in any report is derived from a pixel.
- **A single run of a live commercial site.** One sample from one IP on one morning.

---

## 5. Reading a summary in thirty seconds

1. **The header line.** Did the self-check pass, and did contract verification pass? If
   either says FAILED, stop; nothing below it is meaningful.
2. **Bundle version and age.** Which bundle was measured, and how old was it.
3. **`canyoublockit-extreme`.** The stable benchmark. `Ads visible` should be `0` in mode
   `blocked` and clearly non-zero in mode `none`; blocked should be comfortably over 20
   (DESIGN 9.3). If this row is healthy, the pipeline shipped something that works.
4. **The `State` column.** Every row that is not `ok` is advisory. Note which ones.
5. **The `Ads visible b/n` column** on the remaining rows. That is the product claim, in one
   column: what a person would have seen.
6. **The Flags section.** It names the things a reader should not have to derive:
   `zero-blocked-but-ads-visible`, `console-errors-higher-in-blocked`,
   `overlay-appeared-in-blocked`, `compile-failure`, `page-state-disagree`.
7. **"Not measured".** Which scenarios were skipped or failed, and why. An absent row is
   never an implied success.

---

## 6. Running it

```
# in the repo, on a Mac with Xcode 26.x
xcodegen generate --spec Tools/ProbeHost/project.yml
xcodebuild -project Tools/ProbeHost/ProbeHost.xcodeproj -scheme ProbeHost \
  -configuration Release -sdk iphonesimulator -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build

node Tools/ProbeRunner/run.mjs \
  --app build/DerivedData/Build/Products/Release-iphonesimulator/ProbeHost.app \
  --out build/probe/local --repeats 1

node Tools/ProbeRunner/report.mjs --report build/probe/local/report.json \
  --summary build/probe/local/summary.md --trend build/probe/local/trend.json
```

From a workstation, the usual route is not to run it at all but to dispatch it and fetch the
result:

```
gh workflow run live.yml -f repeats=1
gh run watch
gh run download <runId> -n probe-live-<runId>-1 -D <a local directory>
```

`--bundle-dir <path>` runs the whole suite against a bundle already on disk, with no network
fetch of the manifest — useful for measuring a bundle before it is published, and for a
reproducible re-run of a past result.

The suite costs a few free public-repo runner minutes and touches no secret: it verifies with
the **public** key already printed in `docs/CONTRACT.md` §5, and neither workflow declares an
environment.
