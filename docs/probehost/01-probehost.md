# ProbeHost — the app

Owner: group **app**. Consumers: group **runner** (launch contract, `run.json`), group **ci**
(`spike.json`). Read `00-index.md` §1 for why this is a plain app and not an XCTest target.

---

## 1. Shape

| Property | Value |
|---|---|
| Location | `Tools/ProbeHost/` |
| Project | XcodeGen `project.yml`; generated `ProbeHost.xcodeproj` is **not** committed |
| Bundle id | `io.github.mioutic.probehost` |
| Product | `ProbeHost.app`, simulator SDK only |
| Deployment target | iOS 17.0 |
| Device family | 1 (iPhone) |
| Dependencies | none. UIKit, WebKit, CryptoKit, Compression, Network, os — all from the SDK |
| Swift | language mode 5, `SWIFT_VERSION: "5.0"`, matching the repo's other Swift tools |
| Signing | `CODE_SIGNING_ALLOWED=NO`; it is never installed on a device |
| Info.plist | `NSAppTransportSecurity.NSAllowsLocalNetworking = true` (the fixture server on `127.0.0.1`; from iOS 17 ATS refuses IP literals by default — DESIGN 1.1 [A-ATS]). No other ATS relaxation. `UILaunchScreen` empty dictionary. `UIApplicationSceneManifest` with one `UIWindowSceneSessionRoleApplication` configuration named `Probe` whose delegate is `ProbeSceneDelegate`, and `UIApplicationSupportsMultipleScenes = false` **inside** it: an app linked against the iOS 26 SDK that does not adopt the UIScene life cycle is terminated at launch, and a terminated app writes no `run.json` and no `DONE`. |

ProbeHost draws one full-screen `WKWebView` in one window at the device's native size. There
is no chrome, no address bar and no user-facing control: it is an instrument, and a human who
launches it by hand sees exactly what CI sees.

**It is not the Janus app and must never borrow from it.** ProbeHost re-implements the parts
of `docs/CONTRACT.md` it needs, from the document. That duplication is the point: if
ProbeHost can consume the published bundle using nothing but the contract, the contract is
complete, and a divergence between the two implementations surfaces here rather than on a
phone.

---

## 2. Launch contract

Arguments are passed by `xcrun simctl launch` and read through the `NSArgumentDomain`
(`UserDefaults.standard`). Every key is `-ProbeXxx`; anything else is ignored. Unknown
`-Probe*` keys are a **usage error** (exit 64), so a typo in the runner cannot silently
produce a default run.

### 2.1 Arguments

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `-ProbeSuite` | `scenario` \| `spike` | — | **Required.** Which suite to run. |
| `-ProbeRunId` | string, `[A-Za-z0-9._-]{1,64}` | — | **Required.** Names the output directory. The runner makes it unique. |
| `-ProbeMode` | `blocked` \| `none` | `blocked` | Attach the compiled rule lists, or attach nothing. `scenario` suite only. |
| `-ProbeScenario` | container-relative path | `probe/in/scenario.json` | The single scenario to run. `scenario` suite only. |
| `-ProbeOut` | container-relative path | `probe/out/<runId>` | Where `run.json`, the PNGs and `run.log` go. |
| `-ProbeManifestUrl` | https URL | `https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json` | Entry point. Must satisfy CONTRACT §6 step 11. |
| `-ProbeBundleDir` | container-relative path | — | Offline mode: read `manifest.json`, `manifest.json.sig` and every payload from this directory instead of the network. Mutually exclusive with `-ProbeManifestUrl`. |
| `-ProbeFlavour` | `ios17` \| `ios26` \| `auto` | `auto` | `auto` applies CONTRACT §8.1 to the running OS major. An explicit value that contradicts the OS is honoured and recorded as a warning, because measuring the wrong flavour on purpose is a legitimate experiment. |
| `-ProbeFamilies` | csv of CONTRACT §4.4 families | all | Which bucket families to compile and attach. `active` is always included. |
| `-ProbeOptInLists` | csv of list ids | empty | Enables opt-in buckets per CONTRACT §8.2. |
| `-ProbeStepTimeoutMs` | int, 1000-180000 | `45000` | Per-step deadline. |
| `-ProbeBudgetMs` | int, 10000-900000 | `240000` | Whole-run deadline, compile included. On expiry the run is written with `harness.status: "budget"` and whatever was measured. |
| `-ProbeMaxRequests` | int, 100-20000 | `3000` | Cap on recorded resource entries; beyond it `requests.truncated` is true. |
| `-ProbeMaxConsole` | int, 0-2000 | `200` | Cap on recorded console entries. |
| `-ProbeScreenshots` | `0` \| `1` | `1` | Take the three viewport snapshots. |
| `-ProbeKeepStore` | `0` \| `1` | `0` | Keep the `WKContentRuleListStore` directory between runs. Default off, so every run is a cold compile and `compile.compileMs` means something. |
| `-ProbeFixturePort` | int, 0 or 1024-65535 | `0` | `0` lets the kernel choose. The chosen port is recorded and substituted into fixture URLs. |
| `-ProbeVerbose` | `0` \| `1` | `0` | Extra `run.log` detail. Never changes what is measured. |

### 2.2 Container paths

Everything is under the app's **data** container, reachable from the host as
`$(xcrun simctl get_app_container <udid> io.github.mioutic.probehost data)`.

```
Documents/probe/
  in/
    scenario.json          the one scenario for this launch (runner writes it)
    bundle/                optional offline bundle: manifest.json, manifest.json.sig, *.lzfse
  out/
    <runId>/
      run.json             the record of section 5 — written before DONE, always
      run.log              plain-text log, newest last
      <runId>-settle.png   viewport after load + idle
      <runId>-tap.png      viewport after the centre tap (only when the scenario taps)
      <runId>-end.png      viewport at the end of the run
      DONE                 zero-byte sentinel, written last, fsync'd
  store/<runId>/           WKContentRuleListStore directory, deleted unless -ProbeKeepStore
```

`run.json` is written **before** `DONE`, and `DONE` is written after the file handle is
closed and synced. The runner may therefore treat `DONE` as "`run.json` is complete and
parseable" without a retry loop on partial JSON.

If anything at all goes wrong, ProbeHost still writes a `run.json` — possibly one where
almost every section is null — and still writes `DONE`. A missing `DONE` means the process
died or hung, and nothing else.

### 2.3 Exit codes

| Code | Name | Meaning | Runner reaction |
|---:|---|---|---|
| 0 | ok | The run completed and `run.json` is written. **This includes every blocking outcome**: zero blocked requests, a page that never loaded, a bucket that failed to compile, a challenged page. | Record the measurement. |
| 64 | usage | Bad or missing arguments, unknown `-Probe*` key, unreadable scenario. | Do not retry. Fail the work item; the runner built the arguments, so this is a runner bug. |
| 65 | bundle | Contract verification failed (CONTRACT §6 step 2-15) or a payload hash mismatched. Nothing could be measured. | Do not retry. Fail the **job**: the published bundle is broken and that is the loudest thing this repo can learn. |
| 70 | internal | An unexpected error: WebKit process crash the app survived, an encoder failure, a filesystem error. | Retry once. |
| 73 | cantcreate | The output directory could not be created or written. | Do not retry; almost always a container-staging bug. |
| 75 | tempfail | The manifest or a payload could not be fetched: DNS, TLS, timeout, 5xx, 404 on `latest`. | Retry once, then record `harness.status: "network"`. |

The code is also written into `harness.exitCode`, because `simctl launch` does not report it
(`00-index.md` §1). `run.json` is the authority the runner reads; the code exists for a human
launching the app in a terminal with `--console-pty`.

**The rule, stated once:** a non-zero exit means *ProbeHost could not take a measurement*. It
never means *the filters performed badly*. Anything a site does — no ads, all ads, a
CAPTCHA, a crash of the web content process — is exit 0 with the facts recorded.

---

## 3. What one run does

A `scenario` run is a straight line. Each phase has its own deadline; a phase that expires is
recorded in `harness.timeouts` and the run continues to the next phase if it can.

1. **Parse** arguments (§2.1). Create `out/<runId>`. Open `run.log`. Start the wall clock.
2. **Fixture server** if the scenario's URL is `fixture:` — bind `127.0.0.1`, record the
   port, rewrite `fixture:/selftest.html` to `http://127.0.0.1:<port>/selftest.html`.
3. **Obtain the bundle.** Network (`-ProbeManifestUrl`, falling back to each `mirrors` entry
   in order on transport failure only) or disk (`-ProbeBundleDir`).
4. **Verify** it, CONTRACT §6 steps 1-15, in order, fail-closed, recording every step
   (§5.4). The pinned public key is compiled in; an unknown `keyId` is a rejection, never a
   fetch.
5. **Select** flavour and buckets: CONTRACT §8.1 and §8.2, narrowed by `-ProbeFamilies` and
   `-ProbeOptInLists`.
6. **Decompress and compile.** For each selected bucket in manifest order: verify
   `downloadSize`/`downloadSha256`, decompress, verify `size`/`sha256`, then compile with
   `WKContentRuleListStore(url:)` pointed at `store/<runId>`. Compilation is initiated **on
   the main actor, one bucket at a time** (CONTRACT §8.5; the iOS 26 crash Brave fixed in
   brave-core #31483). Identifier is `<bucket.id>.<sha8>`, verbatim. Decompression and
   hashing happen off-main; only the compile call hops to main. Record per-bucket
   `decompressMs`, `compileMs`, `ok`, `error`.
   In `-ProbeMode none` every payload is still fetched, hash-checked and decompressed — the
   `bundle` and `contract` numbers are identical between modes, which is itself a check — but
   the WebKit compile is **skipped** and nothing is attached. Compiling ~59 lists no page
   would ever see cost roughly 42 s per launch, twenty launches a suite, which is what pushed
   the tail of the scenario list into `skipped`/`budget`. Those buckets carry
   `compiled: false` and a null `compileMs`, and `compile.compileSkipped` counts them.
7. **Build the web view.** A fresh `WKWebViewConfiguration` per run with
   `WKWebsiteDataStore.nonPersistent()`, `allowsInlineMediaPlayback = true`,
   `mediaTypesRequiringUserActionForPlayback = .all`, the default iPhone user agent (no
   forgery), and a `WKUserContentController` carrying `probe.js` at
   `.atDocumentStart`, `forMainFrameOnly: false`. In `blocked` mode every compiled list is
   added to that controller. Delegates are constructed **before** they are assigned, because
   WebKit caches `respondsToSelector:` at assignment time.
8. **Navigate** to the scenario URL. Wait for `didFinish` or the step deadline, then for
   `waitIdleMs` of resource quiet (no new `resource` entry), whichever the scenario asks for.
9. **Classify the page** (`pageState`, §4.7) before anything else is counted.
10. **Scroll**, if the scenario asks: `n` steps of `dy` points with `pauseMs` between, driven
    by `evaluateJavaScript("window.scrollBy(...)")` and a settle wait. Lazy ad slots load on
    scroll; a feed measured without scrolling is not a feed.
11. **Snapshot** `settle`.
12. **Tap the centre**, if the scenario asks (§4.6). Snapshot `tap`.
13. **Count**: DOM selectors, overlays, console, requests, blocked actions — all read out of
    `probe.js` across every frame (§4).
14. **Snapshot** `end`.
15. **Write** `run.json`, close it, write `DONE`, `exit(code)`.

A `spike` run replaces steps 8-14 with `04-spike.md`.

---

## 4. What is measured, and how

Every number below states its mechanism, because the mechanism is what decides whether the
number can be trusted (`docs/PROBEHOST.md`).

### 4.1 Blocked requests — the primary number

`WKNavigationDelegate`'s private callback, declared with its exact Objective-C selector:

```swift
@objc(_webView:contentRuleListWithIdentifier:performedAction:forURL:)
func _contentRuleList(_ webView: WKWebView, identifier: String,
                      performedAction action: NSObject, forURL url: URL)
```

WebKit calls it once per matching list per load (iOS 13+,
`WKNavigationDelegatePrivate.h`). Action flags are read defensively —
`action.responds(to: NSSelectorFromString(key))` then KVC — so a WebKit release that drops a
property yields `false`, never a crash: `blockedLoad`, `blockedCookies`, `madeHTTPS`,
`redirected`, `modifiedHeaders`, `notifications` (the last two are iOS 16+).

Counted per rule-list identifier, per host and per registrable domain. Because the identifier
carries the bucket id as a prefix (CONTRACT §8.5), `blocked.byFamily` follows for free.

Two separate facts, because conflating them made a healthy run read as a broken one:
`blocked.spi.selectorPresent` is `responds(to:)` on the private selector — an availability
fact, true in `-ProbeMode none` as well — and `blocked.spi.fired` is whether a callback
actually arrived in this run. In `-ProbeMode none` the expected fired count is exactly zero; a
non-zero count there is a harness bug and is raised as `harness.warnings`.

`blocked.total` counts **callbacks**, and WebKit calls the delegate once per matching list per
load: with ~59 overlapping shards attached, one blocked URL arrives several times.
`blocked.distinctUrls` — distinct query-stripped URLs with `blockedLoad` — is the count the
report headlines as "requests blocked", which is why each `BlockedAction` keeps the URL.

`notifications` is an `NSArray<NSString *>`, not a BOOL: it is read as `[String]` and reported
as `blocked.notifications.{actions,distinct,sample}`, while the five genuine BOOL properties
stay on the `NSNumber` path.

WebKit only notifies this delegate for network-level results. `css-display-none` produces no
callback at all, so `blocked.byFamily` can never contain `cos.generic` or `cos.specific` and
`blocked.total` is a lower bound on what the lists did. The record says so in
`blocked.spi.coversCosmetic: false`; the cosmetic families' evidence is `dom.uniqueVisible`.

### 4.2 Observed requests — the cross-check

`probe.js` installs `PerformanceObserver({type:'resource', buffered:true})` in every frame at
document start and posts batches to `webkit.messageHandlers.probe`. Each message is stamped
with `WKScriptMessage.frameInfo.securityOrigin` and `frameInfo.isMainFrame`, so cross-origin
ad iframes are counted and attributed.

Per entry: host, `initiatorType`, `transferSize`, `duration`, frame origin. Entry **URLs are
reduced to scheme + host + path**; query strings are dropped before recording, so a run
artifact cannot carry an identifier a site put in a URL.

Known limits, recorded rather than hidden: a cross-origin resource without
`Timing-Allow-Origin` reports `transferSize: 0` and an opaque duration, so
`requests.transferBytes` is a **lower bound**; a request a content rule blocked usually never
becomes a resource entry at all, which is exactly why the blocked count comes from §4.1 and
this section is the cross-check, not the source.

### 4.3 Main-frame navigations and redirects

`decidePolicyFor navigationAction` (main frame only), `didReceiveServerRedirectForProvisionalNavigation`,
`didCommit`, `didFinish`, `didFail*`. Recorded per commit: URL (query stripped), ms from
navigation start, `navigationType`, and whether the target's registrable domain differs from
the requested one. A cross-eTLD+1 main-frame navigation that was not `linkActivated` and
lands within 1.5 s of the tap is flagged `suspectedRedirect: true` — evidence for M4, counted
here because it is free.

Active action patterns for `janus.active` are set in
`webView(_:decidePolicyFor:preferences:decisionHandler:)` on **every** navigation, main frame
and subframes alike (CONTRACT §8.6, DESIGN 1.1 [V-ae]), from the pattern set derived from
`payloads.siteFix`. `navigation.activePatternsSet` records how many navigations got them, so
a regression here cannot hide.

### 4.4 Popups attempted

Two independent counters, never summed:

- **Native:** `WKUIDelegate.webView(_:createWebViewWith:for:windowFeatures:)`. Records the
  target URL (query stripped), the source frame origin, `windowFeatures`, and ms from the
  tap. ProbeHost returns `nil` — it never opens a second web view — so a count here means
  "the page asked WebKit for a window and WebKit agreed to ask us".
- **Page world:** `probe.js` wraps `window.open` and records each call with the URL and
  `navigator.userActivation.isActive` at call time.

The difference between the two is informative: a `window.open` that never reaches the UI
delegate was suppressed by WebKit's own popup blocker, not by anything Janus did.

### 4.5 JavaScript dialogs

`runJavaScriptAlertPanel`, `runJavaScriptConfirmPanel`, `runJavaScriptTextInputPanel`. Each
is recorded (kind, message truncated to 200 chars, frame origin, ms) and then **dismissed
immediately** with the neutral answer (`()`, `false`, `nil`) so a dialog loop cannot stall a
run. `dialogs` is capped at 50; beyond that `dialogsTruncated` is set and further dialogs are
dismissed silently.

### 4.6 DOM counts, overlays, console

- **DOM counts.** For each selector in the scenario's list, in every frame:
  `total` = `querySelectorAll(sel).length`; `visible` = of those, the ones with
  `getClientRects().length > 0`, `display !== 'none'`, `visibility !== 'hidden'` and
  `opacity >= 0.1`. An invalid selector records an `error` string and counts zero — it never
  throws. **`visible` is the number that matters**: a cosmetic rule that leaves the element
  in the DOM with `display:none` is a success, not a failure.
- **Large fixed overlays.** Elements whose computed `position` is `fixed` or `sticky`, whose
  bounding rect covers ≥ 25 % of the viewport, that pass the same visibility test, and that
  are not `html`/`body`. Recorded: tag, id, first two classes, `areaFraction`, `zIndex`,
  width, height. Capped at 10. This is the anti-adblock / consent-wall / interstitial
  detector, and it is why a run with zero visible ad elements is not automatically a win.
- **Console.** `console.error` and `console.warn` wrapped, plus `window.onerror` and
  `unhandledrejection`, plus `securitypolicyviolation` (free, and useful ahead of the M3
  `$csp` work). Level, text truncated to 300 chars, frame origin, ms. Capped at
  `-ProbeMaxConsole`.
- **The centre tap.** `probe.js` resolves `document.elementFromPoint(cx, cy)` at the viewport
  centre and dispatches `pointerdown`, `mousedown`, `mouseup`, `click` with
  `bubbles: true, cancelable: true`, then calls `.click()` on the nearest anchor if one is
  under the point. It is **not trusted** — `isTrusted` is `false` and no user activation is
  granted — and `tap.trusted: false` says so in every run. See `00-index.md` §1.

### 4.7 Page state

Before counting anything, the run classifies what it is actually looking at, using the
`pageState` matchers committed in `config/scenarios.json` (selectors and case-insensitive
text fragments, both data, never code):

| `pageState` | Meaning |
|---|---|
| `ok` | The page under test. |
| `challenged` | A bot check, rate limit, or "verify you are human" interstitial. |
| `login-wall` | The content requires a session. |
| `consent-wall` | A GDPR/CCPA consent modal is blocking the content. |
| `error` | An HTTP error page, a navigation failure, or the web content process terminated. |
| `unknown` | The matchers were inconclusive. |

Every number from a run whose `pageState` is not `ok` is reported, never discarded, and the
summary marks it. A datacentre egress earns these states honestly and often (`00-index.md`
§5); pretending otherwise would be the only real failure.

### 4.8 Timing

`navigation.loadMs` (navigation start to `didFinish`) and `navigation.commitMs`. Plus the
guarded `_webView:didGeneratePageLoadTiming:` SPI when present, read with the same
`responds(to:)` + KVC discipline. Every one of these is **indicative only** on a 3-vCPU
virtualised M1 (`docs/PROBEHOST.md` §4); they exist for the blocked-vs-none delta within one
job, not for absolute numbers across jobs.

---

## 5. `run.json` — the exact schema

`schemaVersion: 1`. Additive changes bump it; a consumer ignores fields it does not know.
Every duration is integer milliseconds, every size is bytes, every timestamp is RFC 3339
UTC with second precision, every hash is lower-case hex. `null` means "not measured"; `0`
means "measured, and it was zero". The distinction is load-bearing.

```jsonc
{
  "schemaVersion": 1,

  "run": {
    "id": "reddit-popular-blocked-1",
    "suite": "scenario",                  // "scenario" | "spike"
    "scenarioId": "reddit-popular",
    "mode": "blocked",                    // "blocked" | "none"
    "repeat": 1,
    "order": ["blocked", "none"],         // this repeat's mode order, for warm-cache bias
    "startedAt": "2026-09-15T05:12:44Z",
    "endedAt":   "2026-09-15T05:13:29Z",
    "durationMs": 45012
  },

  "host": {
    "osVersion": "26.4",
    "osMajor": 26,
    "model": "iPhone17,2",
    "deviceName": "iPhone 16 Pro Max",
    "simulator": true,
    "locale": "en_US",
    "timeZone": "UTC",
    "appVersion": "1.0",
    "appBuild": "1",
    "viewport": { "width": 440, "height": 956, "scale": 3 },
    "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) …"
  },

  "bundle": {
    "source": "network",                  // "network" | "disk"
    "origin": "release",                  // "release" | "mirror" | "disk"
    "manifestUrl": "https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json",
    "contractVersion": 1,
    "schemaVersion": 1,
    "layoutVersion": 1,
    "version": 2026091300,
    "issuedAt": "2026-09-13T04:31:07Z",
    "ageHours": 49,
    "keyId": "d6ff9fb88ae9b930",
    "flavour": "ios26",
    "flavourAuto": true,
    "generator": { "pipeline": "janus-filters@1", "safariConverterLib": "4.3.0" },
    "manifestSha256": "…",
    "killSwitches": { "listSuppliedJavaScript": true, "…": true }
  },

  "contract": {
    "ok": true,
    "steps": [                            // CONTRACT section 6, in order, one entry each
      { "step": 1,  "name": "download-manifest",   "ok": true, "ms": 412, "detail": "18422 bytes" },
      { "step": 2,  "name": "decode-signature",    "ok": true, "ms": 0 },
      { "step": 3,  "name": "select-pinned-key",   "ok": true, "ms": 0, "detail": "d6ff9fb88ae9b930" },
      { "step": 4,  "name": "verify-signature",    "ok": true, "ms": 3 },
      { "step": 5,  "name": "parse",               "ok": true, "ms": 6 },
      { "step": 6,  "name": "contract-version",    "ok": true, "ms": 0 },
      { "step": 7,  "name": "min-app-build",       "ok": true, "ms": 0 },
      { "step": 8,  "name": "version-monotonic",   "ok": true, "ms": 0, "detail": "no installed baseline" },
      { "step": 9,  "name": "age",                 "ok": true, "ms": 0, "detail": "49h" },
      { "step": 10, "name": "clock-skew",          "ok": true, "ms": 0 },
      { "step": 11, "name": "url-allowlist",       "ok": true, "ms": 0, "detail": "1 base, 1 mirror" },
      { "step": 12, "name": "payload-download-size","ok": true, "ms": 9140, "detail": "59 files" },
      { "step": 13, "name": "payload-download-hash","ok": true, "ms": 380 },
      { "step": 14, "name": "decompress-size",     "ok": true, "ms": 1120 },
      { "step": 15, "name": "decompress-hash",     "ok": true, "ms": 640 }
    ],
    "failedStep": null,                   // int when ok is false
    "failureReason": null
  },

  "compile": {
    "storeFresh": true,
    "attached": 59,                       // 0 in mode "none"
    "failed": 0,
    "compiledLists": 59,                  // 0 in mode "none": the compile is skipped there
    "compileSkipped": 0,
    "totalMs": 41880,
    "buckets": [
      { "id": "janus.net.ads.00", "family": "net.ads",
        "identifier": "janus.net.ads.00.3f0a1c2d",
        "ruleCount": 72311, "size": 9402117, "downloadSize": 1450992,
        "downloadMs": 210, "decompressMs": 48, "compileMs": 4188,
        "ok": true, "error": null, "attached": true }
    ],
    "activePatterns": { "list": "janus.active.22334455", "patternCount": 96 }
  },

  "navigation": {
    "requestedUrl": "https://www.reddit.com/r/popular/",
    "finalUrl": "https://www.reddit.com/r/popular/",
    "didFinish": true,
    "commitMs": 1840, "loadMs": 6120, "idleMs": 2500,
    // attempts, not commits: this comes from the policy callback, which fires before
    // anything is committed. `committed` is filled in from didCommit.
    "attempts": [ { "url": "https://www.reddit.com/r/popular/", "ms": 1840,
                    "navigationType": "other", "crossSite": false,
                    "suspectedRedirect": false, "committed": true } ],
    "attemptsCommitted": 1,
    "serverRedirects": [],
    "activePatternsSet": 7,
    "webContentTerminated": false,
    "failure": null                       // { "code": -1009, "domain": "NSURLErrorDomain", "ms": 0 }
  },

  "pageState": { "state": "ok", "matched": [], "title": "reddit", "httpStatus": 200 },

  "requests": {
    "observed": 214, "truncated": false,
    "transferBytesLowerBound": 3120044,
    "byType": { "script": 61, "img": 88, "css": 9, "fetch": 31, "xmlhttprequest": 14, "other": 11 },
    "frames": 7, "thirdPartyHosts": 23,
    "hosts": { "www.reddit.com": 104, "styles.redditmedia.com": 22 },
    "entries": [ { "u": "https://www.reddit.com/svc/shreddit/feed",
                   "t": "fetch", "b": 4120, "d": 210, "f": "https://www.reddit.com", "m": true } ]
  },

  "blocked": {
    "total": 37,                            // rule-list ACTIONS: once per matching list per load
    "distinctUrls": 21,                     // the headline: distinct URLs whose load was stopped
    "distinctUrlsAnyAction": 24,
    "spi": { "selectorPresent": true,       // responds(to:) - true in mode none too
             "fired": true,                 // a callback arrived in THIS run
             "coversCosmetic": false,       // css-display-none is never reported to the app
             "coversNetworkOnly": true,
             "selector": "_webView:contentRuleListWithIdentifier:performedAction:forURL:" },
    "notifications": { "actions": 0, "distinct": 0, "sample": [] },
    "byAction": { "blockedLoad": 34, "blockedCookies": 3, "madeHTTPS": 0,
                  "redirected": 0, "modifiedHeaders": 0, "notifications": 0 },
    "byFamily": { "net.ads": 28, "net.privacy": 9, "net.security": 0, "active": 0 },
    "byList": { "janus.net.ads.00.3f0a1c2d": 28, "janus.net.privacy.00.a1b2c3d4": 9 },
    "byHost": { "events.reddit.com": 12, "doubleclick.net": 9 },
    "unexpected": false                   // true when mode is "none" and total > 0
  },

  // null, never 0, when no frame answered: "ads visible 0" from a count that never ran
  // is the one reading this record must never support.
  "dom": {
    "totalMatched": 14, "totalVisible": 0,       // summed per selector; overlapping selectors double-count
    "uniqueMatched": 11, "uniqueVisible": 0,     // distinct nodes, frames the page hid discounted
    "selectors": [ { "selector": "shreddit-ad-post", "total": 6, "visible": 0, "error": null } ],
    "frames": 7, "framesAttempted": 9, "frameErrors": [ { "frame": "https://ads.example", "error": "no answer" } ],
    "msSinceNavigationStart": 9120
  },

  // The array is a capped sample; overlaysSummary carries the count, per the rule that a
  // capped array always has its truncation flag beside it.
  "overlays": [
    { "tag": "div", "id": "", "class": "consent-modal",
      "areaFraction": 0.86, "zIndex": 2147483647, "width": 440, "height": 820,
      "position": "fixed" }
  ],
  "overlaysSummary": { "seen": 1, "kept": 1, "truncated": false, "msSinceNavigationStart": 9180 },

  "popups": {
    "native": [ { "url": "https://example-ad.test/lp", "sourceOrigin": "https://gofile.io",
                  "ms": 9120, "features": "popup=1,width=800" } ],
    "js":     [ { "url": "https://example-ad.test/lp", "ms": 9118, "userActivation": false } ],
    "nativeCount": 1, "jsCount": 1
  },

  "dialogs": [ { "kind": "alert", "message": "…", "origin": "https://gofile.io", "ms": 10240 } ],
  "dialogsTruncated": false,

  "console": [ { "level": "error", "text": "…", "origin": "https://www.reddit.com", "ms": 5120 } ],
  "consoleTruncated": false,
  "consoleErrors": 3,

  "tap": {
    "requested": true, "performed": true,
    "method": "synthetic", "trusted": false,
    "x": 220, "y": 478,
    "targetTag": "div", "targetOrigin": "https://gofile.io",
    "userActivationAfter": false,
    "ms": 9008
  },

  "scroll": { "requested": 6, "performed": 6, "dy": 800, "finalScrollY": 4712 },

  "screenshots": [
    { "name": "settle", "file": "reddit-popular-blocked-1-settle.png",
      "ms": 8620, "width": 440, "height": 956, "bytes": 184220 }
  ],

  "timing": {
    "pageLoadTimingSpi": null,            // object when _WKPageLoadTiming is present
    "navigationStartMs": 0, "firstCommitMs": 1840, "didFinishMs": 6120
  },

  "harness": {
    "status": "ok",                       // ok | usage | bundle | internal | network | budget | timeout
    "exitCode": 0,
    "timeouts": [],                       // [{ "phase": "idle", "budgetMs": 2500 }]
    "warnings": [],
    "errors": [],
    "probeScriptFrames": 7,
    "fixturePort": null
  }
}
```

### 5.1 Field rules

- **Unknown fields are ignored by consumers.** The runner reads named fields and copies
  `harness` verbatim; it never fails on an addition.
- **No query strings, ever.** Every URL recorded anywhere in `run.json` is truncated at the
  `?`. The runner and the summary never reverse that.
- **Caps are declared.** Any capped array has a sibling `…Truncated` boolean or a `truncated`
  field on its container. A truncated count is still a lower bound, never a guess.
- **`blocked.distinctUrls` is the headline** and comes from one mechanism only (§4.1);
  `blocked.total` is the raw callback count beside it. Neither is ever derived from
  `requests`.
- **`run.json` is written even on exit 64**, with almost everything `null`, so the runner
  always has a machine-readable reason.
