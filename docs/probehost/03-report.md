# The combined report, the job summary and the trend

Owners: **runner** owns `report.json` (§2). **ci** owns the job-summary markdown (§3) and the
trend record (§4). The seam between them is exactly one file: `report.mjs` reads
`report.json` and nothing else, so the summary a human reads and the trend a future job
accumulates can never disagree with the report the artifact carries.

---

## 1. Why there are three outputs and not one

| Output | Audience | Lifetime | Shape |
|---|---|---|---|
| `report.json` | tooling, future re-analysis | 14 days (artifact) | complete, verbose, every run linked |
| job summary | a human, 20 seconds after the run | as long as the run page | markdown, one screen |
| `trend.json` | the same numbers, months later | 90 days (artifact) | tiny, flat, append-friendly |

The report keeps everything because re-running costs macOS minutes. The summary keeps four
numbers per scenario because a table nobody reads is a table that hides a regression. The
trend keeps only what stays comparable across bundle versions.

---

## 2. `report.json`

Written by `run.mjs` to `build/probe/<runId>/report.json`. `schemaVersion: 1`.

```jsonc
{
  "schemaVersion": 1,
  "suite": "scenario",
  "runId": "20260915051022-a3f1",
  "startedAt": "2026-09-15T05:10:22Z",
  "endedAt": "2026-09-15T05:31:48Z",
  "durationMs": 1286000,

  "ci": {
    "provider": "github-actions",
    "repository": "mioutic/janus-filters",
    "workflow": "live",
    "runNumber": 42, "runId": "1234567890", "runAttempt": 1,
    "sha": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    "ref": "refs/heads/main",
    "event": "schedule"
  },

  "environment": {
    "runnerImage": "macos-26",
    "macosVersion": "26.1",
    "xcode": "26.6",
    "runtime": "26.4",
    "runtimeId": "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    "deviceType": "iPhone 16 Pro Max",
    "deviceTypeId": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max",
    "viewport": { "width": 440, "height": 956, "scale": 3 },
    "node": "24.8.0",
    "egress": { "mode": "direct", "datacentre": true, "observedIp": null }
  },

  "bundle": {
    "source": "network",
    "version": 2026091300,
    "layoutVersion": 1,
    "issuedAt": "2026-09-13T04:31:07Z",
    "ageHours": 49,
    "keyId": "d6ff9fb88ae9b930",
    "contractVersion": 1,
    "flavour": "ios26",
    "manifestSha256": "…",
    "contractOk": true,
    "consistent": true            // every run saw the same version and manifest hash
  },

  "compile": {
    "buckets": 59,
    "failed": 0,
    "failedIds": [],
    "totalMs": 41880,
    "medianMs": 412,
    "slowest": [ { "id": "janus.net.ads.00", "compileMs": 4188, "ruleCount": 72311 } ],
    "ruleCountTotal": 512000,
    "note": "Simulator timings on a 3-vCPU virtualised M1. Relative cost only."
  },

  // allowedRequestReachedServer / blockedRequestReachedServer come from the fixture
  // server's own hit counts, not from "the navigation finished": a rule set that
  // over-blocked the control must not be able to pass the gate.
  "gate": { "id": "selftest-local", "passed": true,
            "blocked": 1, "ruleListActions": 1, "domVisible": 0,
            "allowedRequestReachedServer": true, "blockedRequestReachedServer": false,
            "navigationDidFinish": true, "spiFired": true, "spiSelectorPresent": true },

  "scenarios": [
    {
      "id": "reddit-popular",
      "title": "Reddit r/popular (new UI)",
      "url": "https://www.reddit.com/r/popular/",
      "stable": false,
      "status": "ok",                 // ok | harness-failed | timeout | skipped | unparseable
      "reason": null,
      "attempts": 1,
      "repeats": 1,
      "pageState": { "blocked": "ok", "none": "ok", "agree": true },
      "modes": {
        "blocked": {
          "runs": ["reddit-popular/blocked/1/run.json"],
          "representativeIsMedian": true,   // false when the median was interpolated
          "repeatsExcludedIncomplete": 0,   // partial runs dropped when a complete one existed
          "requestsObserved": 214,
          "requestsBlocked": 37,            // distinct URLs whose load was stopped
          "ruleListActions": 61,            // raw SPI callbacks: once per matching list per load
          "blockedByFamily": { "net.ads": 28, "net.privacy": 9 },
          "thirdPartyHosts": 23, "transferBytesLowerBound": 3120044,
          "adElementsMatched": 14, "adElementsVisible": 0,
          "overlays": 0, "largestOverlayFraction": 0,
          "popupsNative": 0, "popupsJs": 0,
          "dialogs": 0, "consoleErrors": 3,
          "loadMs": 6120, "didFinish": true,
          "screenshots": ["reddit-popular/blocked/1/…-settle.png"]
        },
        "none": { "requestsObserved": 361, "requestsBlocked": 0, "…": "…" }
      },
      "delta": {
        "requestsBlocked": 37,
        "requestsObserved": -147,
        "thirdPartyHosts": -19,
        "transferBytesLowerBound": -4880221,
        "adElementsVisible": -11,
        "overlays": -2,
        "popupsNative": -1,
        "dialogs": 0,
        "consoleErrors": 1,
        "loadMs": -2310
      },
      "expect": { "declared": null, "met": null },
      "flags": ["console-errors-higher-in-blocked"]
    }
  ],

  // Aggregates are computed over CLEAN rows only - status ok and a blocked-mode
  // pageState of ok - so a bot wall and a real page are never summed into one number
  // that could be quoted as a blocking result. scenariosWalled counts the rest.
  "totals": {
    "scenariosRun": 9, "scenariosClean": 7, "scenariosWalled": 2,
    "scenariosOk": 8, "scenariosFailed": 1, "scenariosSkipped": 1,
    "totalsBasis": "clean rows only: status ok and blocked-mode pageState ok",
    "requestsBlocked": 402, "ruleListActions": 655,
    "adElementsVisibleBlocked": 2, "adElementsVisibleNone": 71,
    "popupsNativeBlocked": 1, "popupsNativeNone": 6
  },

  "harness": {
    "ok": true,
    "failures": [ { "scenario": "gofile-home", "reason": "timeout after 285000 ms" } ],
    "warnings": [ { "scenario": "old-reddit-videos",
                    "reason": "blocked count non-zero in mode none (3)" } ],
    "skipped": [ { "scenario": "gofile-file", "reason": "unconfigured" } ]
  }
}
```

### 2.1 How the merge works

- **Per mode, across repeats: the median**, not the mean. One challenged or one unusually
  slow load must not move the number. With `--repeats 1` the median is that run. Every
  contributing `run.json` path stays in `runs[]`, so the raw data is one hop away.
- **Deltas are `blocked − none`** on the merged per-mode numbers, and only when both modes
  produced a result. Otherwise `delta: null`. A negative `requestsObserved` delta means
  blocking removed requests, which is the expected sign; the summary renders the sign
  literally rather than flipping it to look flattering.
- **`pageState.agree`** is false when the two modes saw different page states. When they
  disagree, the delta is still computed and the row is flagged, because a comparison between
  a real page and a bot check is not a measurement of blocking.
- **Flags** are cheap, named observations that a reader should not have to derive:
  `mode-none-blocked-nonzero` (a harness bug), `page-state-disagree`,
  `zero-blocked-but-ads-visible`, `console-errors-higher-in-blocked` (a possible breakage
  caused by our own rules), `overlay-appeared-in-blocked` (possible anti-adblock),
  `compile-failure`, `truncated-requests`.
- **`bundle.consistent`** is false if any run saw a different `version` or `manifestSha256` —
  possible when a `filters` publish lands mid-suite. The summary says so loudly, because the
  comparison is then across two bundles.

---

## 3. The job summary

`report.mjs --summary $GITHUB_STEP_SUMMARY` appends this. It must fit on one screen at the
top and put every detail below it. GitHub caps a step summary at 1 MiB; the writer truncates
the per-scenario detail first and always keeps §3.1 and §3.2.

### 3.1 Header

```markdown
## Live blocking suite — bundle 2026091300 (2 days old)

**ios26**, 59 buckets, 512,000 rules, compiled in 41.9 s · runtime **iOS 26.4** on
**iPhone 16 Pro Max** · Xcode 26.6 · egress **direct (datacentre)** · 1 repeat

Harness self-check **passed** · contract verification **passed** · 8/9 scenarios measured
```

If the self-check or contract verification failed, that line is the first thing in the
summary and is prefixed `FAILED`, with the failing contract step number and reason.

### 3.2 The table M2c asks for

One row per scenario: requests blocked, ad elements visible, popups attempted, and the delta
between modes.

```markdown
| Scenario | State | Blocked | Requests b/n | Ads visible b/n | Popups b/n | Overlays b/n | Load ms b/n |
|---|---|---:|---:|---:|---:|---:|---:|
| canyoublockit-extreme | ok | **41** | 96 / 243 | **0 / 18** | 0 / 3 | 0 / 1 | 3100 / 5240 |
| reddit-popular | ok | **37** | 214 / 361 | **0 / 11** | 0 / 1 | 0 / 2 | 6120 / 8430 |
| reddit-r-news | challenged | 4 | 31 / 34 | 0 / 0 | 0 / 0 | 1 / 1 | 1980 / 2010 |
| old-reddit-videos | ok | **22** | 64 / 141 | **0 / 6** | 0 / 0 | 0 / 0 | 2410 / 3320 |
| gofile-home | ok | **18** | 77 / 158 | **0 / 4** | 0 / 2 | 0 / 1 | 3890 / 5110 |
| dailymail-ushome | ok | **112** | 248 / 704 | **1 / 37** | 0 / 0 | 0 / 3 | 7220 / 14880 |
| accuweather-home | ok | **63** | 141 / 402 | **0 / 12** | 0 / 1 | 0 / 2 | 4410 / 9120 |
| merriam-webster | ok | **49** | 118 / 311 | **1 / 9** | 0 / 0 | 0 / 1 | 3980 / 7740 |

`b/n` = mode **blocked** / mode **none**. Bold = the number M2c is about.
```

`Blocked` is the exact count from the rule-list SPI callback in mode `blocked`. `State` is
`pageState`; any value other than `ok` makes the whole row advisory and the cell carries it.

### 3.3 What was not measured

Always present, even when empty — an absent section reads as "nothing went wrong", which is a
claim the summary is not entitled to make.

```markdown
### Not measured

| Scenario | Status | Reason | Evidence |
|---|---|---|---|
| gofile-file | skipped | PROBE_GOFILE_URL not configured | — |
| gofile-home (repeat 2) | timeout | 285 s in phase 'idle' | timeout.png, run.log |
```

### 3.4 Flags, compile, and the footer

```markdown
### Flags
- `reddit-r-news`: page state **challenged** in both modes — a datacentre IP, not a blocking result.
- `merriam-webster`: 1 ad element still visible in mode blocked.

### Compile
59 buckets, 0 failures, 41.9 s total, median 412 ms.
Slowest: janus.net.ads.00 4188 ms (72,311 rules), janus.cos.generic.01 2210 ms.
*Simulator timings on a 3-vCPU virtualised M1: relative cost only, never a phone estimate.*

---
Artifact `probe-live-1234567890-1` · how to read these numbers: `docs/PROBEHOST.md`
```

### 3.5 Rules for the writer

- Never colour a number by whether it flatters the project. Bold marks *relevance*, not
  success.
- Never print a delta when one mode is missing; print `—`.
- Never round a count. Durations round to whole ms, or to 0.1 s above 10 s.
- Never emit a URL with a query string (`01-probehost.md` §5.1).
- Never print a local path, a hostname belonging to the owner, or an account name.

---

## 4. The trend

### 4.1 `trend.json`

One small object per suite run, written by `report.mjs --trend`. It is deliberately flat and
deliberately excludes everything that will not be comparable in six months: no timings that
depend on a runner's mood, no request lists, no screenshots.

```jsonc
{
  "schemaVersion": 1,
  "runId": "20260915051022-a3f1",
  "date": "2026-09-15",
  "ts": "2026-09-15T05:31:48Z",
  "bundleVersion": 2026091300,
  "bundleIssuedAt": "2026-09-13T04:31:07Z",
  "layoutVersion": 1,
  "flavour": "ios26",
  "contractOk": true,
  "env": { "runnerImage": "macos-26", "xcode": "26.6", "runtime": "26.4",
           "deviceType": "iPhone 16 Pro Max", "viewportWidth": 440,
           "egress": "direct" },
  "compile": { "buckets": 59, "failed": 0, "ruleCountTotal": 512000, "totalMs": 41880 },
  "gate": { "passed": true },
  "scenarios": {
    "reddit-popular": {
      "state": "ok",
      "blocked": 37, "observedB": 214, "observedN": 361,
      "adVisibleB": 0, "adVisibleN": 11,
      "overlaysB": 0, "overlaysN": 2,
      "popupsB": 0, "popupsN": 1,
      "dialogsB": 0, "dialogsN": 0,
      "consoleErrB": 3, "consoleErrN": 2,
      "loadMsB": 6120, "loadMsN": 8430
    },
    "gofile-file": null                 // skipped or failed: an explicit gap, never a carried-forward value
  },
  "ci": { "runId": "1234567890", "runAttempt": 1, "sha": "0f1e2d3c…", "event": "schedule" }
}
```

A scenario that did not produce both modes is `null`. A scenario whose `pageState` was not
`ok` keeps its numbers **and** its `state`, so a later reader can filter rather than guess.

### 4.2 Comparability keys

Two trend records are comparable only when `env.runtime`, `env.deviceType`,
`env.viewportWidth`, `env.egress` and `flavour` match, and `layoutVersion` is unchanged. Any
tool that plots this must group on that tuple; a device-width change alone moves overlay area
fractions and lazy-loaded ad counts. The keys are in the record precisely so the grouping is
mechanical and not a judgement call.

### 4.3 Accumulating them later

M2c **writes** trend records and ships the code that merges them. It deliberately **wires no
store**: a store means a write path, and this repository's only write path to itself is the
signed release job.

Shipped now: `Tools/ProbeRunner/lib/trend.mjs` with

```
node Tools/ProbeRunner/report.mjs --accumulate <dir of trend.json files> --out trend.ndjson
```

which sorts by `ts`, de-duplicates on `runId`, and emits newline-delimited JSON — the format
that appends without rewriting.

Two documented routes, either of which is a later, reviewed change:

1. **Artifact harvest (recommended, no new permissions).** Each run uploads
   `probe-trend-<run_id>` with 90-day retention. To build a history on a workstation:
   `gh run list --workflow live.yml --json databaseId`, then `gh run download <id> -n
   probe-trend-<id>` into one directory, then `--accumulate`. Nothing in CI gains write
   access; the ceiling is the 90-day retention.
2. **An orphan `probe-trend` branch.** A follow-up job appends `trend.json` to
   `trend.ndjson` on a branch that holds nothing else. It needs `contents: write` on the
   `live` workflow, which today has `contents: read` and no secrets. That trade is a separate
   decision with a separate review, and it is not taken in M2c.

The Pages mirror is explicitly not a candidate: it is a byte-identical mirror of published
bundles (CONTRACT §3), and mixing measurement data into it would weaken a guarantee the app
depends on.

---

## 5. Artifact layout

```
build/probe/<runId>/
  report.json
  trend.json
  summary.md                       the same markdown appended to the job summary
  run.log                          the runner's own log
  environment.json                 simctl runtimes/devicetypes as seen, verbatim
  <scenarioId>/<mode>/<repeat>/
    run.json
    run.log
    <runId>-settle.png
    <runId>-tap.png
    <runId>-end.png
    timeout.png                    only when the runner's deadline expired
```

Uploaded as two artifacts, `if: always()`:

| Artifact | Contents | Retention |
|---|---|---|
| `probe-live-<run_id>-<run_attempt>` | the whole tree | 14 days |
| `probe-trend-<run_id>` | `trend.json` only | 90 days |

PNGs are captured at scale 1 (440×956 ≈ 150-250 KB each) and capped at three per run, so a
9-scenario, 2-mode, 1-repeat suite carries well under 15 MB — comfortably inside the Free
plan's storage, and small enough to download over a phone tether.

`spike.yml` uploads `probe-spike-<run_id>` with `spike-report.json`, each runtime's
`spike.json`, and its own summary (`04-spike.md` §5).
