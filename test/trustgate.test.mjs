// PIPELINE section 8. The gate is what stands between an untrusted upstream list
// and code running on the phone, so every strip rule is pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { gateDecision, run as runTrustgate } from "../src/stages/trustgate.mjs";
import { run as runFetch } from "../src/stages/fetch.mjs";
import { run as runPreprocess } from "../src/stages/preprocess.mjs";
import { readJson, readLines } from "../src/lib/io.mjs";
import { CONFIG_DIR, removeDir, tempBuildDir, testContext } from "./fixtures/helpers.mjs";

const DESIGN_MODE = JSON.parse(await readFile(path.join(CONFIG_DIR, "trust.json"), "utf8"));
const STRICT_MODE = { ...DESIGN_MODE, mode: "strict" };

test("config/trust.json is the DESIGN reading, not the stricter one", () => {
  assert.equal(DESIGN_MODE.mode, "design");
  assert.equal(DESIGN_MODE.trustedScriptletPrefix, "trusted-");
  assert.deepEqual(DESIGN_MODE.strippedModifiers, [
    "jsinject",
    "stealth",
    "extension",
    "app",
    "hls",
    "jsonprune",
    "xmlprune",
    "replace",
    "urltransform",
    "removeheader",
  ]);
});

test("raw #%# JavaScript is stripped from an untrusted list", () => {
  assert.deepEqual(gateDecision("example.com#%#window.canRunAds = true;", DESIGN_MODE), {
    keep: false,
    reason: "raw-javascript",
  });
  assert.deepEqual(gateDecision("example.com#@%#window.x = 1;", DESIGN_MODE), {
    keep: false,
    reason: "raw-javascript",
  });
});

test("trusted-* scriptlets are stripped in both syntaxes", () => {
  assert.deepEqual(
    gateDecision("example.com#%#//scriptlet('trusted-set-cookie', 'a', 'b')", DESIGN_MODE),
    { keep: false, reason: "trusted-scriptlet" },
  );
  assert.deepEqual(gateDecision("example.com##+js(trusted-click-element, .ok)", DESIGN_MODE), {
    keep: false,
    reason: "trusted-scriptlet",
  });
  assert.deepEqual(gateDecision("example.com#@#+js(trusted-set-cookie, a, b)", DESIGN_MODE), {
    keep: false,
    reason: "trusted-scriptlet",
  });
});

test("a scriptlet call is judged by its body, not by the spelling of the call", () => {
  // SafariConverterLib 4.3.0's RuleConverter only matches `##+js`/`#@#+js`, so these
  // spellings reach the converter untranslated today. That is an accident of the
  // pinned version, not a policy: the gate must not depend on it (DESIGN 3.2).
  for (const text of [
    "example.com##script:inject(trusted-set-cookie, a, b)",
    "example.com##+JS(trusted-set-cookie, a)",
    "example.com#@#+Js(trusted-click-element, .ok)",
    "example.com##+js( trusted-replace-fetch-response )",
  ]) {
    assert.deepEqual(gateDecision(text, DESIGN_MODE), {
      keep: false,
      reason: "trusted-scriptlet",
    }, text);
  }
  // An untrusted name in strict mode goes too, whatever the spelling.
  assert.deepEqual(gateDecision("example.com##script:inject(set-constant, a, 1)", STRICT_MODE), {
    keep: false,
    reason: "strict-mode-scriptlet",
  });
  // A plain cosmetic rule is untouched.
  assert.deepEqual(gateDecision("example.com##.ad-slot", DESIGN_MODE), { keep: true });
});

test("every stripped modifier is stripped, and only those", () => {
  for (const modifier of DESIGN_MODE.strippedModifiers) {
    const decision = gateDecision(`||example.com^$${modifier}`, DESIGN_MODE);
    assert.deepEqual(decision, { keep: false, reason: `stripped-modifier:${modifier}` }, modifier);
  }
  for (const rule of [
    "||example.com^$third-party",
    "||example.com^$script,important",
    "@@||example.com^$document",
    "||example.com^$removeparam=utm_source",
    "||example.com^$csp=script-src 'self'",
    "||example.com^$redirect=noopjs",
  ]) {
    assert.deepEqual(gateDecision(rule, DESIGN_MODE), { keep: true }, rule);
  }
});

test("ordinary scriptlets and cosmetics survive in design mode", () => {
  for (const rule of [
    "example.com#%#//scriptlet('set-constant', 'adblock', 'false')",
    "example.com##+js(aopr, adblock)",
    "example.com##.ad",
    "example.com#?#div:has-text(sponsored)",
    "example.com#$?#div:has(> .ad) { display: none !important; }",
    "##.generic-ad",
  ]) {
    assert.deepEqual(gateDecision(rule, DESIGN_MODE), { keep: true }, rule);
  }
});

test("strict mode drops every scriptlet invocation and nothing else", () => {
  assert.deepEqual(
    gateDecision("example.com#%#//scriptlet('set-constant', 'a', '1')", STRICT_MODE),
    { keep: false, reason: "strict-mode-scriptlet" },
  );
  assert.deepEqual(gateDecision("example.com##+js(aopr, adblock)", STRICT_MODE), {
    keep: false,
    reason: "strict-mode-scriptlet",
  });
  assert.deepEqual(gateDecision("example.com##.ad", STRICT_MODE), { keep: true });
  assert.deepEqual(gateDecision("||example.com^$third-party", STRICT_MODE), { keep: true });
});

test("a surviving !#include is refused as defence in depth", () => {
  assert.deepEqual(gateDecision("!#include https://lists.example/part.txt", DESIGN_MODE), {
    keep: false,
    reason: "include",
  });
});

test("the stage leaves trusted lists untouched and records what it strips", async () => {
  const buildDir = await tempBuildDir();
  try {
    await runFetch(await testContext({ stage: "fetch", buildDir }));
    await runPreprocess(await testContext({ stage: "preprocess", buildDir }));
    const summary = await runTrustgate(await testContext({ stage: "trustgate", buildDir }));

    assert.equal(summary.mode, "design");
    for (const listId of ["fx.adguard", "fx.ubo", "fx.sitefix"]) {
      const prepared = await readLines(path.join(buildDir, "prepared", `${listId}.txt`));
      const trusted = await readLines(path.join(buildDir, "trusted", `${listId}.txt`));
      assert.deepEqual(trusted, prepared, listId);
      const gate = await readJson(path.join(buildDir, "trusted", `${listId}.gate.json`));
      assert.equal(gate.counts.stripped, 0);
      assert.equal(gate.trust, "trusted");
    }

    const gate = await readJson(path.join(buildDir, "trusted", "fx.untrusted.gate.json"));
    assert.equal(gate.trust, "untrusted");
    assert.equal(gate.counts.stripped, 7);
    assert.deepEqual(
      gate.stripped.map((entry) => entry.reason),
      [
        "trusted-scriptlet",
        "raw-javascript",
        "trusted-scriptlet",
        "stripped-modifier:replace",
        "stripped-modifier:jsinject",
        "stripped-modifier:removeheader",
        "stripped-modifier:stealth",
      ],
    );
    for (const entry of gate.stripped) {
      assert.ok(entry.line > 0);
      assert.equal(typeof entry.rule, "string");
    }
    assert.deepEqual(await readLines(path.join(buildDir, "trusted", "fx.untrusted.txt")), [
      "||ads.untrusted.example^$third-party",
      "untrusted.example##.ad",
      "untrusted.example#%#//scriptlet('set-constant', 'adblock', 'false')",
    ]);
  } finally {
    await removeDir(buildDir);
  }
});
