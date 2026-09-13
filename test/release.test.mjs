// SPDX-License-Identifier: GPL-3.0-or-later
//
// The release side of the pipeline: pack (PIPELINE 15), sign (15.2) and verify
// (CONTRACT 6). These stages never see a real signing key outside the
// filters-release environment, so the round trip is exercised with a throwaway
// Ed25519 key and sign's --key-env / --public-key / --key-id overrides. The
// pinned public key is only ever used here to check that it still derives the
// pinned keyId; no private key exists in this repository.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as pack from "../src/stages/pack.mjs";
import * as sign from "../src/stages/sign.mjs";
import * as verify from "../src/stages/verify.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const LISTS = path.join(ROOT, "test", "fixtures", "lists", "lists.json");
const FLAVOUR = "ios17";

/** Two buckets is enough to prove ordering, deltas and the manifest shape. */
const BUCKETS = {
  "janus.active": { family: "net.ads", ruleCount: 2, sourceLists: ["fx.adguard"] },
  "janus.net.ads.00": { family: "net.ads", ruleCount: 3, sourceLists: ["fx.adguard", "fx.ubo"] },
};

const AUX = {
  "killswitches.json": {
    schemaVersion: 1,
    killSwitches: {
      listSuppliedJavaScript: true,
      scriptlets: true,
      surrogates: true,
      advancedRules: true,
      extendedCss: true,
    },
  },
  "linkcleaner.json": { schemaVersion: 1, params: ["utm_source"] },
  "popup-index.json": { schemaVersion: 1, domains: ["example.com"] },
  "sitefix.json": { schemaVersion: 1, entries: [], csp: {}, surrogates: {}, notes: [] },
};

function contentRules(count) {
  return Array.from({ length: count }, (_, i) => ({
    action: { type: "block" },
    trigger: { "url-filter": `^https?://ads-${i}\\.example/` },
  }));
}

/**
 * Builds the smallest tree pack accepts: the bucket index, the aux payloads, a
 * prepared stub per fixture list, one converted flavour, a validate report and a
 * build/dist that already holds the compressed payloads. The .lzfse files are
 * plain copies on purpose - pack hashes whatever bytes it finds there and must
 * never re-compress on ubuntu (PIPELINE 15.1).
 */
function buildTree({ killSwitchesFlat = false, previousVersion = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "janus-release-"));
  const build = path.join(dir, "build");
  const at = (...parts) => path.join(build, ...parts);
  for (const sub of [
    "buckets",
    "auxdata",
    "prepared",
    "dist",
    path.join("converted", FLAVOUR),
    path.join("validate", FLAVOUR),
  ]) {
    mkdirSync(at(sub), { recursive: true });
  }

  writeFileSync(at("buckets", "index.json"), JSON.stringify({ buckets: BUCKETS }, null, 2));
  for (const [id, entry] of Object.entries(BUCKETS)) {
    writeFileSync(at("buckets", `${id}.txt`), `||ads-${id}.example^\n`);
    const json = JSON.stringify(contentRules(entry.ruleCount));
    writeFileSync(at("converted", FLAVOUR, `${id}.json`), json);
    writeFileSync(
      at("converted", FLAVOUR, `${id}.conv.json`),
      JSON.stringify({ bucketId: id, flavour: FLAVOUR, errorsCount: 0, convertedCount: entry.ruleCount }),
    );
    // Stands in for RuleListValidate --compress.
    writeFileSync(at("dist", `${id}.${FLAVOUR}.json.lzfse`), json);
  }

  for (const [name, doc] of Object.entries(AUX)) {
    const value =
      name === "killswitches.json" && killSwitchesFlat ? doc.killSwitches : doc;
    writeFileSync(at("auxdata", name), JSON.stringify(value, null, 2));
  }
  for (const [src, dst] of [
    ["linkcleaner.json", "linkcleaner.json.lzfse"],
    ["popup-index.json", "popup-index.json.lzfse"],
    ["sitefix.json", "sitefix.json.lzfse"],
  ]) {
    cpSync(at("auxdata", src), at("dist", dst));
  }

  const advanced = "example.com#%#//scriptlet('set-constant', 'a', '1')\n";
  writeFileSync(at("converted", FLAVOUR, "advanced.txt"), advanced);
  writeFileSync(at("dist", `advanced.${FLAVOUR}.txt.lzfse`), advanced);

  writeFileSync(
    at("validate", FLAVOUR, "report.json"),
    JSON.stringify({
      tool: "RuleListValidate",
      flavour: FLAVOUR,
      status: "ok",
      buckets: Object.entries(BUCKETS).map(([id, entry]) => ({
        bucketId: id,
        ruleCount: entry.ruleCount,
        compileMs: 11,
        sha256: createHash("sha256")
          .update(readFileSync(at("converted", FLAVOUR, `${id}.json`)))
          .digest("hex"),
        rewritten: false,
        error: null,
      })),
    }),
  );

  // Every list in lists.json must be present or pack refuses to publish a partial
  // set, so each one gets a prepared stub and a rule count.
  const lists = JSON.parse(readFileSync(LISTS, "utf8")).lists;
  for (const list of lists) {
    writeFileSync(at("prepared", `${list.id}.txt`), "||stub.example^\n");
    writeFileSync(at("prepared", `${list.id}.stats.json`), JSON.stringify({ kept: 7 }));
  }

  if (previousVersion !== null) {
    writeFileSync(
      at("previous-manifest.json"),
      JSON.stringify({ version: previousVersion, buckets: [], flavours: [FLAVOUR] }),
    );
  }
  return { dir, build };
}

function packArgs(build, extra = {}) {
  return {
    buildDir: build,
    configDir: CONFIG_DIR,
    rootDir: ROOT,
    listsPath: LISTS,
    versionsPath: path.join(ROOT, "VERSIONS.json"),
    // One flavour is enough to prove the manifest shape; a real publish must
    // carry both, which is why the guard has to be waived here explicitly.
    args: { flavours: FLAVOUR, quiet: true, "allow-partial-flavours": true, ...extra },
  };
}

/** An Ed25519 key that exists only for the length of this test file. */
function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(jwk.x, "base64url");
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }),
    base64: raw.toString("base64"),
    keyId: verify.keyIdFromRawPublicKey(raw),
  };
}

const temps = [];
function tree(options) {
  const made = buildTree(options);
  temps.push(made.dir);
  return made;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("pack (PIPELINE 15)", () => {
  let build;
  let manifestBytes;
  let manifest;

  before(async () => {
    build = tree().build;
    await pack.run(packArgs(build));
    manifestBytes = readFileSync(path.join(build, "dist", "manifest.json"));
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  });

  it("writes the manifest keys in the fixed CONTRACT 4.2 order", () => {
    const present = pack.MANIFEST_KEY_ORDER.filter((key) => key in manifest);
    assert.deepEqual(Object.keys(manifest), present);
    // The keys the app must always find.
    for (const key of [
      "contractVersion",
      "schemaVersion",
      "layoutVersion",
      "version",
      "issuedAt",
      "expiresAt",
      "keyId",
      "minAppBuild",
      "baseUrl",
      "flavours",
      "buckets",
    ]) {
      assert.ok(key in manifest, `manifest is missing ${key}`);
    }
  });

  it("signs exact bytes: the manifest ends at the final brace", () => {
    assert.equal(manifestBytes.at(-1), "}".charCodeAt(0));
    assert.equal(manifestBytes.toString("utf8"), JSON.stringify(manifest, null, 2));
  });

  it("pins the contract, the key and the layout the app checks", () => {
    assert.equal(manifest.contractVersion, pack.CONTRACT_VERSION);
    assert.equal(manifest.keyId, verify.KEY_ID);
    const config = JSON.parse(readFileSync(path.join(CONFIG_DIR, "buckets.json"), "utf8"));
    assert.equal(manifest.layoutVersion, config.layoutVersion);
    assert.equal(manifest.minAppBuild, config.minAppBuild);
  });

  it("expires exactly 14 days after issuedAt", () => {
    const issued = Date.parse(manifest.issuedAt);
    const expires = Date.parse(manifest.expiresAt);
    assert.equal(expires - issued, pack.EXPIRY_DAYS * 86400 * 1000);
  });

  it("names every bucket and every payload under a pinned origin", () => {
    assert.deepEqual(
      manifest.buckets.map((b) => b.id),
      Object.keys(BUCKETS).sort(),
    );
    const origins = [manifest.baseUrl, ...(manifest.mirrors ?? [])];
    for (const url of origins) {
      assert.ok(
        url.startsWith(pack.RELEASE_HOST_PREFIX) || url.startsWith(pack.PAGES_HOST_PREFIX),
        `${url} is not one of the two pinned origins`,
      );
    }
  });

  it("records the kill switches whichever shape the active stage wrote", async () => {
    const flat = tree({ killSwitchesFlat: true }).build;
    await pack.run(packArgs(flat));
    const doc = JSON.parse(readFileSync(path.join(flat, "dist", "manifest.json"), "utf8"));
    assert.deepEqual(doc.killSwitches, manifest.killSwitches);
    assert.equal(doc.killSwitches.scriptlets, true);
  });

  it("keeps the version monotonic across a higher previous release", async () => {
    const dateVersion = manifest.version;
    const ahead = dateVersion + 500;
    const build2 = tree({ previousVersion: ahead }).build;
    await pack.run(packArgs(build2));
    const doc = JSON.parse(readFileSync(path.join(build2, "dist", "manifest.json"), "utf8"));
    assert.equal(doc.version, ahead + 1);
    assert.equal(doc.delta.previousVersion, ahead);
  });

  it("keeps the bucket's optIn flag from the bucket index and isolates opt-in advanced rules", async () => {
    const { build: optInBuild } = tree();
    // A default list's exceptions are replicated into opt-in groups, so an opt-in
    // bucket legitimately lists default lists among its sources: pack must trust
    // the flag the bucket stage wrote, not re-derive it (PIPELINE 15.2).
    const indexPath = path.join(optInBuild, "buckets", "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    index.buckets["janus.net.ads.00"].optIn = true;
    index.buckets["janus.net.ads.00"].optInSlug = "fx-optin";
    writeFileSync(indexPath, JSON.stringify(index, null, 2));

    // One opt-in advanced payload beside the default one.
    const optInText = "optin.example#%#//scriptlet('set-constant', 'b', '2')\n";
    writeFileSync(path.join(optInBuild, "converted", FLAVOUR, "advanced.fx-optin.txt"), optInText);
    writeFileSync(
      path.join(optInBuild, "dist", `advanced.${FLAVOUR}.fx-optin.txt.lzfse`),
      optInText,
    );

    await pack.run(packArgs(optInBuild));
    const doc = JSON.parse(readFileSync(path.join(optInBuild, "dist", "manifest.json"), "utf8"));
    assert.equal(doc.buckets.find((b) => b.id === "janus.net.ads.00").optIn, true);
    assert.equal(doc.buckets.find((b) => b.id === "janus.active").optIn, false);

    const advanced = doc.advancedRules[FLAVOUR];
    assert.equal(advanced.file, `advanced.${FLAVOUR}.txt.lzfse`);
    assert.equal(advanced.optIn.length, 1);
    assert.equal(advanced.optIn[0].file, `advanced.${FLAVOUR}.fx-optin.txt.lzfse`);
    assert.deepEqual(advanced.optIn[0].lists, ["fx.optin"]);
    assert.equal(advanced.optIn[0].ruleCount, 1);
    // Every payload the manifest names, opt-in files included, is verifiable.
    const files = verify.manifestFileEntries(doc).map((entry) => entry.file);
    assert.ok(files.includes(`advanced.${FLAVOUR}.fx-optin.txt.lzfse`));
  });

  it("refuses to pack a bucket WebKit never compiled", async () => {
    const { build: unvalidated } = tree();
    const reportPath = path.join(unvalidated, "validate", FLAVOUR, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.buckets = report.buckets.filter((row) => row.bucketId !== "janus.net.ads.00");
    writeFileSync(reportPath, JSON.stringify(report));
    await assert.rejects(pack.run(packArgs(unvalidated)), (err) => {
      assert.equal(err.exitCode, 3);
      assert.match(err.message, /no row in build\/validate/);
      return true;
    });
  });

  it("refuses to sign bytes the validator did not compile", async () => {
    const { build: drifted } = tree();
    const reportPath = path.join(drifted, "validate", FLAVOUR, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const row of report.buckets) row.sha256 = "0".repeat(64);
    writeFileSync(reportPath, JSON.stringify(report));
    await assert.rejects(pack.run(packArgs(drifted)), (err) => {
      assert.equal(err.exitCode, 5);
      assert.match(err.message, /the validator compiled sha256/);
      return true;
    });
  });

  it("refuses a partial flavour set unless the waiver is explicit", async () => {
    const { build: partial } = tree();
    await assert.rejects(
      pack.run({
        buildDir: partial,
        configDir: CONFIG_DIR,
        rootDir: ROOT,
        listsPath: LISTS,
        versionsPath: path.join(ROOT, "VERSIONS.json"),
        args: { flavours: FLAVOUR, quiet: true },
      }),
      (err) => {
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /ios26 are missing/);
        return true;
      },
    );
  });

  it("refuses to invent a payload it cannot compress", async () => {
    const { build: build3 } = tree();
    rmSync(path.join(build3, "dist", `janus.active.${FLAVOUR}.json.lzfse`));
    await assert.rejects(pack.run(packArgs(build3)), (err) => {
      assert.equal(err.exitCode, 3);
      assert.match(err.message, /prepare-payloads/);
      return true;
    });
  });
});

describe("sign and verify (PIPELINE 15.2, CONTRACT 5 and 6)", () => {
  it("the pinned public key still derives the pinned keyId", () => {
    const raw = Buffer.from(verify.PUBLIC_KEY_BASE64, "base64");
    assert.equal(raw.length, 32);
    assert.equal(verify.keyIdFromRawPublicKey(raw), verify.KEY_ID);
    assert.equal(verify.KEY_ID, "d6ff9fb88ae9b930");
  });

  it("round-trips a manifest through Ed25519 and checks every payload hash", async () => {
    const build = tree().build;
    await pack.run(packArgs(build));
    const key = throwawayKey();
    const manifestPath = path.join(build, "dist", "manifest.json");
    // The manifest must name the key that signs it (CONTRACT 6 step 3).
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    doc.keyId = key.keyId;
    writeFileSync(manifestPath, JSON.stringify(doc, null, 2));

    const env = { JANUS_TEST_SIGNING_KEY: key.pem };
    const previous = process.env.JANUS_TEST_SIGNING_KEY;
    process.env.JANUS_TEST_SIGNING_KEY = env.JANUS_TEST_SIGNING_KEY;
    try {
      const signed = await sign.run({
        argv: [
          "--manifest", manifestPath,
          "--key-env", "JANUS_TEST_SIGNING_KEY",
          "--public-key", key.base64,
          "--key-id", key.keyId,
        ],
      });
      assert.equal(signed.ok, true);
      assert.equal(signed.keyId, key.keyId);

      const sigText = readFileSync(`${manifestPath}.sig`, "utf8");
      assert.ok(sigText.endsWith("\n"), "the signature file ends with one newline");
      assert.equal(Buffer.from(sigText.trim(), "base64").length, verify.SIGNATURE_BYTES);

      const checked = await verify.run({
        argv: [
          "--manifest", manifestPath,
          "--sig", `${manifestPath}.sig`,
          "--key", key.base64,
          "--dir", path.join(build, "dist"),
          "--require-complete",
        ],
      });
      assert.equal(checked.ok, true);
      assert.equal(checked.filesMissing, 0);
      assert.ok(checked.filesChecked >= Object.keys(BUCKETS).length);

      // One flipped bit in the signature, and nothing verifies.
      const bad = Buffer.from(sigText.trim(), "base64");
      bad[0] ^= 0xff;
      writeFileSync(`${manifestPath}.sig`, `${bad.toString("base64")}\n`);
      await assert.rejects(
        verify.run({
          argv: [
            "--manifest", manifestPath,
            "--sig", `${manifestPath}.sig`,
            "--key", key.base64,
            "--skip-hashes",
          ],
        }),
        (err) => {
          assert.equal(err.exitCode, 5);
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.JANUS_TEST_SIGNING_KEY;
      else process.env.JANUS_TEST_SIGNING_KEY = previous;
    }
  });

  it("refuses a key that is not the one the app pins", async () => {
    const build = tree().build;
    await pack.run(packArgs(build));
    const key = throwawayKey();
    assert.notEqual(key.keyId, verify.KEY_ID);
    const previous = process.env.JANUS_TEST_SIGNING_KEY;
    process.env.JANUS_TEST_SIGNING_KEY = key.pem;
    try {
      await assert.rejects(
        sign.run({
          argv: [
            "--manifest", path.join(build, "dist", "manifest.json"),
            "--key-env", "JANUS_TEST_SIGNING_KEY",
          ],
        }),
        (err) => {
          assert.equal(err.exitCode, 5);
          assert.match(err.message, /pin/);
          // The key itself is never echoed into an error message.
          assert.ok(!err.message.includes("PRIVATE KEY"));
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.JANUS_TEST_SIGNING_KEY;
      else process.env.JANUS_TEST_SIGNING_KEY = previous;
    }
  });

  it("exits 2, not 1, when the signing environment is absent", async () => {
    const build = tree().build;
    await pack.run(packArgs(build));
    const previous = process.env.JANUS_MISSING_KEY_ENV;
    delete process.env.JANUS_MISSING_KEY_ENV;
    await assert.rejects(
      sign.run({
        argv: [
          "--manifest", path.join(build, "dist", "manifest.json"),
          "--key-env", "JANUS_MISSING_KEY_ENV",
        ],
      }),
      (err) => {
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
    if (previous !== undefined) process.env.JANUS_MISSING_KEY_ENV = previous;
  });

  it("rejects a bundle older than the 14-day maximum age (CONTRACT 7.2)", () => {
    const now = Date.parse("2026-09-13T00:00:00Z");
    const fresh = { issuedAt: "2026-09-12T00:00:00Z", expiresAt: "2026-09-26T00:00:00Z" };
    assert.ok(verify.checkFreshness(fresh, now).ageDays < verify.MAX_AGE_DAYS);
    const stale = { issuedAt: "2026-08-01T00:00:00Z", expiresAt: "2026-08-15T00:00:00Z" };
    // Every rejection inside verify is an integrity failure, exit 5 (PIPELINE 15.4).
    assert.throws(
      () => verify.checkFreshness(stale, now),
      (err) => {
        assert.equal(err.exitCode, 5);
        assert.match(err.message, /days old/);
        return true;
      },
    );
    // A window that is not exactly 14 days is refused too.
    assert.throws(() =>
      verify.checkFreshness(
        { issuedAt: "2026-09-12T00:00:00Z", expiresAt: "2026-10-12T00:00:00Z" },
        now,
      ),
    );
  });

  it("only accepts a 32-byte raw key and a 64-byte signature", () => {
    assert.throws(() => verify.publicKeyFromRaw(Buffer.alloc(31)));
    assert.throws(() => verify.decodeSignature(Buffer.alloc(63).toString("base64")));
    assert.equal(verify.decodeSignature(Buffer.alloc(64).toString("base64")).length, 64);
  });
});
