// PIPELINE section 10. Everything here is normative: the hash, the five-section
// order and the replication rules. A change that makes one of these assertions
// fail is a full re-download for the phone, not a refactor.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cp, appendFile, readdir } from "node:fs/promises";
import {
  allBucketIds,
  bucketForKey,
  bucketIdFor,
  buildGroups,
  isCosmeticScopeException,
  familyOf,
  replicationTargets,
  sectionOf,
  run as runBucket,
} from "../src/stages/bucket.mjs";
import { run as runFetch } from "../src/stages/fetch.mjs";
import { run as runPreprocess } from "../src/stages/preprocess.mjs";
import { run as runTrustgate } from "../src/stages/trustgate.mjs";
import { run as runTranslate } from "../src/stages/translate.mjs";
import { bucketKey, parseRule } from "../src/lib/rule.mjs";
import { fnv1a32, pad2 } from "../src/lib/hash.mjs";
import { exists, readJson, readLines } from "../src/lib/io.mjs";
import { FIXTURES, removeDir, tempBuildDir, testContext } from "./fixtures/helpers.mjs";

const rule = (text) => {
  const parsed = parseRule(text);
  return { ...parsed, text };
};

async function buildThroughTranslate(buildDir, listsPath) {
  const options = { buildDir, listsPath };
  await runFetch(await testContext({ ...options, stage: "fetch" }));
  await runPreprocess(await testContext({ ...options, stage: "preprocess" }));
  await runTrustgate(await testContext({ ...options, stage: "trustgate" }));
  await runTranslate(await testContext({ ...options, stage: "translate" }));
}

test("bucket identifiers keep the family as a literal prefix", () => {
  const group = { family: "net.security", slug: null, B: 1, G: 1 };
  assert.equal(bucketIdFor(group, "keyed", 0), "janus.net.security.00");
  assert.equal(bucketIdFor(group, "gen", 0), "janus.net.security.gen00");
  assert.deepEqual(allBucketIds(group), ["janus.net.security.00", "janus.net.security.gen00"]);
  assert.ok(bucketIdFor(group, "keyed", 3).startsWith("janus.net.security."));
  assert.equal(bucketIdFor({ family: "net.ads", slug: null, B: 4, G: 1 }, "keyed", 11), "janus.net.ads.11");
});

test("the bucket is fnv1a32 of the key modulo B, and of the rule text for a host-less rule", () => {
  const group = { family: "net.ads", slug: null, B: 4, G: 2 };
  for (const key of ["example.com", "doubleclick.net", "ads.example.co.uk"]) {
    assert.equal(bucketForKey(group, key, "irrelevant"), `janus.net.ads.${pad2(fnv1a32(key) % 4)}`);
  }
  const text = "##.generic-advert";
  assert.equal(bucketForKey(group, "", text), `janus.net.ads.gen${pad2(fnv1a32(text) % 2)}`);
});

test("routing follows the rule, not the list, for cosmetics", () => {
  const netAds = { id: "l", family: "net.ads", default: true, role: "rules" };
  const netPrivacy = { id: "p", family: "net.privacy", default: true, role: "rules" };
  assert.equal(familyOf(rule("||ads.example^$third-party"), netAds), "net.ads");
  assert.equal(familyOf(rule("||track.example^"), netPrivacy), "net.privacy");
  assert.equal(familyOf(rule("example.com##.ad"), netPrivacy), "cos.specific");
  assert.equal(familyOf(rule("##.ad"), netPrivacy), "cos.generic");
  assert.equal(familyOf(rule("example.com#@#.ad"), netAds), "cos.specific");
  // A rule that is both follows its network family.
  assert.equal(familyOf(rule("@@||example.com^$elemhide,generichide"), netAds), "net.ads");
});

test("the bucket key is the host, else the first domain, else empty", () => {
  assert.equal(bucketKey(rule("||ads.example.co.uk/x.js$script")), "example.co.uk");
  assert.equal(bucketKey(rule("|https://ads.example.com/x")), "example.com");
  assert.equal(bucketKey(rule("$popup,domain=first.example|second.example")), "first.example");
  assert.equal(bucketKey(rule("/banner[0-9]+/$image")), "");
  assert.equal(bucketKey(rule("example.com,other.example##.ad")), "example.com");
  assert.equal(bucketKey(rule("##.ad")), "");
});

test("the five sections are exactly DESIGN 3.3 step 5", () => {
  assert.equal(sectionOf(rule("||ads.example^")), 1);
  assert.equal(sectionOf(rule("example.com##.ad")), 1);
  assert.equal(sectionOf(rule("@@||ads.example/ok.js$script")), 2);
  assert.equal(sectionOf(rule("example.com#@#.ad")), 2);
  assert.equal(sectionOf(rule("||ads.example^$important")), 3);
  assert.equal(sectionOf(rule("@@||ads.example^$important")), 4);
  assert.equal(sectionOf(rule("@@||example.org^$document")), 4);
  assert.equal(sectionOf(rule("@@||example.org^$urlblock")), 4);
});

test("replication: host-scoped, generic, document and multi-domain", async () => {
  const ctx = await testContext({ stage: "bucket" });
  try {
    const groups = buildGroups(ctx, await ctx.config.buckets());
    const netAds = groups.get("net.ads|");

    const hostScoped = rule("@@||ads.example.com/ok.js$script");
    assert.deepEqual(replicationTargets(groups, netAds, hostScoped, hostScoped.text), [
      `janus.net.ads.${pad2(fnv1a32("example.com") % 4)}`,
      "janus.net.ads.gen00",
    ]);

    const generic = rule("@@/banner/$image");
    assert.deepEqual(
      replicationTargets(groups, netAds, generic, generic.text),
      allBucketIds(netAds).sort(),
    );

    const documentAllowlist = rule("@@||example.org^$document");
    assert.deepEqual(
      replicationTargets(groups, netAds, documentAllowlist, documentAllowlist.text),
      allBucketIds(netAds).sort(),
    );

    const multi = rule("@@||ads.example^$domain=first.example|second.example");
    const expected = new Set([
      `janus.net.ads.${pad2(fnv1a32("example") % 4)}`,
      `janus.net.ads.${pad2(fnv1a32("first.example") % 4)}`,
      `janus.net.ads.${pad2(fnv1a32("second.example") % 4)}`,
      "janus.net.ads.gen00",
    ]);
    assert.deepEqual(
      replicationTargets(groups, netAds, multi, multi.text),
      [...expected].sort(),
    );

    // A cosmetic exception replicates inside cos.*, never into a network family.
    const cosmetic = rule("example.com#@#.sidebar-ad");
    const cosSpecific = groups.get("cos.specific|");
    for (const id of replicationTargets(groups, cosSpecific, cosmetic, cosmetic.text)) {
      assert.ok(id.startsWith("janus.cos."), id);
    }

    // $elemhide and friends are network rules with cosmetic scope: the rules they
    // must neutralise live in cos.*, and ignore-previous-rules only acts inside its
    // own list, so a copy in a net.* bucket would be inert (PIPELINE 10.5).
    for (const text of [
      "@@||play.history.com^$elemhide",
      "@@||play.history.com^$generichide",
      "@@||play.history.com^$specifichide",
      "@@||play.history.com^$content",
    ]) {
      const exception = rule(text);
      assert.equal(isCosmeticScopeException(exception), true, text);
      const targets = replicationTargets(groups, netAds, exception, exception.text);
      assert.ok(targets.length > 0, text);
      for (const id of targets) assert.ok(id.startsWith("janus.cos."), `${text} -> ${id}`);
    }
    // A plain network exception is unaffected.
    assert.equal(isCosmeticScopeException(rule("@@||ads.example^$script")), false);
  } finally {
    await removeDir(ctx.dirs.build);
  }
});

test("the stage emits ordered buckets, an index and a budget", async () => {
  const buildDir = await tempBuildDir();
  try {
    await buildThroughTranslate(buildDir);
    const summary = await runBucket(await testContext({ stage: "bucket", buildDir }));
    assert.ok(summary.buckets >= 22);

    const index = await readJson(path.join(buildDir, "buckets", "index.json"));
    assert.equal(index.schemaVersion, 1);
    for (const [id, entry] of Object.entries(index.buckets)) {
      assert.ok(id.startsWith(`janus.${entry.family}`), id);
      assert.equal(entry.ruleCount, entry.originalCount + entry.replicatedCount);
      assert.deepEqual(entry.sourceLists, [...entry.sourceLists].sort());
    }

    // Section order inside every bucket.
    for (const name of await readdir(path.join(buildDir, "buckets"))) {
      if (!name.endsWith(".txt")) continue;
      const lines = await readLines(path.join(buildDir, "buckets", name));
      let previous = 0;
      for (const line of lines) {
        const section = sectionOf(rule(line));
        assert.ok(section >= previous, `${name}: ${line} breaks the section order`);
        previous = section;
      }
    }

    // Every rule of a bucket really hashes into it, or is a replicated exception.
    const netAdsBucket = `janus.net.ads.${pad2(fnv1a32("example.com") % 4)}`;
    const lines = await readLines(path.join(buildDir, "buckets", `${netAdsBucket}.txt`));
    assert.ok(lines.includes("@@||ads.example.com/allowed.js$script"));

    const budget = await readJson(path.join(buildDir, "reports", "budget.json"));
    assert.equal(budget.basis, "default-1.0");
    assert.equal(budget.webkitLimit, 150000);
    for (const row of budget.buckets) {
      assert.equal(row.state, "ok");
      assert.equal(row.estimatedConverted, row.inputCount);
      assert.equal(row.softCap, 80000);
      assert.equal(row.hardCap, 110000);
    }
  } finally {
    await removeDir(buildDir);
  }
});

test("--plan writes only the budget", async () => {
  const buildDir = await tempBuildDir();
  try {
    await buildThroughTranslate(buildDir);
    await runBucket(await testContext({ stage: "bucket", buildDir, plan: true }));
    assert.ok(exists(path.join(buildDir, "reports", "budget.json")));
    assert.ok(!exists(path.join(buildDir, "buckets", "index.json")));
    const budget = await readJson(path.join(buildDir, "reports", "budget.json"));
    assert.equal(budget.plan, true);
  } finally {
    await removeDir(buildDir);
  }
});

test("inserting a rule changes one bucket and leaves the others byte-identical", async () => {
  const first = await tempBuildDir();
  const second = await tempBuildDir();
  const listsCopy = await tempBuildDir();
  try {
    await buildThroughTranslate(first);
    await runBucket(await testContext({ stage: "bucket", buildDir: first }));

    await cp(path.join(FIXTURES, "lists"), path.join(listsCopy, "lists"), { recursive: true });
    const listsPath = path.join(listsCopy, "lists", "lists.json");
    await appendFile(
      path.join(listsCopy, "lists", "adguard-base.txt"),
      "||inserted.example^$third-party\n",
      "utf8",
    );
    await buildThroughTranslate(second, listsPath);
    await runBucket(await testContext({ stage: "bucket", buildDir: second, listsPath }));

    const changedBucket = `janus.net.ads.${pad2(fnv1a32("inserted.example") % 4)}`;
    let changed = 0;
    for (const name of await readdir(path.join(first, "buckets"))) {
      if (!name.endsWith(".txt")) continue;
      const before = await readLines(path.join(first, "buckets", name));
      const after = await readLines(path.join(second, "buckets", name));
      if (name === `${changedBucket}.txt`) {
        assert.ok(after.includes("||inserted.example^$third-party"));
        changed += 1;
        continue;
      }
      assert.deepEqual(after, before, name);
    }
    assert.equal(changed, 1);
  } finally {
    await removeDir(first);
    await removeDir(second);
    await removeDir(listsCopy);
  }
});
