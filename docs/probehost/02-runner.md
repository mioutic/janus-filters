# The step runner

Owner: group **runner**. Consumes the launch contract and `run.json` (`01-probehost.md`).
Produces `report.json` (`03-report.md`) and the artifact tree. Node 24, ESM, no dependencies
beyond the Node standard library — the repo already forbids adding npm packages lightly, and
this one needs none.

Entry point: `Tools/ProbeRunner/run.mjs`. It runs on macOS in CI. It is the **only** code in
the repository that shells out to `xcrun`, and the only code that knows a simulator exists.

---

## 1. Responsibilities, in one list

1. Choose a runtime and a device type from what is actually installed. Never download one.
2. Create and boot exactly one simulator, and remember its UDID.
3. Install `ProbeHost.app`.
4. Gate on `selftest-local`.
5. For every (scenario, repeat, mode) work item: stage input, launch, wait, collect.
6. Merge everything into `report.json`.
7. Shut down the device it created, and nothing else.

It never builds the app (the workflow does), never uploads anything (the workflow does), and
never decides whether a blocking number is good (`report.mjs` and a human do).

---

## 2. Simulator selection and boot

### 2.1 Choosing a runtime

```
xcrun simctl list -j runtimes devicetypes devices
```

Candidates are runtimes where `isAvailable === true` and `platform === "iOS"` (older Xcode
spells this `identifier` prefix `com.apple.CoreSimulator.SimRuntime.iOS-`; match on both).

| Input | Behaviour |
|---|---|
| `--runtime 26.4` | Exact match on the runtime version. Not installed: **exit 2** with the installed list printed. Never a silent substitution. |
| `--runtime newest` (default) | Highest available iOS version with major ≥ 17. |
| `--runtime all` (spike only) | Every available iOS runtime with major ≥ 17, one device each, in ascending order. |

Measured facts this must tolerate (DESIGN 1.1 [REPO], and re-checked by `spike.yml` on every
iOS major): `macos-26` carries iOS runtimes **26.2, 26.4, 26.5**; `macos-15` carries **18.5
through 26.2**. `live.yml` therefore defaults to `newest` on `macos-26` and records exactly
what it got — it never hard-codes a version, and it never runs `simctl runtime add`, which
would cost minutes and could fail.

### 2.2 Choosing a device type

From the chosen runtime's `supportedDeviceTypes`, take the first match in this preference
order, skipping any that is absent:

```
iPhone-16-Pro-Max, iPhone-17-Pro-Max, iPhone-15-Pro-Max,
then the highest-numbered available "iPhone .* Pro Max",
then the highest-numbered available "iPhone .*"
```

The target is the owner's phone class: a 430-440 pt wide, 932-956 pt tall iPhone (DESIGN 1).
Which exact model is available under Xcode 26.x is an open question in the research, so the
list degrades instead of failing, and `report.environment.deviceType` records the answer.
Device width changes ad layout and overlay area fractions, so a trend that crosses device
types must say so — `03-report.md` §4.2 keys the trend on it.

### 2.3 Create, boot, prepare

```
UDID=$(xcrun simctl create "janus-probe" <deviceTypeId> <runtimeId>)   # reused if it exists
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b                                     # blocks until booted
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged \
      --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl install "$UDID" <path to ProbeHost.app>
```

The status-bar override exists so screenshots from different runs differ only where the page
differs. `bootstatus -b` replaces every sleep-and-hope loop. Boot has its own 300 s deadline;
on expiry the runner exits 3 (`harness`), because nothing downstream can be measured.

The simulator's network is the runner's network: an Azure datacentre. That is a documented
property of every number (`docs/PROBEHOST.md` §3), not something to work around.

### 2.4 Teardown

`xcrun simctl shutdown <the exact UDID this process created or reused>` in a `finally`, and
`xcrun simctl delete <UDID>` only when `--ephemeral` is passed. The runner never enumerates
host processes, never matches a process by name, and never sends a signal to anything it did
not start. `xcrun simctl terminate <UDID> io.github.mioutic.probehost` is bounded to one app
inside one simulator and is the only "stop" it ever issues.

---

## 3. `config/scenarios.json`

Data, versioned, human-edited. The runner validates it and `test/probe-scenarios.test.mjs`
keeps it honest on ubuntu, so a bad edit fails in seconds and never burns macOS minutes.

### 3.1 Schema

```jsonc
{
  "schemaVersion": 1,

  "defaults": {
    "waitIdleMs": 2500, "timeoutMs": 45000, "budgetMs": 240000,
    "scroll": { "times": 0, "dy": 800, "pauseMs": 700 },
    "tapCentre": false, "screenshots": true
  },

  "commonSelectors": [
    "ins.adsbygoogle", "iframe[id^='google_ads_iframe']", "iframe[src*='doubleclick']",
    "iframe[src*='safeframe']", "[id^='div-gpt-ad']", "[class*='ad-slot']",
    "[data-ad-client]", "[aria-label='Advertisement']", ".taboola", "[id^='taboola']",
    "[id^='outbrain']", "iframe[src*='amazon-adsystem']"
  ],

  "pageState": {
    "challenged":   { "text": ["verify you are human", "unusual traffic", "are you a robot",
                               "access denied", "request blocked", "rate limited"],
                      "selectors": ["#challenge-form", "[data-testid='bot-check']"] },
    "login-wall":   { "text": ["log in to continue", "sign in to view"],
                      "selectors": ["[data-testid='login-wall']"] },
    "consent-wall": { "text": ["we value your privacy", "manage your choices", "accept all cookies"],
                      "selectors": ["#onetrust-banner-sdk", "#didomi-popup", ".qc-cmp2-container",
                                    "[id^='sp_message_container']"] }
  },

  "scenarios": [
    {
      "id": "selftest-local",
      "title": "Harness self-check (offline fixture)",
      "url": "fixture:/selftest.html",
      "gate": true,
      "stable": true,
      "tapCentre": false,
      "waitIdleMs": 800, "timeoutMs": 15000,
      "selectors": ["#ad-slot"],
      "expect": { "blockedMin": 1, "domVisibleMax": 0, "allowedMustLoad": true },
      "notes": "Served by ProbeHost's own listener on 127.0.0.1. No network. Only #ad-slot is listed: domVisibleMax counts every selector in the list, and the fixture keeps #content visible on purpose."
    },
    {
      "id": "canyoublockit-extreme",
      "title": "CanYouBlockIt extreme test",
      "url": "https://canyoublockit.com/extreme-test/",
      "stable": true,
      "tapCentre": false,
      "scroll": { "times": 3, "dy": 900, "pauseMs": 600 },
      "selectors": ["@common", ".ad-container", "#ad_position_box"],
      "expect": { "blockedMin": 20, "domVisibleMax": 0 },
      "notes": "DESIGN 9.3's adblock pass criterion. Stable benchmark: gateable under --strict."
    },
    { "id": "reddit-popular",    "url": "https://www.reddit.com/r/popular/",
      "title": "Reddit r/popular (new UI)", "tapCentre": false,
      "scroll": { "times": 6, "dy": 800, "pauseMs": 700 },
      "selectors": ["@common", "shreddit-ad-post", "shreddit-comments-page-ad",
                    "shreddit-comment-tree-ad", "[data-testid='promoted-post']"],
      "notes": "Datacentre egress is frequently challenged. pageState carries the truth." },
    { "id": "reddit-r-news",     "url": "https://www.reddit.com/r/news/",
      "title": "Reddit r/news (busy subreddit)", "tapCentre": false,
      "scroll": { "times": 6, "dy": 800, "pauseMs": 700 },
      "selectors": ["@common", "shreddit-ad-post", "shreddit-comment-tree-ad"] },
    { "id": "old-reddit-videos", "url": "https://old.reddit.com/r/videos/",
      "title": "old.reddit.com r/videos", "tapCentre": false,
      "scroll": { "times": 4, "dy": 900, "pauseMs": 600 },
      "selectors": ["@common", ".promotedlink", "#ad_main", ".promoted"] },
    { "id": "gofile-home",       "url": "https://gofile.io/",
      "title": "gofile.io home", "tapCentre": true,
      "selectors": ["@common", "[id^='aswift']", "iframe[src*='ads']"],
      "notes": "Popup-monetised. Tap is synthetic; see docs/PROBEHOST.md section 4." },
    { "id": "gofile-file",       "urlFrom": "PROBE_GOFILE_URL",
      "title": "gofile.io file page", "tapCentre": true,
      "selectors": ["@common", "[id^='aswift']"],
      "optional": true,
      "notes": "Set repo variable PROBE_GOFILE_URL to a gofile /d/ link the owner uploaded. Absent: skipped, not failed." },
    { "id": "dailymail-ushome",  "url": "https://www.dailymail.co.uk/ushome/index.html",
      "title": "Daily Mail US home (ad-heavy)", "tapCentre": false,
      "scroll": { "times": 5, "dy": 900, "pauseMs": 600 }, "selectors": ["@common", ".mol-ads-cif"] },
    { "id": "accuweather-home",  "url": "https://www.accuweather.com/",
      "title": "AccuWeather home (ad-heavy)", "tapCentre": true,
      "scroll": { "times": 3, "dy": 800, "pauseMs": 600 }, "selectors": ["@common"] },
    { "id": "merriam-webster",   "url": "https://www.merriam-webster.com/",
      "title": "Merriam-Webster home (ad-heavy)", "tapCentre": false,
      "scroll": { "times": 4, "dy": 800, "pauseMs": 600 }, "selectors": ["@common"] }
  ]
}
```

### 3.2 Rules

- `@common` in a selector list expands to `commonSelectors`. Expansion happens in the runner,
  so the app receives a flat array and never needs to know the token.
- `urlFrom` names an **environment variable**, resolved from `process.env`, which `live.yml`
  fills from a repo *variable* (`vars.*`). A scenario whose variable is empty and which is
  `optional` is skipped with `status: "skipped"`, `reason: "unconfigured"`. A URL never lands
  in the repository, and a URL that arrives that way is still printed in the report — repo
  variables are public, so this is a convenience, not a secret store, and `live.yml` says so.
- `gate: true` marks `selftest-local`: it runs first, and its failure aborts the suite.
- `stable: true` marks a scenario whose numbers are reproducible enough to gate on under
  `--strict`. Live commercial sites are never `stable`.
- Sites must be legal, mainstream and safe: no piracy, adult or malware hosts. A pull request
  that adds one is a review item, which is why the list is data in one file.
- `expect` is advisory except under `--strict`, and even then only for `stable` scenarios.

---

## 4. Work items and ordering

For each enabled scenario, for `--repeats n` (default 1), for each mode in `--modes`
(default `blocked,none`), one work item.

Mode order **alternates by repeat and by scenario index**: the order reverses on even repeats,
and again on odd-indexed scenarios. Warm DNS, warm TLS sessions and warm CDN caches otherwise
bias the second mode systematically, and the delta is the number M2c exists to produce. The
scenario index matters because the cron and the workflow default are `repeats = 1`, where
repeat parity flips nothing: without it, `blocked` would be the cold first load and `none` the
warm second one in **every** scheduled run, and the report would claim a control it never
exercised. The order used is recorded in `run.order`, and `report.order` records which
alternations were actually in play (`alternatesByRepeat` is false at `repeats = 1`).

Scenario order is the file order, with `gate` scenarios hoisted to the front. `--scenarios
a,b,c` restricts and reorders; `--only-stable` keeps only `stable: true`.

Each work item gets a fresh `runId`: `<scenarioId>-<mode>-<repeat>` (plus `-r2` on a retry).
The app's own state is fresh by construction — a non-persistent data store and, by default, a
fresh rule-list store per run.

---

## 5. Running one work item

```
DATA=$(xcrun simctl get_app_container "$UDID" io.github.mioutic.probehost data)
```

That path is resolved **once** per install and cached; it does not change between launches.

1. **Stage.** Write `$DATA/Documents/probe/in/scenario.json` (the single expanded scenario,
   plus `commonSelectors` already inlined and `pageState` matchers). Remove any stale
   `$DATA/Documents/probe/out/<runId>`. In offline mode, copy the bundle into
   `$DATA/Documents/probe/in/bundle/`.
2. **Launch, detached:**
   ```
   xcrun simctl launch --terminate-running-process "$UDID" io.github.mioutic.probehost \
     -ProbeSuite scenario -ProbeRunId "<runId>" -ProbeMode "<mode>" \
     -ProbeScenario probe/in/scenario.json -ProbeOut "probe/out/<runId>" \
     [-ProbeManifestUrl … | -ProbeBundleDir probe/in/bundle] \
     [-ProbeFlavour …] [-ProbeStepTimeoutMs …] [-ProbeBudgetMs …]
   ```
   Detached rather than `--console-pty`: the console mode blocks on a pty that a hung web
   content process can hold open, and the sentinel already gives a clean completion signal.
   `--console-pty` is available behind `--console` for a human debugging one scenario.
3. **Wait.** Poll `$DATA/Documents/probe/out/<runId>/DONE` every 250 ms until the deadline
   (§6). `DONE` means `run.json` is complete (`01-probehost.md` §2.2), so there is no partial
   read to guard against.
4. **On deadline expiry:** capture `xcrun simctl io "$UDID" screenshot <out>/timeout.png` for
   evidence, `xcrun simctl terminate "$UDID" io.github.mioutic.probehost`, mark the item
   `status: "timeout"`. Also capture the last 2000 lines of `run.log` if it exists — a hung
   run usually says where it hung.
5. **Collect.** Copy `run.json`, `run.log` and every PNG out of the container into
   `build/probe/<suiteRunId>/<scenarioId>/<mode>/<repeat>/`. Parse `run.json`; on a parse
   error mark `status: "unparseable"` and keep the raw bytes as evidence.
6. **Clean.** Delete `$DATA/Documents/probe/out/<runId>` so the container cannot grow across
   a long suite.

The app's exit code is not observable (`00-index.md` §1); `harness.exitCode` inside
`run.json` is, and it drives the retry decision in §7.

---

## 6. Timeouts

Four nested deadlines, each with a named owner, so a hang is always attributed:

| Deadline | Default | Owner | On expiry |
|---|---|---|---|
| Step | scenario `timeoutMs`, 45 s | app | The app records `harness.timeouts` and continues. |
| Run (app) | scenario `budgetMs`, 240 s | app | The app writes what it has, `harness.status: "budget"`, exit 0. |
| Run (runner) | app run budget + 45 s slack | runner | Screenshot, `simctl terminate`, `status: "timeout"`. |
| Suite wall | `--budget-min`, default 30 | runner | Remaining items become `status: "skipped"`, `reason: "budget"`. The report and summary are still written. |

The suite wall exists because M2c is allotted 35 macOS minutes (DESIGN 10.3) and the job's
`timeout-minutes: 45` must never be what stops a run — a workflow timeout uploads no
artifacts. The runner stops itself, writes everything, and lets the job finish green.

---

## 7. Retries

Retry exactly once, and only when the *harness* failed:

| Condition | Retry? |
|---|---|
| `status: "timeout"` | yes |
| missing or unparseable `run.json` | yes |
| `harness.exitCode` 70 (internal) or 75 (network) | yes |
| `harness.exitCode` 64 (usage) or 73 (cantcreate) | no — a runner bug; failing loudly is correct |
| `harness.exitCode` 65 (bundle) | no — the published bundle failed verification; retrying hides it |
| exit 0 with any measurement, however bad | **no** |
| `pageState` is `challenged` / `login-wall` / `consent-wall` | **no** — that is the measurement |

A retry reuses the same simulator, gets `runId` suffixed `-r2`, and both attempts are kept in
the artifact. The report records `attempts` and which attempt supplied the numbers (the last
successful one). Never retry a completed measurement: a second attempt at a site that blocked
nothing is how a harness starts lying.

Between the two attempts the runner does **not** reboot the device. If the second attempt
also fails with `internal`, the runner records it and moves on; three consecutive `internal`
failures across different scenarios abort the suite (`harness.ok = false`), because a
persistently sick simulator makes every later number meaningless.

---

## 8. CLI and exit codes

```
node Tools/ProbeRunner/run.mjs
  --app <path to ProbeHost.app>        required
  --suite scenario|spike               default scenario
  --scenarios <file>                   default config/scenarios.json
  --out <dir>                          default build/probe/<runId>
  --run-id <id>                        default <utc yyyymmddHHMMSS>-<short random>
  --runtime newest|all|<x.y>           default newest
  --device-type <identifier>           override section 2.2
  --repeats <n>                        default 1
  --modes blocked,none                 default both
  --only <id,id>                       restrict scenarios
  --only-stable                        stable scenarios only
  --bundle-dir <path>                  offline: stage this bundle instead of fetching
  --manifest-url <url>                 override the entry point
  --budget-min <n>                     suite wall clock, default 30
  --strict                             expectations become failures for stable scenarios
  --ephemeral                          delete the simulator afterwards
  --console                            launch with --console-pty (one scenario, debugging)
  --record-egress                      resolve and record the runner's public IP
```

| Exit | Meaning |
|---:|---|
| 0 | The suite ran. `report.json` is written. **Blocking results, page states and per-scenario failures do not change this.** |
| 1 | `--strict` and a `stable` scenario missed its `expect`. |
| 2 | Usage: bad flag, missing `--app`, requested runtime not installed, invalid `scenarios.json`. |
| 3 | Harness failure: the gate scenario failed, the simulator would not boot or install, three consecutive internal failures, or no work item produced a result. |
| 4 | The published bundle failed contract verification (`harness.exitCode` 65 from any run). |

Exit 3 and 4 are the only ways this step fails the job in normal operation. Exit 4 is
deliberately distinct: "the bundle is broken" and "the harness is broken" must never be
confused in a job log.

---

## 9. How a scenario failure is reported without failing the job

A failed scenario is a **row in the report**, never an exception that escapes the loop. Every
work item is wrapped so that any throw becomes a record:

```jsonc
{
  "id": "reddit-popular",
  "status": "harness-failed",           // ok | harness-failed | timeout | skipped | unparseable
  "reason": "timeout after 285000 ms in phase 'idle'",
  "attempts": 2,
  "evidence": ["reddit-popular/blocked/1/timeout.png", "reddit-popular/blocked/1/run.log"],
  "modes": { "blocked": null, "none": { /* the mode that did work */ } }
}
```

Consequences, stated so nobody has to infer them:

- A scenario with one working mode still reports that mode's absolute numbers, and reports
  `delta: null` — a delta needs both halves, and a fabricated one is worse than none.
- The job summary prints failed and skipped scenarios in their own short table with the
  reason, so a reader sees what was *not* measured as plainly as what was.
- `report.harness.ok` stays `true`. Only the four conditions of exit 3 flip it.
- The trend record carries the failed scenario with `null` numbers, so a later trend view
  shows a gap rather than an invented continuity.

### 9.1 Hooks deliberately left unbuilt

Named here so they are not reinvented, and not implemented in M2c: a `ProbeTap` XCUITest
target or the AXe CLI for HID-level trusted taps (M4, popups); a `--egress residential` flag
routing through a Tailscale userspace proxy (out of scope, and the exit-node path is
unverified); a media fixture server and the video suites (M5); the Ghostery reference diff,
which belongs to the Tier B Playwright harness, not here.
