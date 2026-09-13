# Janus filter-bundle contract

**Contract version 1.** Normative for the Janus app milestones M2a and M2b.

This document is the complete interface between the public `mioutic/janus-filters` pipeline and
the Janus browser. Everything the app is allowed to assume is written here; anything not written
here is not guaranteed and must not be relied on. `docs/PIPELINE.md` explains how the bundle is
produced — read it for rationale, read this for behaviour.

The app is the only consumer, but the bundle is public and unauthenticated: there are no
credentials, no user identifiers, no telemetry, and no request that distinguishes one installation
from another. Integrity comes entirely from the Ed25519 signature described in section 5.

Where this document and `Janus/docs/DESIGN.md` disagree, DESIGN wins.

---

## 1. Terms

| Term | Meaning |
|---|---|
| **bundle** | One published set: a manifest, its signature, and every payload it names |
| **version** | A monotonic integer identifying a bundle (section 7) |
| **bucket** | One compiled `WKContentRuleList`: a JSON array of content rules |
| **family** | The group a bucket belongs to: `net.ads`, `net.privacy`, `net.security`, `cos.generic`, `cos.specific`, plus the single `janus.active` |
| **flavour** | The Safari rule vocabulary a bucket was converted for: `ios17` or `ios26` |
| **advanced rules** | Text rules content rules cannot express, answered per URL by SafariConverterLib's `FilterEngine` |
| **payload** | A non-rule JSON asset: LinkCleaner, popup index, site fixes |

All hashes are SHA-256, lower-case hex. All sizes are bytes. All timestamps are RFC 3339 with a
`Z` suffix and second precision. All file names are ASCII, flat, and case-sensitive.

---

## 2. Transport and compression

Every payload is served as a standalone file over HTTPS, compressed with **LZFSE** and named
`*.lzfse`. The device decompresses with `NSData.decompressed(using: .lzfse)` (DESIGN 3.3 step 9).
The manifest and its signature are the only uncompressed files.

Requests carry no cookies, no authentication and no custom headers beyond a `User-Agent` of the
app's own choosing. Conditional requests (`If-None-Match`) are permitted and encouraged; a `304`
means the file is unchanged.

The app must impose its own limits before decompressing anything: reject a `.lzfse` file whose
compressed size differs from `downloadSize`, and reject a decompressed result whose length
differs from `size`. Both numbers come from the verified manifest, so a decompression bomb is
impossible to reach — the size is known and signed before a byte is expanded.

---

## 3. URLs

The GitHub Release of `mioutic/janus-filters` is the source of truth. GitHub Pages carries a
byte-identical mirror. The app tries the Release first and falls back to Pages on a network or
HTTP failure; it never mixes the two within one bundle version, and it verifies signatures and
hashes identically regardless of origin.

**Latest bundle** (the only URLs the updater needs to start):

```
https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json
https://github.com/mioutic/janus-filters/releases/latest/download/manifest.json.sig
```

**Payloads of a specific bundle.** Never construct these yourself from the latest-download form;
take `baseUrl` from the verified manifest and append the `file` value of the entry you want:

```
<baseUrl><file>
```

For version `2026091300` that resolves to, for example:

```
https://github.com/mioutic/janus-filters/releases/download/filters-2026091300/janus.net.ads.00.ios26.json.lzfse
```

**Pages mirror.** `manifest.mirrors` lists alternative bases for the same bundle:

```
https://mioutic.github.io/janus-filters/v/2026091300/janus.net.ads.00.ios26.json.lzfse
https://mioutic.github.io/janus-filters/latest/manifest.json
```

`releases/latest/download/...` resolves only to the newest **non-draft, non-prerelease** release.
The pipeline uploads every asset to a draft and only then publishes it (PIPELINE section 16), so
a `latest` manifest always has all of its payloads available. A 404 on a payload named by a
verified manifest is nevertheless treated as a failed update, never as an empty bucket.

**Release tag format.** `filters-<version>`, e.g. `filters-2026091300`. The app does not parse
tags; it uses `baseUrl`.

---

## 4. `manifest.json`

### 4.1 Rules for reading it

1. Parse only after the signature verifies (section 6). An unverified manifest is untrusted
   input and must not influence any decision, including which URLs to fetch.
2. Ignore unknown fields. The pipeline may add fields within contract version 1.
3. Reject the bundle if `contractVersion` is greater than the version this app build implements.
4. Reject the bundle if any field marked **required** below is absent or of the wrong type.
5. Never re-serialise the manifest before hashing or verifying: the signed bytes are the bytes
   as downloaded.

### 4.2 Top-level fields

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `contractVersion` | int | yes | This document's version. `1` for M2a. Greater than the app implements means reject. |
| `schemaVersion` | int | yes | Manifest shape within the contract version. Additive changes bump this; the app ignores it beyond logging. |
| `layoutVersion` | int | yes | Bucket layout generation. A change means bucket keys were re-hashed: discard staged and installed buckets and download the whole set (section 8.4). |
| `version` | int | yes | Monotonic bundle version (section 7). |
| `issuedAt` | string | yes | RFC 3339 UTC. When the bundle was built. |
| `expiresAt` | string | yes | RFC 3339 UTC, `issuedAt + 14 days`. Advisory; the app's own age rule is authoritative (section 7.2). |
| `keyId` | string | yes | 16 lower-case hex chars identifying the signing key (section 5). |
| `minAppBuild` | int | yes | Lowest app build that may use this bundle. A lower build rejects it and keeps what it has. |
| `baseUrl` | string | yes | Absolute HTTPS URL ending in `/`. Prefix for every `file`. |
| `mirrors` | string[] | yes | Zero or more alternative bases, same rules, same bytes. |
| `flavours` | string[] | yes | Flavours present in this bundle. The pipeline refuses to publish unless both `ios17` and `ios26` are present, so in contract 1 this is always `["ios17","ios26"]`; a device whose flavour is absent has no buckets to install and must abandon the update (section 11). |
| `generator` | object | yes | Versions used to build: `pipeline`, `safariConverterLib`, `scriptlets`, `extendedCss`. Informational; surfaced in diagnostics. |
| `lists` | object[] | yes | The source lists (section 4.3). Drives the filter picker. |
| `buckets` | object[] | yes | The rule lists (section 4.4). |
| `advancedRules` | object | yes | Per flavour, the default-on advanced-rules text payload plus one `optIn[]` entry per opt-in list's payload (section 9.1). |
| `engine` | object | no | Per flavour, the prebuilt `FilterEngine` binary (section 9.3). Optional in every sense: it may be absent, and the app may ignore it. |
| `payloads` | object | yes | `linkcleaner`, `popupIndex`, `siteFix` (section 10). |
| `killSwitches` | object | yes | Remote feature disables (section 10.4). |
| `dropped` | object | no | Summary counts of unconvertible rules. Diagnostics only. |
| `delta` | object | no | `previousVersion`, `changedBuckets`, `changedBytes`, plus a `byFlavour` breakdown. Diagnostics only: the app never decides anything from it. `changedBuckets` and `changedBytes` are the worst flavour's numbers, because a device installs exactly one flavour, which is how DESIGN 3.4's "under 5 MB, under 3 recompiled buckets" target is measured. The engine payload is excluded: `FilterEngine` stamps a timestamp into `meta.bin`, so it changes on every build. |

### 4.3 `lists[]`

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | yes | Stable list id, e.g. `adguard.base`. |
| `title` | string | yes | Display name for the picker. |
| `default` | bool | yes | On by default on a fresh install. |
| `trust` | string | yes | `trusted` or `untrusted`. Shown in the UI; the gate already ran in CI. |
| `license` | string | yes | SPDX identifier. |
| `homepage` | string | yes | Where the list comes from. |
| `ruleCount` | int | no | Rules contributed after preprocessing. Diagnostics only. |

The app must not attempt to fetch these URLs itself. Filter sources are fetched only by CI; the
device downloads compiled buckets and nothing else.

### 4.4 `buckets[]`

One entry per bucket, carrying both flavours.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | yes | Bucket id, e.g. `janus.net.ads.03`, `janus.active`. |
| `family` | string | yes | `net.ads`, `net.privacy`, `net.security`, `cos.generic`, `cos.specific`, `active`. |
| `optIn` | bool | yes | True when the bucket exists only for opt-in lists; install only if the owner enabled a list in `lists`. |
| `lists` | string[] | yes | List ids that contributed rules. Used to decide whether an opt-in bucket is wanted, so it only has to be meaningful when `optIn` is true. `janus.active` is synthesised rather than built from a list, and names its source file (`config/surrogates.json`) here instead of a list id; it is never opt-in, so the app never reads it. |
| `flavours` | object | yes | Map flavour -> file entry (below). Every flavour in the top-level `flavours` array is present. |

Each flavour entry:

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `file` | string | yes | File name, appended to `baseUrl`. |
| `sha256` | string | yes | SHA-256 of the **decompressed** JSON. This is the bucket's identity. |
| `size` | int | yes | Length of the decompressed JSON in bytes. |
| `downloadSha256` | string | yes | SHA-256 of the `.lzfse` file as served. |
| `downloadSize` | int | yes | Length of the `.lzfse` file in bytes. |
| `ruleCount` | int | yes | Number of content rules in the array. Always `<= 110000`. |
| `compileMs` | int | no | Compile time measured on the macOS CI runner. A relative cost hint for ordering the compile queue, never a phone estimate. |

### 4.5 Example

A complete, valid manifest, shortened to two buckets. Field order is exactly as the pipeline
emits it, and that order is normative — `pack` writes the keys in this sequence and the
signature covers those exact bytes.

Two things about this example are illustrative rather than byte-exact. The pipeline serialises
with `JSON.stringify(manifest, null, 2)`, so short arrays such as `mirrors`, `flavours` and
`lists` are broken across lines rather than kept inline as they are here for readability; the app
never re-serialises a manifest, so only the field order and the bytes on the wire matter. And
`engine` carries an entry per flavour that produced one, not just `ios26`; the whole object is
absent when no bucket produced advanced rules.

```json
{
  "contractVersion": 1,
  "schemaVersion": 1,
  "layoutVersion": 1,
  "version": 2026091300,
  "issuedAt": "2026-09-13T04:31:07Z",
  "expiresAt": "2026-09-27T04:31:07Z",
  "keyId": "d6ff9fb88ae9b930",
  "minAppBuild": 1,
  "baseUrl": "https://github.com/mioutic/janus-filters/releases/download/filters-2026091300/",
  "mirrors": ["https://mioutic.github.io/janus-filters/v/2026091300/"],
  "flavours": ["ios17", "ios26"],
  "generator": {
    "pipeline": "janus-filters@1",
    "safariConverterLib": "4.3.0",
    "scriptlets": "2.5.1",
    "extendedCss": "2.2.1"
  },
  "lists": [
    {
      "id": "adguard.base",
      "title": "AdGuard Base filter",
      "default": true,
      "trust": "trusted",
      "license": "GPL-3.0-only",
      "homepage": "https://adguard.com/kb/general/ad-filtering/adguard-filters/",
      "ruleCount": 131204
    },
    {
      "id": "adguard.tracking",
      "title": "AdGuard Tracking Protection",
      "default": false,
      "trust": "trusted",
      "license": "GPL-3.0-only",
      "homepage": "https://adguard.com/kb/general/ad-filtering/adguard-filters/",
      "ruleCount": 101488
    }
  ],
  "buckets": [
    {
      "id": "janus.net.ads.00",
      "family": "net.ads",
      "optIn": false,
      "lists": ["adguard.base", "adguard.mobile-ads", "ubo.filters", "ubo.unbreak"],
      "flavours": {
        "ios17": {
          "file": "janus.net.ads.00.ios17.json.lzfse",
          "sha256": "3f0a1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
          "size": 9341882,
          "downloadSha256": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          "downloadSize": 1442310,
          "ruleCount": 72184,
          "compileMs": 4120
        },
        "ios26": {
          "file": "janus.net.ads.00.ios26.json.lzfse",
          "sha256": "5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817060",
          "size": 9402117,
          "downloadSha256": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
          "downloadSize": 1450992,
          "ruleCount": 72311,
          "compileMs": 4188
        }
      }
    },
    {
      "id": "janus.active",
      "family": "active",
      "optIn": false,
      "lists": ["config/surrogates.json"],
      "flavours": {
        "ios17": {
          "file": "janus.active.ios17.json.lzfse",
          "sha256": "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
          "size": 41822,
          "downloadSha256": "ffeeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211",
          "downloadSize": 9044,
          "ruleCount": 96,
          "compileMs": 38
        },
        "ios26": {
          "file": "janus.active.ios26.json.lzfse",
          "sha256": "22334455667788990011aabbccddeeff22334455667788990011aabbccddeeff",
          "size": 41830,
          "downloadSha256": "eeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211ff",
          "downloadSize": 9051,
          "ruleCount": 96,
          "compileMs": 39
        }
      }
    }
  ],
  "advancedRules": {
    "ios17": {
      "file": "advanced.ios17.txt.lzfse",
      "sha256": "aa00bb11cc22dd33ee44ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd",
      "size": 5218440,
      "downloadSha256": "bb11cc22dd33ee44ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee",
      "downloadSize": 812004,
      "ruleCount": 24881,
      "schemaVersion": 1
    },
    "ios26": {
      "file": "advanced.ios26.txt.lzfse",
      "sha256": "cc22dd33ee44ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff",
      "size": 5219006,
      "downloadSha256": "dd33ee44ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff0011",
      "downloadSize": 812190,
      "ruleCount": 24884,
      "schemaVersion": 1,
      "lists": ["adguard.base", "easylist", "ubo.filters"],
      "optIn": [
        {
          "file": "advanced.ios26.adguard-social.txt.lzfse",
          "sha256": "ee44ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff00aa11bb",
          "size": 210114,
          "downloadSha256": "ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff00aa11bb22cc",
          "downloadSize": 41220,
          "ruleCount": 408,
          "lists": ["adguard.social"]
        }
      ]
    }
  },
  "engine": {
    "ios17": {
      "file": "engine.ios17.tar.lzfse",
      "engineSchemaVersion": 1,
      "sha256": "dd33ee44ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff0011",
      "size": 7712884,
      "downloadSha256": "44ee55ff00aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff00aa11bb",
      "downloadSize": 2209902
    },
    "ios26": {
      "file": "engine.ios26.tar.lzfse",
      "engineSchemaVersion": 1,
      "sha256": "ee44ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff00aa11bb",
      "size": 7714304,
      "downloadSha256": "ff5500aa11bb22cc33dd44ee55ff00aa11bb22cc33dd44ee55ff00aa11bb22cc",
      "downloadSize": 2210448
    }
  },
  "payloads": {
    "linkcleaner": {
      "file": "linkcleaner.json.lzfse",
      "schemaVersion": 1,
      "sha256": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      "size": 88114,
      "downloadSha256": "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a",
      "downloadSize": 14220
    },
    "popupIndex": {
      "file": "popup-index.json.lzfse",
      "schemaVersion": 1,
      "sha256": "3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b",
      "size": 210448,
      "downloadSha256": "4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c",
      "downloadSize": 38810
    },
    "siteFix": {
      "file": "sitefix.json.lzfse",
      "schemaVersion": 1,
      "sha256": "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      "size": 44210,
      "downloadSha256": "6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
      "downloadSize": 9118
    }
  },
  "killSwitches": {
    "listSuppliedJavaScript": true,
    "scriptlets": true,
    "surrogates": true,
    "advancedRules": true,
    "extendedCss": true
  },
  "dropped": {
    "total": 18442,
    "byModifier": { "$csp": 812, "$redirect-rule": 344, "$removeparam": 2611,
                    "$replace": 96, "##^": 402, "$permissions": 41, "other": 1188 },
    "byCause": { "trust-gate": 214, "scriptlet.no-alias": 903, "compile.bisect": 0 }
  },
  "delta": {
    "previousVersion": 2026091200,
    "changedBuckets": 2,
    "changedBytes": 2893302,
    "byFlavour": {
      "ios17": { "changedBuckets": 2, "changedBytes": 2893302 },
      "ios26": { "changedBuckets": 2, "changedBytes": 2891004 }
    }
  }
}
```

---

## 5. Signature

**Algorithm:** Ed25519 (RFC 8032), as implemented by `CryptoKit.Curve25519.Signing` on the
device and `node:crypto` in CI. No hash prefix, no context string, no envelope.

**Signed bytes:** the exact byte sequence of `manifest.json` as served, from the first `{` to the
last `}`, with no trailing newline. There is no canonicalisation step. The app must hold the
downloaded bytes and verify those, never a re-encoded object.

**Signature file:** `manifest.json.sig` contains the base64 of the 64-byte raw signature followed
by a single `\n`. Decode with standard base64 (padding present, no URL-safe alphabet). Whitespace
around the payload is tolerated; anything else is a rejection.

**Public key (M2a), raw 32 bytes, base64:**

```
wFAZ/lFdpErWYl+lJvB02kKnHUOoKm9qqhgJckY8oAY=
```

**keyId:** `d6ff9fb88ae9b930`

`keyId` is the first 16 hex characters of the SHA-256 of the **raw 32-byte public key** — not of
a PEM, not of a DER SPKI, not of the base64 text. In Swift:

```swift
let raw = Data(base64Encoded: "wFAZ/lFdpErWYl+lJvB02kKnHUOoKm9qqhgJckY8oAY=")!
let key = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
let keyId = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined().prefix(16)
// "d6ff9fb88ae9b930"
```

**Key pinning.** The app pins a **map of keyId to public key** compiled into the binary, holding
two slots: the current key above, and a reserved rollover slot that is empty in M2a. Verification
selects the pinned key whose id equals `manifest.keyId`. An unknown `keyId` is a rejection — never
a prompt, never a fallback to "try every key", never a fetch of a key from the network. Rolling
the key requires an app update, which is the point: a compromised pipeline cannot introduce its
own key.

**What the signature covers.** Only the manifest. Every payload is covered transitively, because
its `sha256` and `downloadSha256` are inside the signed manifest and the app verifies each file
against them before use. A payload is never trusted because it came from the right URL.

**What it does not cover.** Freshness. A valid signature on an old manifest is still a valid
signature; replay is prevented by the version and age rules in section 7, not by cryptography.

---

## 6. Verification order

The app performs these steps in this order. **Every step is fail-closed**: on any failure the
update is abandoned, nothing is staged or swapped, the currently installed bundle stays in use,
and the failure is recorded in diagnostics with the step number and reason.

**Phase 1 — manifest.**

1. Download `manifest.json` and `manifest.json.sig`. Refuse a manifest larger than 4 MiB.
2. Decode the signature: exactly 64 bytes after base64 decoding.
3. Read `keyId` from the manifest **only to select the pinned key** — this is a lookup in a
   compiled-in table, not a decision based on untrusted data. Unknown id: reject.
4. Verify the signature over the downloaded bytes with that key. Invalid: reject.
5. Parse the JSON. From here the manifest's contents are trusted.
6. `contractVersion` greater than this build implements: reject, and surface "app update needed".
7. `minAppBuild` greater than this build: reject, same surface.
8. `version` not strictly greater than the installed bundle's version: reject as stale or replayed
   (section 7.1).
9. `issuedAt` 14 days or more before now: reject (section 7.2, and section 14 item 6 for the
   exact boundary).
10. `issuedAt` more than 24 hours in the future: reject (clock skew or a bad build).
11. `baseUrl` and every `mirrors` entry must be `https:` and must be under
    `github.com/mioutic/janus-filters/` or `mioutic.github.io/janus-filters/`. Anything else:
    reject. A signed manifest could otherwise point the downloader anywhere.

**Phase 2 — payloads.** For each file the app decided it needs (section 8):

12. Download it. Refuse a response whose byte length differs from `downloadSize`.
13. SHA-256 the downloaded bytes and compare with `downloadSha256`. Mismatch: reject this update.
14. Decompress. Refuse a result whose length differs from `size`.
15. SHA-256 the decompressed bytes and compare with `sha256`. Mismatch: reject this update.
16. Write to `Shield/Staged/<version>/` with `NSFileProtectionCompleteUntilFirstUserAuthentication`
    (DESIGN 3.4).

**Phase 3 — compile.** Only after every needed payload is staged and verified:

17. Compile each staged bucket (section 8.5). A bucket that fails to compile aborts the swap.
18. Swap only when **all** staged buckets have compiled. Add the new lists to every live
    `WKUserContentController`, remove the old ones, then delete stale identifiers from the store.

The three phases are separable in time and that is deliberate: phases 1 and 2 run in
`BGAppRefreshTask` or a foreground check (max once per 24 h, Wi-Fi only unless the owner opts in
to cellular); phase 3 runs only when the device is idle in the foreground or in a
`BGProcessingTask` with external power (DESIGN 3.4).

A partially downloaded bundle is never partially installed. `Shield/Staged/<version>/` is either
completed and swapped, or deleted.

---

## 7. Version and age

### 7.1 Version

`version` is a monotonic integer of the form `YYYYMMDD * 100 + N`, where `N` is the run of that
UTC day, `00`-`99`. Example: `2026091300` is the first bundle of 13 September 2026.

- The app accepts a manifest **only** when `version > installedVersion`. Equal is not an update;
  lower is a rollback attempt and is rejected.
- The app must not parse the date out of the version. It is an opaque monotonic counter; the date
  encoding exists so a human can read a log line.
- The value fits comfortably in `Int64` and in JavaScript's safe integer range.
- The pipeline guarantees `version > previousPublishedVersion` and will not publish otherwise.

### 7.2 Age

`issuedAt` is the bundle's build time. The app applies two thresholds, both from DESIGN 3.4:

| Age of the **installed** bundle | Behaviour |
|---|---|
| < 14 days | Normal. |
| >= 14 days | FORTIFY and the shield sheet show "Filters stale". Blocking continues with what is installed. |

| Age of a **candidate** manifest | Behaviour |
|---|---|
| < 14 days | Eligible. |
| >= 14 days | Rejected at verification step 9. |

The boundary is closed: `now - issuedAt >= 14 days` is a rejection, so a manifest exactly 14 days
old is refused and one 13 days 23 h old is accepted. Section 14 item 6 pins that arithmetic, and
the pipeline's own `verify` command applies the same comparison.

Never delete or disable installed filters because they are stale. Stale blocking is far better
than no blocking, and a device that has been offline for a month must still block ads when it
comes back. `expiresAt` in the manifest is informational and equals `issuedAt + 14 days`; the app
computes age from `issuedAt` so that a manifest cannot extend its own life.

---

## 8. What to download, and how to install it

### 8.1 Flavour selection

Choose by the **device's** iOS major version at run time, never by the build SDK:

| Device | Flavour |
|---|---|
| iOS 26 and later | `ios26` |
| iOS 17.0 - 25.x | `ios17` |

`ios26` buckets use vocabulary Safari 26 added (`request-method`, `unless-frame-url`). Older
WebKit silently ignores trigger keys it does not recognise, which would **widen** those rules
rather than fail — a quiet loss of precision, not a visible error. That is why the flavour is
picked from the running OS and why the app never carries `ios26` buckets onto an older system.

`ios17` buckets are produced by SafariConverterLib with `SafariVersion.safari16_4`, which is the
newest vocabulary Safari 17 understands. The flavour name refers to the **minimum** iOS it
targets, not to a Safari version number.

A device that upgrades its iOS major must re-download the whole set in the new flavour. The app
detects this by storing the flavour alongside the installed version and comparing on launch.

### 8.2 Which buckets

Install every bucket where **either** `optIn` is `false`, **or** `optIn` is `true` and at least
one id in its `lists` array is enabled in the owner's settings. `janus.active` is always
installed. Skipping a non-opt-in bucket is not a supported configuration: the exception
replication in the pipeline assumes every bucket of a family is present, and omitting one can
turn a site's unbreak exception into a broken page.

### 8.3 Delta downloads

Compare each wanted bucket's `sha256` (decompressed identity) with the one recorded for the
installed bundle. Equal means the compiled list already in `WKContentRuleListStore` is correct:
do not download, do not recompile, just carry the identifier forward into the new version's
record. This is what keeps a daily update to a handful of megabytes and a few recompiles
(DESIGN 3.4 targets: under 5 MB, under 3 recompiled buckets).

### 8.4 `layoutVersion`

When `layoutVersion` differs from the installed bundle's, bucket keys were re-hashed and no
`sha256` comparison is meaningful. Download **every** wanted bucket, compile them all, swap, and
then remove every identifier belonging to the old layout. The pipeline changes `layoutVersion`
only in a deliberate, reviewed commit (PIPELINE section 10.3), so this is a rare, planned,
single-day cost.

### 8.5 Rule-list identifiers and compiling

The identifier handed to `WKContentRuleListStore` is:

```
<bucket.id>.<first 8 hex chars of the flavour entry's sha256>
```

For example `janus.net.ads.00.3f0a1c2d`. Properties the app depends on:

- The bucket id is a **prefix** of the identifier, so DESIGN 3.7's allowlist call can pass
  `exceptions: ["janus.net.security.00.<sha8>", ...]` built by matching the `janus.net.security.`
  prefix. Never reorder the identifier's parts.
- A changed bucket yields a different identifier, so the old compiled list stays valid and usable
  until the new one has compiled — which is what makes the swap in step 18 atomic.
- Identifiers are case-sensitive and must be used verbatim.

Compiling, per DESIGN 3.4 and [V-ae]:

- Call `lookUpContentRuleList(forIdentifier:)` first; compile only what is missing.
- Initiate `compileContentRuleList` **on the main actor**, one bucket at a time. WebKit does the
  work on its own queue and calls back on main; starting elsewhere is the iOS 26 crash Brave
  fixed in brave-core #31483.
- Do reads, decompression and hashing off-main; hop to main only for the compile call.
- Attach the **same** set of lists to every `WKUserContentController`, including private, reader
  and hidden loader web views.

### 8.6 Active action patterns

`janus.active` performs `redirect` actions, and WebKit runs `redirect` and `modify-headers` only
when `WKWebpagePreferences._activeContentRuleListActionPatterns` carries a matching pattern for
that list identifier. Set it in `webView(_:decidePolicyFor:preferences:decisionHandler:)` for
**every** navigation, main frame and subframes alike: WebKit checks the initiating frame's own
`DocumentLoader`, so patterns set only on the main frame leave every iframe without redirects
([V-ae]). The dictionary key is the full rule-list identifier from section 8.5, so it must be
rebuilt whenever a bucket's sha8 changes.

The pattern set for `janus.active` is the surrogate pattern list, which the app derives from
`payloads.siteFix` (section 10.3) rather than hard-coding.

---

## 9. Advanced rules

Content rules cannot express procedural cosmetics, scriptlets or list-supplied JavaScript. Those
travel as advanced rules and are answered per URL, in process, by SafariConverterLib's
`FilterEngine`.

### 9.1 The text payload

`advancedRules.<flavour>` names `advanced.<flavour>.txt.lzfse`: UTF-8 text, LF-separated, one
AdGuard-syntax rule per line, produced by `ContentBlockerConverter.convertArray(...)` with
`advancedBlocking: true` and concatenated in bucket-id order. It contains cosmetic rules that need
`ExtendedCss`, `#%#//scriptlet(...)` invocations, and — from trusted lists only — `#%#` JavaScript.

`FilterEngine` has no per-list switch, so this payload carries **only the default-on buckets**.
Each opt-in list's advanced rules travel in a file of their own, listed in
`advancedRules.<flavour>.optIn[]`:

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `file` | string | yes | `advanced.<flavour>.<optInSlug>.txt.lzfse`, same shape as the default payload. |
| `lists` | string[] | yes | The list ids this file belongs to. Install it only when one of them is enabled. |
| `ruleCount` | int | yes | Non-empty lines in the decompressed text. |
| `sha256` / `size` / `downloadSha256` / `downloadSize` | — | yes | Verified exactly like every other payload (section 6). |

**The app feeds `FilterEngine` the default payload plus only those opt-in files whose list the
owner has enabled**, concatenated in the manifest's order. Rules from a list nobody enabled must
never reach the engine: unlike a bucket, an advanced rule carries no list identity at lookup time.

`ruleCount: 0` with no `file` means that flavour has no advanced rules of that kind at all; it is
valid and the app installs nothing for it.

This text is the **authoritative** form of the advanced payload. The app builds its engine from
it with `WebExtension.buildFilterEngine(rules:)` and can always do so without any other asset.

`schemaVersion` on the flavour's entry is the **pipeline's** text schema (1 in contract 1), not the
library's.

### 9.2 Lookups

`WebExtension(containerURL:version:).lookup(pageUrl:topUrl:)` returns a `Configuration` with
`css: [String]`, `extendedCss: [String]`, `js: [String]`, `scriptlets: [Scriptlet(name, args)]`
and `engineTimestamp: Double`. The app turns that into one self-contained IIFE per host
(DESIGN 3.5), cached by `(engineTimestamp, host)`.

The `version:` argument must be the same Safari version the flavour was converted for, so that
the engine and the buckets agree about what has already been handled by content rules.

### 9.3 The prebuilt engine (optional)

`engine.<flavour>` may name `engine.<flavour>.tar.lzfse`: a tar of the `.webext` directory
`FilterEngine` writes — `rules.txt`, `rules.bin`, `engine.bin`, `meta.bin`. It exists purely to
save the device the cost of building the index.

Use it **only** when `engine.<flavour>.engineSchemaVersion` equals the `Schema.VERSION` of the
SafariConverterLib the app links (1 in 4.3.0). On any mismatch, on any unpack error, and on any
lookup failure afterwards, discard it and rebuild from the text payload of section 9.1. The app
must never require this asset: a bundle with no `engine` object at all is valid.

It is built from the **default-on** payload only. An owner who has enabled any opt-in list must
therefore ignore the prebuilt engine and build from the text files it installed (section 9.1);
using it anyway would silently drop every rule of the lists that owner turned on.

Unpack into the app's own container directory and never onto a path derived from the archive's
own entry names; reject entries with absolute paths, `..` components, symlinks, or names other
than the four expected files.

### 9.4 Scriptlet bodies and the remote-code boundary

Scriptlet **function bodies** are bundled with the app (`@adguard/scriptlets` 2.5.1, pinned in
`VERSIONS.json`). The bundle carries only scriptlet **names and arguments**. A list can therefore
choose which bundled function runs with which arguments; it cannot supply code.

The app's scriptlet runtime is deliberately newer than the converter's: SafariConverterLib 4.3.0
reports `ContentBlockerConverterVersion.scriptlets == "2.3.1"` and `extendedCSS == "2.1.1"`,
while the app ships 2.5.1 and 2.2.1. That is safe in this direction only. The converter
validates scriptlet syntax and passes names and arguments through; it never emits a body, so a
newer runtime is a superset — every name 2.3.1 accepts, 2.5.1 still implements. The pipeline's
own alias map is generated from 2.5.1, so `config/ubo-alias.json` can name a scriptlet the
converter has never heard of; that is why a name unknown to the app must be ignored rather than
treated as an error (section 9.2). `JanusConvert version` prints the library's numbers on every
run so the gap stays visible, and both sets of versions are recorded in `VERSIONS.json`. The
reverse skew — an app older than the converter — is what `minAppBuild` exists to prevent.

The exception is `#%#` JavaScript from trusted lists, which **is** remote code and runs on
matching sites. It exists only because DESIGN 3.5 accepts it, and it is constrained by three
things: the CI trust gate (PIPELINE section 8) restricts it to uAssets, AdGuard official lists
and the Janus list; the signature makes the pipeline the only possible source; and the owner can
switch it off. FORTIFY's "Allow list-supplied JavaScript" defaults to on, the manifest kill
switch `listSuppliedJavaScript` can disable it remotely, and executions are counted and shown.

When `listSuppliedJavaScript` is `false`, the app must drop `js` entries from every
`Configuration` while still applying `css`, `extendedCss` and `scriptlets`.

---

## 10. Auxiliary payloads

All three are JSON, LZFSE-compressed, verified exactly like buckets, and carry their own
`schemaVersion`. An app that does not understand a payload's `schemaVersion` ignores that payload
and continues; none of them is required for blocking to work.

### 10.1 `payloads.linkcleaner`

Feeds the top-level LinkCleaner (DESIGN 3.8). `$removeparam` is never shipped as content rules.

```json
{
  "schemaVersion": 1,
  "global": ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"],
  "byDomain": { "amazon.com": ["ref", "pd_rd_r"], "youtube.com": ["si"] },
  "regex": [ { "domains": ["example.com"], "pattern": "^ad_[0-9]+$" } ]
}
```

`global` applies to every URL. `byDomain` keys are eTLD+1, lower-case punycode, and apply to the
domain and its subdomains. `regex` patterns are JavaScript-flavoured, anchored as written, and
match a **parameter name**; an app that will not run untrusted regexes may ignore `regex`
entirely. Apply only to main-frame navigations, never to subresources.

### 10.2 `payloads.popupIndex`

The popup-domain index FLASH SUPPRESSANT loads in M2b (DESIGN 4.2).

```json
{ "schemaVersion": 1, "domains": ["popads.net", "propellerads.com"] }
```

Sorted, deduped, lower-case punycode eTLD+1 or exact host. It is evidence for the popup trust
model, not an enforcement list: `$popup` rules are also present in the network buckets as
document blocking.

### 10.3 `payloads.siteFix`

Everything the converter could not express that the app can act on, plus the hand-maintained
Janus fixes and the surrogate metadata.

```json
{
  "schemaVersion": 1,
  "csp": [ { "domains": ["example.com"], "csp": "script-src 'self'" } ],
  "surrogates": [
    {
      "id": "googletagservices-gpt",
      "patterns": ["https?://securepubads\\.g\\.doubleclick\\.net/tag/js/gpt\\.js"],
      "resourceTypes": ["script"],
      "unlessDomains": ["somesite.example"],
      "globals": ["googletag"]
    }
  ],
  "notes": [ { "domains": ["reddit.com"], "note": "promoted posts handled by scriptlet X" } ]
}
```

- `csp` entries are inert until the M3 spike proves a document-start `<meta http-equiv>` CSP is
  honoured (DESIGN 3.3 step 2). Until then the app ignores them or uses a scriptlet equivalent.
- `surrogates[]` is the authority for two things the app must not hard-code: the **active action
  pattern set** for `janus.active` (section 8.6), and the domains where the surrogate JavaScript
  layer must **not** run. `unlessDomains` is the same folded unbreak set the pipeline baked into
  the redirect and fallback-block triggers, so the native layer and the JS layer agree by
  construction. On an allowlisted site, or when `unlessDomains` matches, the payload is omitted
  and the real SDK loads (DESIGN 3.6a).
- `globals` names the SDK globals the surrogate predefines; used for diagnostics only.

### 10.4 `killSwitches`

Booleans, all `true` in a normal bundle. `false` means the app disables that capability for this
bundle, without an app update.

| Key | When `false` |
|---|---|
| `listSuppliedJavaScript` | Drop `js` entries from every advanced-rules lookup (section 9.4) |
| `scriptlets` | Drop `scriptlets` entries too; cosmetics still apply |
| `surrogates` | Do not set active action patterns for `janus.active`, and inject no surrogate JS layer; the fallback block rules still fire |
| `advancedRules` | Do not build or query the engine at all; content rules only |
| `extendedCss` | Apply `css` but not `extendedCss` |

A kill switch can only make Janus **less** active. There is no manifest field that can make it do
more, enable a capability the owner disabled, or change a default the owner set. That asymmetry is
deliberate: the bundle is signed, but it still arrives over the network, and DESIGN's second
principle is that remote input may only make Janus stricter.

The owner's own settings always win. A kill switch that is `true` does not turn anything on.

---

## 11. Failure behaviour

| Situation | App behaviour |
|---|---|
| No network | Keep the installed bundle. Retry on the next scheduled check. No UI. |
| `manifest.json` 404 or 5xx | Try `mirrors`. Then keep the installed bundle and record the failure. |
| Signature invalid, unknown `keyId`, malformed JSON | Reject. Record. **Do not** retry against a mirror expecting a different answer — a bad signature is not a transport problem. |
| `version <= installed` | Not an error. Record "already current" and stop. |
| `issuedAt` older than 14 days | Reject as stale. Record. |
| `contractVersion` or `minAppBuild` too high | Reject. Surface "app update needed" in FORTIFY. |
| A payload 404s, mismatches its hash, or fails to decompress | Abandon the whole update. Delete `Shield/Staged/<version>/`. Keep the installed bundle. |
| A staged bucket fails to compile | Abandon the swap; keep the old set. Run a bounded on-device bisect (max 8 compiles, idle or charging) and record the result in diagnostics (DESIGN 3.4). |
| Compile succeeds for some buckets only | Never swap. All or nothing. |
| Installed bundle older than 14 days | Keep blocking. Show "Filters stale" in the shield sheet and FORTIFY. |
| First launch, no bundle at all | Use the baseline compiled into the IPA (section 12). `ProtectionGate` holds live web views until lists are attached. |
| Engine payload unusable | Rebuild from `advanced.<flavour>.txt`. Never a user-visible failure. |
| Disk full while staging | Abandon, delete the staging directory, record. |

Two invariants sit above the table. **The app never ends up with fewer filters than it started
with because an update failed.** And **no failure path ever disables blocking to "get the page to
load"** — a broken page is a bug report; a silently unprotected page is a breach of the whole
design.

---

## 12. The baseline in the IPA

Every Janus build ships a complete, signed bundle inside the app, so a fresh install blocks ads
before it has ever reached the network (DESIGN 3.4, and an M2a acceptance criterion).

- The baseline is a normal bundle: the same manifest, the same signature, the same payload files,
  produced by the same pipeline run and copied into the app's resources by the private repo's
  build.
- The app verifies it with exactly the steps in section 6, including the signature. Being bundled
  is not a reason to skip verification; it is a reason for verification to be cheap and certain.
- The 14-day age rule does **not** apply to the baseline. It is a floor, not a candidate: it is
  used when nothing newer is installed, however old it is, and it is replaced by the first
  downloaded bundle whose `version` is greater.
- Both flavours' buckets ship, because one IPA runs on iOS 17 and on iOS 26.
- The baseline's `version` participates normally in the monotonic comparison, so reinstalling an
  older app build cannot roll a newer downloaded bundle backwards.

---

## 13. Forward compatibility

Guarantees the pipeline makes within contract version 1:

- Fields are added, never removed or repurposed. The app ignores unknown fields.
- `bucket.id`, `family` names, flavour names, the identifier format of section 8.5, the signature
  scheme, and the URL shapes in section 3 do not change.
- A new payload type appears under `payloads` with its own `schemaVersion`; an app that does not
  know it ignores it.
- A new flavour would appear in `flavours` alongside the existing ones, never replacing them
  within contract version 1.
- `keyId` changes only by adding a new key to the app's pinned map in an app update, with an
  overlap period in which both keys are pinned.

Changes that require a new `contractVersion`: removing or renaming a required field, changing the
signed-bytes definition, changing the identifier format, or changing the meaning of `version` or
`layoutVersion`.

---

## 14. Conformance

The app and the pipeline must agree on these, and each has a test that pins it:

1. **keyId derivation** — SHA-256 of the raw 32 public-key bytes, first 16 hex chars, equals
   `d6ff9fb88ae9b930`.
2. **Signature round trip** — the pipeline's `verify` command and the app's verifier accept the
   same manifest/signature pair and both reject a single flipped byte anywhere in the manifest.
3. **Identifier derivation** — given a bucket id and a `sha256`, both sides produce the same
   `<id>.<sha8>`.
4. **Flavour selection** — iOS 17.0 through 25.x maps to `ios17`; 26.0 and later to `ios26`.
5. **Version comparison** — `2026091300 > 2026091299`, and equal versions are not updates.
6. **Age arithmetic** — a manifest with `issuedAt` exactly 14 days old is rejected; 13 days 23 h
   is accepted.
7. **Size guards** — a payload whose decompressed length differs from `size` by one byte is
   rejected.

Shared test vectors for 1-6 live in `test/fixtures/contract/` in this repository and are copied
into the app's `TestVectors/` (DESIGN 9.1), so a divergence between the two implementations shows
up as a failing unit test on both sides rather than as a phone that quietly stops updating:

| File | Item | Contents |
|---|---|---|
| `keyid.json` | 1 | `publicKeyBase64` -> `keyId`, including the pinned key. |
| `signature.json` | 2 | A manifest as literal text, its `sha256`, an Ed25519 signature, the public key that verifies it, and the mutations that must be rejected. The key is a throwaway generated for the vector: no private key exists in this repository. |
| `identifier.json` | 3 | `bucketId` + `sha256` -> `<id>.<sha8>`. |
| `flavour.json` | 4 | iOS major -> flavour, plus the majors that must be refused. |
| `version.json` | 5 | candidate/installed pairs -> is it an update. |
| `age.json` | 6 | `issuedAt` + `now` -> accept or reject, with the 14-day boundary and the 24 h skew limit. |

`test/contract.test.mjs` runs every one of them through the pipeline's own code
(`src/lib/contract.mjs` and `src/stages/verify.mjs`), so the vectors cannot drift from the
implementation that produces bundles. Item 7 is behavioural rather than tabular: each side asserts
it against its own download path.
