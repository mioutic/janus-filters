# The M0 capability spike

Owner: **app** for the probes themselves and `spike.json`; **ci** for `spike.yml` and the
summary. These are the M0 items that cannot be answered anywhere but a real simulator
(MILESTONES M0, DESIGN 10.2, DESIGN 1.3 "to verify").

The spike answers questions. It does not measure blocking, it touches no live site, and it
fails no job for a `fail` verdict — a probe that says "this SPI is gone" is the spike working
perfectly.

---

## 1. Ground rules

1. **Offline.** Every probe runs against ProbeHost's own fixture server on `127.0.0.1`
   (`01-probehost.md` §1, `NSAllowsLocalNetworking`) or against `about:blank`. A spike that
   depends on a public site would report the internet's mood, not WebKit's behaviour.
2. **Guarded.** Every private selector is reached through `responds(to:)` or
   `NSSelectorFromString` plus KVC. A missing selector produces `unknown` or `fail`, never a
   crash. This is DESIGN principle 1 applied to the harness itself.
3. **Per runtime.** `spike.yml` runs the whole set once per installed iOS runtime with major
   ≥ 17, because the answers differ by WebKit version and the point is to know *where* they
   differ.
4. **`unknown` is a real answer** and is never dressed up as `pass` or `fail` (§4).
5. **Evidence, not adjectives.** Every verdict carries a structured `evidence` object a human
   can re-read in six months without the code in front of them.

---

## 2. `spike.json`

One file per runtime, written to the same container path as a scenario run, with the same
`DONE` discipline.

```jsonc
{
  "schemaVersion": 1,
  "suite": "spike",
  "runId": "spike-26-4",
  "startedAt": "2026-09-15T05:41:02Z",
  "endedAt": "2026-09-15T05:42:55Z",
  "host": { "osVersion": "26.4", "osMajor": 26, "model": "iPhone17,2",
            "deviceName": "iPhone 16 Pro Max", "webkitBuild": null,
            "userAgent": "…" },
  "fixturePort": 51734,
  "probes": [
    {
      "id": "rule-list-action-callback",
      "title": "Does _webView:contentRuleListWithIdentifier:performedAction:forURL: fire?",
      "verdict": "pass",                 // pass | fail | unknown | skipped
      "ms": 1420,
      "evidence": {
        "selectorPresent": true,
        "callbackCount": 1,
        "identifier": "spike.block.0",
        "url": "http://127.0.0.1:51734/blocked.js",
        "actionProperties": { "blockedLoad": true, "blockedCookies": false,
                              "madeHTTPS": false, "redirected": false,
                              "modifiedHeaders": false, "notifications": false },
        "missingProperties": [],
        "controlRequestLoaded": true
      },
      "reason": null
    }
  ],
  "harness": { "status": "ok", "exitCode": 0, "errors": [], "warnings": [] }
}
```

`probes[]` order is fixed and every probe is always present, even when `skipped` — a probe
that vanishes from the output is indistinguishable from a probe nobody wrote.

---

## 3. The probes

Six. Five are the M2c scope items; the sixth (`active-action-patterns`) is added because
DESIGN 10.2 lists it under `spike.yml` and CONTRACT §8.6 makes `janus.active` depend on it,
so leaving it unanswered would let a contract clause go untested.

### 3.1 `installed-runtimes` — runner-side

**Question:** which simulator runtimes and iPhone device types exist on this image?
(DESIGN 1.3: "Installed simulator runtimes on macos-26"; if false, `live.yml` uses what
exists and downloads nothing.)

**API:** `xcrun simctl list -j runtimes devicetypes` — this one probe runs in the **runner**,
not the app, and its record is merged into `spike-report.json` rather than into a per-runtime
`spike.json`.

**Evidence:** every available runtime (`version`, `identifier`, `buildversion`,
`supportedDeviceTypes` reduced to iPhone entries), every iPhone device type, plus
`xcodebuild -version` and the runner image label.

**Verdicts:** `pass` when at least one iOS runtime with major ≥ 17 and one iPhone device type
usable with it exist. `fail` when none do — `live.yml` cannot run at all. Never `unknown`:
`simctl list` either answered or the step failed.

### 3.2 `rule-list-action-callback`

**Question:** does the private rule-list action callback fire, and which action properties
does this WebKit expose? Everything M2c calls a "blocked request" depends on it
(`01-probehost.md` §4.1).

**API:**
`-[id<WKNavigationDelegate> _webView:contentRuleListWithIdentifier:performedAction:forURL:]`
(`WKNavigationDelegatePrivate.h`, macOS 10.15 / iOS 13), with `_WKContentRuleListAction`
read by `responds(to:)` + KVC for `blockedLoad`, `blockedCookies`, `madeHTTPS`,
`notifications`, `redirected`, `modifiedHeaders` (the last two iOS 16+).

**Method:** compile a two-rule list — `block` on `/blocked\.js` and nothing else — attach it,
and load `http://127.0.0.1:<port>/spike-block.html`, which requests both `blocked.js` (must
be blocked) and `allowed.js` (must load, and sets `window.__allowed = true`). The delegate is
constructed before it is assigned, because WebKit caches `respondsToSelector:` at assignment.

**Verdicts:**

| Verdict | When |
|---|---|
| `pass` | The callback fired at least once with `blockedLoad == true` for the blocked URL, **and** the control request loaded. |
| `fail` | The selector is present and the control loaded, but no callback arrived for a request the page demonstrably never received. |
| `unknown` | The selector is absent, the control request also failed (so nothing can be concluded about blocking), the list did not compile, or the fixture page never loaded. |

`missingProperties` lists any of the six the action object did not respond to; that alone
never changes the verdict, because `01-probehost.md` §4.1 already degrades to `false`.

### 3.3 `active-action-patterns`

**Question:** does `WKWebpagePreferences._activeContentRuleListActionPatterns` exist, and do
`redirect` actions fire only when a matching pattern is set? CONTRACT §8.6 and DESIGN 1.1
[V-ae] both depend on the answer.

**API:** `WKWebpagePreferences` `_activeContentRuleListActionPatterns`
(`NSDictionary<NSString *, NSSet<NSString *> *>`, iOS 16+), set in
`webView(_:decidePolicyFor:preferences:decisionHandler:)`.

**Method:** compile a list whose single rule redirects `/redirect-me.js` to
`/redirected.js` (which sets `window.__redirected = true`). Load the fixture **twice**: once
with no patterns set, once with the pattern set for that list identifier — on **every**
navigation, main frame and subframes alike, because WebKit checks the initiating frame's own
`DocumentLoader`. The fixture includes a same-document iframe that makes the same request, so
the subframe case is covered, and both frames report separately.

**Verdicts:** `pass` — no redirect without the pattern, redirect with it, in both frames.
`fail` — the property exists but the behaviour differs (redirect without a pattern, or no
redirect with one); `evidence.frames` says which frame. `unknown` — the property is absent
(`responds(to:)` false), or the list did not compile.

### 3.4 `media-pref-next-navigation`

**Question:** does changing `webView.configuration.preferences` apply from the next main-frame
navigation, or does the web view have to be recreated? (DESIGN 1.3; if false, §5.3's recreate
path is mandatory.)

**API:** `WKPreferences` `_mediaSourceEnabled` and `_managedMediaSourceEnabled`, set by
`setValue(_:forKey:)` after a `responds(to:)` check on the getter, mirroring the `typeof`
assertions DESIGN 5.3 specifies.

**Method:** three stops on the fixture `media.html`, which reports
`typeof MediaSource`, `typeof ManagedMediaSource` and `MediaSource?.isTypeSupported` on load
and posts them back:

1. **NATIVE** — both prefs false; navigate; record.
2. **DESKTOP-MSE** — set both true on the *existing* configuration; navigate; record.
3. **back to NATIVE** — set both false; navigate; record.

**Verdicts:** `pass` — the reported `typeof` values change at stop 2 and change back at stop
3, with no web view recreation. `fail` — the values do not change, i.e. the preference is
per-web-view and the recreate path is required. `unknown` — the SPI keys are absent, the
fixture did not load, or the simulator reports the type as absent in **every** state, which
makes the experiment blind (see §3.5: MSE is frequently absent in the simulator, and this
probe is designed to notice that rather than report a false `fail`).

### 3.5 `media-source-availability`

**Question:** what does the simulator actually expose? `MediaSource`, `ManagedMediaSource`,
native HLS, and which codecs. Simulator media capability differs from the phone (research:
`Hls.isSupported()` returned false on the iOS 17.2 simulator; AV1 is hardware-only and the
M1 runners have no AV1 decoder), so this probe exists to record the **difference**, which is
what stops a later video suite from reading simulator results as phone truth.

**API, all public, evaluated in the page:**

```js
{
  mediaSource:        'MediaSource' in window,
  managedMediaSource: 'ManagedMediaSource' in window,
  hlsNative:          document.createElement('video').canPlayType('application/vnd.apple.mpegurl'),
  avc:  MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
  hvc:  MediaSource?.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'),
  av01: MediaSource?.isTypeSupported('video/mp4; codecs="av01.0.05M.08"'),
  mmsAvc: ManagedMediaSource?.isTypeSupported?.('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')
}
```

**Verdicts:** this probe is a **capability report**, so `pass` means only "the page answered
and the answers were recorded". `unknown` means the fixture never ran. It is never `fail` —
"the simulator has no AV1" is a fact about the runner, not a defect, and encoding it as a
failure would train a reader to ignore a red cell.

### 3.6 `page-load-timing-spi`

**Question:** does `_WKPageLoadTiming` exist, and does
`_webView:didGeneratePageLoadTiming:` fire? (DESIGN 1.3, believed iOS 18.2+; if false, fall
back to Navigation Timing.)

**API:** `-[id<WKNavigationDelegate> _webView:didGeneratePageLoadTiming:]`, with the timing
object read by `responds(to:)` + KVC for `navigationStart`, `firstVisualLayout`,
`firstMeaningfulPaint`, `documentFinishedLoading`, `allSubresourcesFinishedLoading`.

**Method:** load the fixture page and wait up to 10 s past `didFinish`.

**Verdicts:** `pass` — the callback fired and at least `navigationStart` plus one other
property was readable; the evidence records every property present and the values as ms
offsets. `fail` — a same-run Navigation Timing readout succeeded (proving the page loaded)
but the callback never fired within the window. `unknown` — the page did not load, so nothing
can be said.

Note for whoever reads the numbers: even a `pass` here yields *indicative* timings on a
3-vCPU virtualised M1 (`docs/PROBEHOST.md` §4). The probe answers "does the API exist", which
is a yes/no fact and is trustworthy; the milliseconds it returns are not.

---

## 4. What the verdicts mean

| Verdict | Meaning | Never used for |
|---|---|---|
| `pass` | The probe ran end to end and the behaviour matched the claim under test. | A claim the probe did not actually exercise. |
| `fail` | The probe ran end to end, the control condition held, and the behaviour contradicted the claim. | An inconclusive run. |
| `unknown` | The probe could not decide. **This is a first-class answer.** | Filling in an assumed value. |
| `skipped` | The probe was not attempted: not applicable to this runtime, or excluded by `--probes`. | A probe that crashed — that is `unknown`. |

**`unknown` is required** whenever any of these holds: the selector or property is absent; the
fixture page did not load; the control condition failed, so the experimental condition proves
nothing; the rule list did not compile; the phase timed out; or two observations contradict
each other. Every `unknown` carries a `reason` string naming which of these it was.

The rule exists because a guess here is worse than silence. DESIGN 1.3 says "nothing below is
relied on until it passes" — an `unknown` correctly leaves the claim unrelied-on, while a
guessed `pass` would let a whole feature be built on nothing, and a guessed `fail` would
retire a lever that works.

A probe is never marked `fail` for the *environment*: an absent codec, a missing runtime, a
device type that could not be created — those are `unknown` or `skipped` with the reason.

---

## 5. `spike.yml` and its output

**Trigger:** `workflow_dispatch` only (inputs: `runtime` defaulting to `all`, `probes`
defaulting to all). No cron: these answers change when an iOS major ships, not weekly.
`runs-on: macos-26`, `timeout-minutes: 40`, `permissions: contents: read`, no environment, no
secrets.

**Steps:** checkout, `xcode-select` 26.6, Node 24, `npm ci`, pinned XcodeGen + sha256 check,
`xcodegen generate`, `xcodebuild … -sdk iphonesimulator build` — identical to `live.yml`
steps 1-5, and the DerivedData cache key is shared, so a spike after a live run builds in
seconds.

Then `node Tools/ProbeRunner/run.mjs --suite spike --runtime all`, which records
`installed-runtimes` from `simctl list`, then for each available iOS runtime (major ≥ 17)
creates a device, boots it, launches `-ProbeSuite spike -ProbeRunId spike-<runtime>`, waits
for `DONE`, collects `spike.json`, and shuts that device down before creating the next.

**`spike-report.json`** carries `environment`, the runner-side `installed-runtimes` probe, and
`runtimes: [{ runtime, deviceType, probes: [...] }]`.

**Job summary** — the matrix, probes down, runtimes across:

```markdown
## M0 capability spike — macos-26 / Xcode 26.6

Installed iOS runtimes: **26.2, 26.4, 26.5** · device type **iPhone 16 Pro Max**

| Probe | 26.2 | 26.4 | 26.5 |
|---|:--:|:--:|:--:|
| rule-list-action-callback | pass | pass | pass |
| active-action-patterns | pass | pass | unknown |
| media-pref-next-navigation | fail | fail | fail |
| media-source-availability | pass | pass | pass |
| page-load-timing-spi | pass | pass | pass |

**unknown** and **fail** in detail

- `active-action-patterns` on 26.5 — unknown: the redirect fixture list did not compile
  (`JSONInvalidRegex`). Nothing can be concluded; rerun after fixing the fixture.
- `media-pref-next-navigation` on 26.2/26.4/26.5 — fail: `typeof ManagedMediaSource` did not
  change across stops. DESIGN 5.3's recreate path is required.

Capability report (`media-source-availability`): MediaSource **absent**, ManagedMediaSource
**absent**, native HLS `probably`, AV1 unavailable — expected on a virtualised M1 runner and
**not** a statement about the phone.

Artifact `probe-spike-1234567890` · verdict meanings: `docs/probehost/04-spike.md` §4
```

**Job outcome:** green whenever every probe produced a verdict. The job fails only if the
harness failed — no runtime could be booted, the app would not install, or a `spike.json` was
missing or unparseable. A grid full of `fail` is a successful spike that delivered bad news,
and the workflow must not punish that.

**Feeding the answers back.** Each verdict maps to one row of DESIGN 1.3's "to verify" table
or one M0 acceptance bullet. The summary is the evidence; updating DESIGN and MILESTONES with
what the spike found is a human's job in the private repo, and nothing in this repository
writes to either.
