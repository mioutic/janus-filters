// PIPELINE section 7: includes, the !#if environment, normalisation, hosts and
// $badfilter. The assertions are on bytes, because prepared output feeds the
// merge and the merge feeds every bucket hash.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  convertHostsLine,
  evaluateIfExpression,
  resolveInclude,
  tokeniseIfExpression,
  run as runPreprocess,
} from "../src/stages/preprocess.mjs";
import { run as runFetch } from "../src/stages/fetch.mjs";
import { canonicaliseModifiers, normaliseLine, parseModifier } from "../src/lib/rule.mjs";
import { mergeRuleStreams } from "../src/lib/merge.mjs";
import { readJson, readLines } from "../src/lib/io.mjs";
import { CONFIG_DIR, removeDir, tempBuildDir, testContext } from "./fixtures/helpers.mjs";

const ENV = JSON.parse(await readFile(path.join(CONFIG_DIR, "env.json"), "utf8"));
const evaluate = (expression) => evaluateIfExpression(expression, ENV.identifiers);

test("the !#if environment is exactly the DESIGN 3.3 truth table", () => {
  assert.equal(evaluate("env_safari"), true);
  assert.equal(evaluate("env_mobile"), true);
  assert.equal(evaluate("ext_ublock"), true);
  assert.equal(evaluate("env_mv3"), false);
  assert.equal(evaluate("cap_html_filtering"), false);
  assert.equal(evaluate("adguard"), false);
});

test("unknown identifiers are false and are reported once each", () => {
  const unknown = [];
  assert.equal(
    evaluateIfExpression("env_future || env_other", ENV.identifiers, (name) => unknown.push(name)),
    false,
  );
  assert.deepEqual(unknown, ["env_future", "env_other"]);
});

test("expression precedence is C precedence", () => {
  assert.equal(evaluate("!env_mv3"), true);
  assert.equal(evaluate("env_safari && !env_mv3"), true);
  assert.equal(evaluate("env_mv3 || ext_ublock && env_mobile"), true);
  assert.equal(evaluate("(env_mv3 || ext_ublock) && env_mobile"), true);
  assert.equal(evaluate("(env_mv3 || adguard) && env_mobile"), false);
  assert.equal(evaluate("!(env_safari && env_mobile)"), false);
  assert.equal(tokeniseIfExpression("a && !b").length, 4);
});

test("a malformed expression throws so the stage can count if.parse_error", () => {
  for (const bad of ["env_safari &&", "(env_safari", "env_safari & env_mobile", "", "&&"]) {
    assert.throws(() => evaluate(bad));
  }
});

test("includes resolve only within the same origin and directory", () => {
  const base = "https://lists.example/filters/list.txt";
  assert.deepEqual(resolveInclude("part.txt", base, base), {
    url: "https://lists.example/filters/part.txt",
  });
  assert.deepEqual(resolveInclude("sub/part.txt", base, base), {
    url: "https://lists.example/filters/sub/part.txt",
  });
  assert.deepEqual(resolveInclude("https://other.example/x.txt", base, base), {
    drop: "include.cross_origin",
  });
  assert.deepEqual(resolveInclude("http://lists.example/filters/x.txt", base, base), {
    drop: "include.cross_origin",
  });
  assert.deepEqual(resolveInclude("../secret.txt", base, base), { drop: "include.cross_origin" });
  assert.deepEqual(resolveInclude("//evil.example/x.txt", base, base), {
    drop: "include.cross_origin",
  });
});

test("hosts lines become host-anchored rules and only sink addresses count", () => {
  assert.deepEqual(convertHostsLine("0.0.0.0 ads.example"), {
    rules: ["||ads.example^"],
    cause: null,
  });
  assert.deepEqual(convertHostsLine("127.0.0.1 a.example b.example"), {
    rules: ["||a.example^", "||b.example^"],
    cause: null,
  });
  assert.deepEqual(convertHostsLine("::1 ip6.example # comment"), {
    rules: ["||ip6.example^"],
    cause: null,
  });
  assert.deepEqual(convertHostsLine("192.168.1.1 lan.example"), {
    rules: [],
    cause: "hosts.non_sink",
  });
  assert.deepEqual(convertHostsLine("0.0.0.0 localhost"), { rules: [], cause: null });
  assert.deepEqual(convertHostsLine("0.0.0.0 broadcasthost"), { rules: [], cause: null });
  assert.deepEqual(convertHostsLine("0.0.0.0 nodot"), { rules: [], cause: null });
  assert.deepEqual(convertHostsLine("# just a comment"), { rules: [], cause: null });
});

test("normalisation lower-cases hosts, punycodes and canonicalises modifiers", () => {
  assert.equal(
    normaliseLine("  ||EXAMPLE.com^$third-party,script  ").text,
    "||example.com^$script,third-party",
  );
  assert.equal(
    normaliseLine("||example.com^$script,third-party").text,
    "||example.com^$script,third-party",
  );
  assert.equal(
    normaliseLine("||пример.рф^").text,
    "||xn--e1afmkfd.xn--p1ai^",
  );
  assert.equal(normaliseLine("||example.com/PATH?A=B").text, "||example.com/PATH?A=B");
  assert.equal(
    normaliseLine("@@||ads.example.com^$domain=FOO.com|~Bar.com").text,
    "@@||ads.example.com^$domain=foo.com|~bar.com",
  );
  assert.equal(normaliseLine("EXAMPLE.com##.Ad-Banner").text, "example.com##.Ad-Banner");
  const canonical = canonicaliseModifiers(
    ["third-party", "script", "third-party"].map(parseModifier),
  );
  assert.equal(canonical.map((modifier) => modifier.name).join(","), "script,third-party");
});

test("comments, cosmetic markers and control characters are told apart", () => {
  assert.equal(normaliseLine("! comment").status, "comment");
  assert.equal(normaliseLine("# comment").status, "comment");
  assert.equal(normaliseLine("[Adblock Plus 2.0]").status, "comment");
  assert.equal(normaliseLine("").status, "empty");
  assert.equal(normaliseLine("##.ad").status, "rule");
  assert.equal(normaliseLine("example.com#@#.ad").status, "rule");
  assert.equal(
    normaliseLine('example.com#%#//scriptlet("set-constant", "a", "1")').status,
    "rule",
  );
  assert.equal(normaliseLine("||bad\u0007.example^").cause, "normalise.control_char");
});

test("$badfilter removes its target across lists and reports a miss", () => {
  const streams = [
    {
      listId: "a",
      entries: [
        { text: "||tracker.example^$script", line: 1 },
        { text: "||keep.example^", line: 2 },
      ],
    },
    {
      listId: "b",
      entries: [
        { text: "||tracker.example^$badfilter,script", line: 1 },
        { text: "||nothing.example^$badfilter", line: 2 },
        { text: "||keep.example^", line: 3 },
      ],
    },
  ].map((stream) => ({
    listId: stream.listId,
    entries: stream.entries.map((entry) => ({ ...entry, rule: normaliseLine(entry.text).rule })),
  }));
  const merged = mergeRuleStreams(streams);
  assert.deepEqual(merged.lines, ["||keep.example^"]);
  assert.equal(merged.perList.a.removedByBadfilter, 1);
  assert.equal(merged.perList.b.duplicateOfEarlierList, 1);
  assert.deepEqual(
    merged.unmatchedBadfilters.map((entry) => entry.rule),
    ["||nothing.example^$badfilter"],
  );
  assert.deepEqual(merged.provenance, [{ rule: "||keep.example^", listId: "a", line: 2 }]);
});

test("the stage resolves the fixture set byte for byte", async () => {
  const buildDir = await tempBuildDir();
  try {
    await runFetch(await testContext({ stage: "fetch", buildDir }));
    const summary = await runPreprocess(await testContext({ stage: "preprocess", buildDir }));

    assert.deepEqual(await readLines(path.join(buildDir, "prepared", "fx.ifmatrix.txt")), [
      "||if-safari.example^",
      "||if-and-not.example^",
      "||if-parens.example^",
      "||if-html-else.example^",
      "||if-affinity.example^",
      "||if-after-affinity.example^",
    ]);
    assert.deepEqual(await readLines(path.join(buildDir, "prepared", "fx.include.txt")), [
      "||root.include.example^",
      "||part1.include.example^",
      "||part2.include.example^",
      "||after.include.example^",
    ]);
    assert.deepEqual(await readLines(path.join(buildDir, "prepared", "fx.hosts.txt")), [
      "||ads.hosts.example^",
      "||beacon.hosts.example^",
      "||tracker.hosts.example^",
      "||pixel.hosts.example^",
      "||ip6.hosts.example^",
      "||xn--e1afmkfd.example^",
    ]);

    const ifStats = await readJson(path.join(buildDir, "prepared", "fx.ifmatrix.stats.json"));
    assert.equal(ifStats.drops["if.unknown_identifier"], 1);
    assert.equal(ifStats.drops["if.parse_error"], 1);
    assert.equal(ifStats.affinityBlocks, 1);
    assert.deepEqual(ifStats.affinityGroups, ["social", "privacy"]);

    const includeStats = await readJson(path.join(buildDir, "prepared", "fx.include.stats.json"));
    assert.equal(includeStats.drops["include.cross_origin"], 1);
    assert.equal(includeStats.drops["include.cycle"], 1);
    assert.equal(includeStats.includes.length, 2);

    assert.equal(summary.merged.removedByBadfilter, 1);
    assert.equal(summary.merged.unmatchedBadfilters, 1);
    const merged = await readLines(path.join(buildDir, "merged.txt"));
    assert.ok(!merged.includes("||tracker.example.com/track.js$script"));
    assert.ok(!merged.some((line) => line.includes("badfilter")));
    // Dedupe keeps the first occurrence and never reorders.
    assert.equal(merged.filter((line) => line === "||ads.example.com^$third-party").length, 1);
    assert.ok(
      merged.indexOf("||ads.example.com^$third-party") < merged.indexOf("##.generic-advert"),
    );
  } finally {
    await removeDir(buildDir);
  }
});
