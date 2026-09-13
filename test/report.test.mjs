// PIPELINE section 14. The report is how a loss becomes visible, so what it
// classifies, what it reconciles and what it flags are all pinned.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { classifyUnsupported, UNSUPPORTED_MODIFIERS, run as runReport } from "../src/stages/report.mjs";
import { run as runFetch } from "../src/stages/fetch.mjs";
import { run as runPreprocess } from "../src/stages/preprocess.mjs";
import { run as runTrustgate } from "../src/stages/trustgate.mjs";
import { run as runTranslate } from "../src/stages/translate.mjs";
import { run as runBucket } from "../src/stages/bucket.mjs";
import { run as runActive } from "../src/stages/active.mjs";
import { readJson, readText, writeJson } from "../src/lib/io.mjs";
import { removeDir, tempBuildDir, testContext } from "./fixtures/helpers.mjs";

async function buildAll(buildDir) {
  await runFetch(await testContext({ stage: "fetch", buildDir }));
  await runPreprocess(await testContext({ stage: "preprocess", buildDir }));
  await runTrustgate(await testContext({ stage: "trustgate", buildDir }));
  await runTranslate(await testContext({ stage: "translate", buildDir }));
  await runBucket(await testContext({ stage: "bucket", buildDir }));
  await runActive(await testContext({ stage: "active", buildDir }));
}

test("the unsupported table is the SafariConverterLib 4.3.0 README list", () => {
  for (const modifier of [
    "app", "cookie", "csp", "extension", "header", "hls", "inline-font", "inline-script",
    "jsonprune", "network", "permissions", "redirect", "redirect-rule", "referrerpolicy",
    "removeheader", "removeparam", "replace", "stealth", "to", "urltransform", "xmlprune",
  ]) {
    assert.ok(UNSUPPORTED_MODIFIERS.has(modifier), modifier);
  }
  for (const supported of ["third-party", "important", "script", "domain", "popup", "document"]) {
    assert.ok(!UNSUPPORTED_MODIFIERS.has(supported), supported);
  }
});

test("classification names the cause and the modifier", () => {
  assert.deepEqual(classifyUnsupported("||example.com^$replace=/a/b/"), {
    cause: "convert.unsupported-modifier",
    modifier: "$replace",
  });
  assert.deepEqual(classifyUnsupported("||example.com^$removeparam=utm_source"), {
    cause: "convert.unsupported-modifier",
    modifier: "$removeparam",
  });
  assert.deepEqual(classifyUnsupported("example.com##^script:has-text(ads)"), {
    cause: "convert.html-filtering",
  });
  assert.deepEqual(classifyUnsupported("example.com$$script[tag-content=ads]"), {
    cause: "convert.html-filtering",
  });
  assert.deepEqual(classifyUnsupported("example.com##+js(aopr, x)"), {
    cause: "convert.ubo-scriptlet",
  });
  assert.deepEqual(classifyUnsupported("||example.com^$domain=a.example|~b.a.example"), {
    cause: "convert.mixed-domain",
    modifier: "$domain",
  });
  assert.deepEqual(classifyUnsupported("/ads(?=x)/$script"), {
    cause: "convert.unsupported-regex",
  });
  // $method exists only in the newer flavour.
  assert.deepEqual(classifyUnsupported("||example.com^$method=get", "ios17"), {
    cause: "convert.flavour-modifier",
    modifier: "$method",
  });
  assert.equal(classifyUnsupported("||example.com^$method=get", "ios26"), null);
  // What the converter does express must not be reported as a loss.
  for (const supported of [
    "||example.com^$third-party,script",
    "@@||example.com^$document",
    "||example.com^$important",
    "example.com##.ad",
    "example.com#?#div:has-text(ads)",
    "example.com#%#//scriptlet('set-constant', 'a', '1')",
    "||example.com^$popup",
  ]) {
    assert.equal(classifyUnsupported(supported), null, supported);
  }
});

test("the stage attributes every cause to the list that carried the rule", async () => {
  const buildDir = await tempBuildDir();
  try {
    await buildAll(buildDir);
    const summary = await runReport(await testContext({ stage: "report", buildDir }));
    assert.ok(summary.dropped > 0);

    const adguard = await readJson(path.join(buildDir, "reports", "dropped", "fx.adguard.json"));
    assert.equal(adguard.schemaVersion, 1);
    assert.equal(adguard.listId, "fx.adguard");
    assert.equal(adguard.byCause["csp.translated"], 1);
    assert.equal(adguard.byCause["csp.generic"], 1);
    assert.equal(adguard.byCause["removeparam.translated"], 3);
    assert.equal(adguard.byCause["convert.unsupported-modifier"], 2);
    assert.equal(adguard.byModifier["$replace"], 1);
    assert.equal(adguard.byModifier["$removeheader"], 1);

    const untrusted = await readJson(path.join(buildDir, "reports", "dropped", "fx.untrusted.json"));
    assert.equal(untrusted.byCause["trust-gate"], 7);
    assert.ok(untrusted.samples.some((sample) => sample.cause === "trust-gate"));

    const ubo = await readJson(path.join(buildDir, "reports", "dropped", "fx.ubo.json"));
    assert.equal(ubo.byCause["scriptlet.no-alias"], 1);
    assert.equal(ubo.byScriptlet["hd-main"], 1);
    assert.equal(ubo.byCause["badfilter.no_match"], 1);

    const include = await readJson(path.join(buildDir, "reports", "dropped", "fx.include.json"));
    assert.equal(include.byCause["include.cross_origin"], 1);
    assert.equal(include.byCause["include.cycle"], 1);

    const ifmatrix = await readJson(path.join(buildDir, "reports", "dropped", "fx.ifmatrix.json"));
    assert.equal(ifmatrix.byCause["if.unknown_identifier"], 1);
    assert.equal(ifmatrix.byCause["if.parse_error"], 1);

    // Samples are capped and stable: at most 20 per cause, first occurrence first.
    for (const report of [adguard, untrusted, ubo]) {
      const perCause = {};
      for (const sample of report.samples) {
        perCause[sample.cause] = (perCause[sample.cause] ?? 0) + 1;
      }
      for (const count of Object.values(perCause)) assert.ok(count <= 20);
    }

    const markdown = await readText(path.join(buildDir, "reports", "dropped.md"));
    assert.ok(markdown.startsWith("# Dropped rules"));
    assert.ok(markdown.includes("## Watched sites"));
    assert.ok(markdown.includes("reddit.com"));
    assert.ok(markdown.includes("| fx.adguard |"));
    assert.ok(markdown.includes("$removeheader"));
  } finally {
    await removeDir(buildDir);
  }
});

test("reconciliation flags a drift larger than one per cent", async () => {
  const buildDir = await tempBuildDir();
  try {
    await buildAll(buildDir);
    // Pretend the converter agreed with us exactly.
    const first = await runReport(await testContext({ stage: "report", buildDir }));
    const ours = first.reconciliation.ours;
    await writeJson(path.join(buildDir, "converted", "ios26", "janus.net.ads.00.conv.json"), {
      discardedSafariRules: ours,
      errorsCount: 0,
    });
    const agreeing = await runReport(await testContext({ stage: "report", buildDir }));
    assert.equal(agreeing.reconciliation.available, true);
    assert.equal(agreeing.reconciliation.library, ours);
    assert.equal(agreeing.reconciliation.agrees, true);

    // Now make the library drop far more than we predicted.
    await writeJson(path.join(buildDir, "converted", "ios26", "janus.net.ads.00.conv.json"), {
      discardedSafariRules: ours + 100,
      errorsCount: 5,
    });
    const drifting = await runReport(await testContext({ stage: "report", buildDir }));
    assert.equal(drifting.reconciliation.agrees, false);
    const markdown = await readText(path.join(buildDir, "reports", "dropped.md"));
    assert.ok(markdown.includes("disagree by more than 1 %"));
  } finally {
    await removeDir(buildDir);
  }
});

test("a baseline produces day-over-day deltas and flags a large one", async () => {
  const buildDir = await tempBuildDir();
  const baselineDir = await tempBuildDir();
  try {
    await buildAll(buildDir);
    await runReport(await testContext({ stage: "report", buildDir }));
    const today = await readJson(path.join(buildDir, "reports", "dropped", "fx.adguard.json"));

    // Yesterday dropped nothing, so today is a large regression.
    await writeJson(path.join(baselineDir, "dropped", "fx.adguard.json"), {
      schemaVersion: 1,
      listId: "fx.adguard",
      counts: { in: today.counts.in, kept: today.counts.kept, dropped: 0 },
      byModifier: {},
      byScriptlet: {},
      byCause: {},
      samples: [],
    });
    await runReport(
      await testContext({ stage: "report", buildDir, baseline: baselineDir }),
    );
    const markdown = await readText(path.join(buildDir, "reports", "dropped.md"));
    const row = markdown.split("\n").find((line) => line.startsWith("| fx.adguard |"));
    assert.ok(row.includes(`+${today.counts.dropped}`), row);
    assert.ok(row.includes("**"), "a delta over 10 % of kept must be bold");
  } finally {
    await removeDir(buildDir);
    await removeDir(baselineDir);
  }
});
