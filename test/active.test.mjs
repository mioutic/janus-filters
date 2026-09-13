// PIPELINE section 11. This is the part where WebKit's hash-order list visiting
// and its block/redirect de-duplication decide whether a surrogate works, so the
// order and the tails are pinned byte for byte.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { foldDecision, regexRuleText, run as runActive } from "../src/stages/active.mjs";
import { run as runFetch } from "../src/stages/fetch.mjs";
import { run as runPreprocess } from "../src/stages/preprocess.mjs";
import { run as runTrustgate } from "../src/stages/trustgate.mjs";
import { run as runTranslate } from "../src/stages/translate.mjs";
import { run as runBucket } from "../src/stages/bucket.mjs";
import { matchesUrl, regexToProbeUrls } from "../src/lib/match.mjs";
import { parseRule } from "../src/lib/rule.mjs";
import { readJson, readLines } from "../src/lib/io.mjs";
import { CONFIG_DIR, removeDir, tempBuildDir, testContext } from "./fixtures/helpers.mjs";

const SURROGATES = JSON.parse(await readFile(path.join(CONFIG_DIR, "surrogates.json"), "utf8"));
const rule = (text) => ({ ...parseRule(text), text });

async function buildThroughBucket(buildDir) {
  await runFetch(await testContext({ stage: "fetch", buildDir }));
  await runPreprocess(await testContext({ stage: "preprocess", buildDir }));
  await runTrustgate(await testContext({ stage: "trustgate", buildDir }));
  await runTranslate(await testContext({ stage: "translate", buildDir }));
  await runBucket(await testContext({ stage: "bucket", buildDir }));
}

test("the surrogate set is the DESIGN 3.6 target list, in config order", () => {
  assert.deepEqual(
    SURROGATES.surrogates.map((surrogate) => surrogate.id),
    [
      "google-ima3",
      "googletagservices-gpt",
      "googlesyndication-adsbygoogle",
      "amazon-apstag",
      "prebid",
      "noopvast-4.0",
      "noopvmap-1.0",
      "noopmp4-1s",
    ],
  );
});

test("no surrogate may target a document or an image", () => {
  for (const surrogate of SURROGATES.surrogates) {
    for (const type of surrogate.resourceTypes) {
      assert.ok(!["document", "top-document", "child-document", "image"].includes(type), type);
    }
    assert.ok(surrogate.resourceTypes.length > 0);
    assert.ok(surrogate.sha256.length === 64);
  }
});

test("a pattern becomes a filter rule with the matching resource modifiers", () => {
  assert.equal(regexRuleText("^https?://x\\.example/a\\.js", ["script"]), "/^https?://x\\.example/a\\.js/$script");
  assert.equal(regexRuleText("/vast", ["raw"]), "//vast/$xmlhttprequest");
  assert.equal(regexRuleText("/clip\\.mp4", ["media"]), "//clip\\.mp4/$media");
  assert.equal(
    regexRuleText("^https?://x\\.example/a\\.js", ["script"], { exception: true }),
    "@@/^https?://x\\.example/a\\.js/$script",
  );
  assert.equal(
    regexRuleText("^https?://x\\.example/a\\.js", ["script"], { unlessDomains: ["news.example"] }),
    "/^https?://x\\.example/a\\.js/$script,domain=~news.example",
  );
  assert.throws(() => regexRuleText("x", ["document"]));
  assert.throws(() => regexRuleText("x", ["nonsense"]));
});

test("only a domain-scoped exception folds into a trigger", () => {
  assert.deepEqual(foldDecision(rule("@@||x.example/a.js$domain=news.example")), {
    fold: true,
    domains: ["news.example"],
  });
  assert.deepEqual(foldDecision(rule("@@||x.example/a.js$domain=a.example|b.example")), {
    fold: true,
    domains: ["a.example", "b.example"],
  });
  assert.equal(foldDecision(rule("@@||x.example/a.js")).fold, false);
  assert.equal(foldDecision(rule("@@||x.example/a.js")).reason, "unscoped");
  assert.equal(foldDecision(rule("@@||x.example/a.js$domain=~news.example")).fold, false);
  assert.equal(foldDecision(rule("@@||x.example/a.js$domain=~news.example")).reason, "negated-domain");
});

test("redirects come first, then the fallback blocks, then the appended exceptions", async () => {
  const buildDir = await tempBuildDir();
  try {
    await buildThroughBucket(buildDir);
    const summary = await runActive(await testContext({ stage: "active", buildDir }));

    const redirects = await readJson(path.join(buildDir, "auxdata", "active-redirects.json"));
    // Section 1: one redirect rule per pattern, in config order.
    assert.deepEqual(
      redirects.rules.map((entry) => entry.surrogate),
      SURROGATES.surrogates.flatMap((surrogate) => surrogate.patterns.map(() => surrogate.id)),
    );
    // An offline run never reads the pinned package, so the body stays a named
    // placeholder and the tree is identical with or without node_modules.
    assert.equal(redirects.embedded, false);
    assert.equal(summary.embeddedBodies, 0);
    for (const entry of redirects.rules) {
      // WebKit's RedirectAction::parse requires action.redirect to be an object;
      // a flat action.url is JSONRedirectMissing and the list will not compile.
      assert.equal(entry.action.type, "redirect");
      assert.equal(typeof entry.action.redirect, "object");
      assert.equal(entry.action.url, undefined);
      assert.equal(typeof entry.action.redirect.dataUrlFrom.file, "string");
      assert.equal(entry.action.redirect.dataUrlFrom.sha256.length, 64);
      assert.ok(Array.isArray(entry.trigger["resource-type"]));
    }

    // The kill switches ship with the bundle and start out all true (CONTRACT 10.4).
    const killswitches = await readJson(path.join(buildDir, "auxdata", "killswitches.json"));
    assert.deepEqual(killswitches.killSwitches, {
      listSuppliedJavaScript: true,
      scriptlets: true,
      surrogates: true,
      advancedRules: true,
      extendedCss: true,
    });

    const active = await readLines(path.join(buildDir, "buckets", "janus.active.txt"));
    // Section 2 in the same order, with no ignore-previous-rules between.
    const fallbacks = active.slice(0, active.length - summary.appendedExceptions);
    assert.equal(fallbacks.length, redirects.rules.length);
    for (const line of fallbacks) assert.ok(!line.startsWith("@@"), line);
    for (let index = 0; index < fallbacks.length; index += 1) {
      assert.ok(fallbacks[index].includes(redirects.rules[index].trigger["url-filter"]));
    }
    // Section 3: what a trigger cannot express, appended last.
    assert.deepEqual(active.slice(active.length - summary.appendedExceptions), [
      "@@||imasdk.googleapis.com/js/sdkloader/ima3.js",
    ]);

    // Folding: the unbreak exception became unless-domain on both rules.
    const gpt = redirects.rules.find((entry) => entry.surrogate === "googletagservices-gpt");
    assert.deepEqual(gpt.trigger["unless-domain"], ["*news.example"]);
    assert.ok(
      fallbacks.some((line) => line.includes("domain=~news.example")),
      "the fallback block must carry the folded domain too",
    );

    const report = await readJson(path.join(buildDir, "reports", "surrogates.json"));
    const reported = report.surrogates.find((entry) => entry.id === "googletagservices-gpt");
    assert.deepEqual(reported.unlessDomains, ["news.example"]);
    assert.equal(reported.candidateBlocks, 1);
    assert.equal(reported.candidateExceptions, 1);
    assert.deepEqual(report.appended, [
      {
        rule: "@@||imasdk.googleapis.com/js/sdkloader/ima3.js",
        surrogate: "google-ima3",
        reason: "unscoped",
      },
    ]);

    // One source of truth for the JS layer.
    const sitefix = await readJson(path.join(buildDir, "auxdata", "sitefix.json"));
    const payload = sitefix.surrogates.find((entry) => entry.id === "googletagservices-gpt");
    assert.deepEqual(payload.unlessDomains, ["news.example"]);
    assert.deepEqual(payload.globals, ["googletag"]);
  } finally {
    await removeDir(buildDir);
  }
});

test("every network bucket ends with one ignore tail per surrogate pattern", async () => {
  const buildDir = await tempBuildDir();
  try {
    await buildThroughBucket(buildDir);
    await runActive(await testContext({ stage: "active", buildDir }));
    const index = await readJson(path.join(buildDir, "buckets", "index.json"));
    const patterns = SURROGATES.surrogates.flatMap((surrogate) => surrogate.patterns);

    let networkBuckets = 0;
    for (const [id, entry] of Object.entries(index.buckets)) {
      const lines = await readLines(path.join(buildDir, "buckets", `${id}.txt`));
      if (!entry.family.startsWith("net.")) {
        assert.ok(!lines.some((line) => line.startsWith("@@/")), id);
        continue;
      }
      networkBuckets += 1;
      const tail = lines.slice(lines.length - patterns.length);
      assert.equal(tail.length, patterns.length, id);
      for (let index2 = 0; index2 < patterns.length; index2 += 1) {
        assert.ok(tail[index2].startsWith("@@/"), id);
        assert.ok(tail[index2].includes(patterns[index2]), id);
      }
      assert.equal(entry.surrogateTailCount, patterns.length);
      assert.equal(entry.ruleCount, lines.length);
    }
    assert.ok(networkBuckets >= 9);

    // janus.active itself never gets a tail.
    const active = await readLines(path.join(buildDir, "buckets", "janus.active.txt"));
    assert.ok(!active.some((line) => line.startsWith("@@/")));

    // The tails are counted in the budget.
    const budget = await readJson(path.join(buildDir, "reports", "budget.json"));
    for (const row of budget.buckets) {
      if (!row.family.startsWith("net.")) continue;
      assert.equal(row.surrogateTailCount, patterns.length);
      assert.equal(row.estimatedConverted, row.inputCount);
    }
  } finally {
    await removeDir(buildDir);
  }
});

test("a surrogate probe matches the rules an upstream list writes for it", () => {
  const probes = SURROGATES.surrogates.flatMap((surrogate) =>
    surrogate.patterns.flatMap((pattern) => regexToProbeUrls(pattern)),
  );
  const hits = (pattern) => probes.filter((url) => matchesUrl(pattern, url));
  assert.ok(hits("||securepubads.g.doubleclick.net/tag/js/gpt.js").length >= 1);
  assert.ok(hits("||imasdk.googleapis.com/js/sdkloader/ima3.js").length >= 1);
  assert.ok(hits("||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js").length >= 1);
  assert.ok(hits("||c.amazon-adsystem.com/aax2/apstag.js").length >= 1);
  assert.ok(hits("/prebid.js").length >= 1);
  // A rule about an unrelated host must not be pulled in.
  assert.equal(hits("||unrelated.example/script.js").length, 0);
});
