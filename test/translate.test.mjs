// PIPELINE section 9: the alias map, the trusted-target refusal, and the three
// payloads that exist because the converter cannot express the rules they
// come from.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { lookupAlias, surrogateProbes, translateScriptlet, run as runTranslate } from "../src/stages/translate.mjs";
import { run as runFetch } from "../src/stages/fetch.mjs";
import { run as runPreprocess } from "../src/stages/preprocess.mjs";
import { run as runTrustgate } from "../src/stages/trustgate.mjs";
import {
  formatAdguardScriptletBody,
  parseAdguardScriptletBody,
  parseUboScriptletBody,
} from "../src/lib/alias-transforms.mjs";
import { parseRule } from "../src/lib/rule.mjs";
import { readJson, readJsonl, readLines } from "../src/lib/io.mjs";
import { CONFIG_DIR, REPO, removeDir, tempBuildDir, testContext } from "./fixtures/helpers.mjs";

const ALIAS = JSON.parse(await readFile(path.join(REPO, "config", "ubo-alias.json"), "utf8"));
const SURROGATES = JSON.parse(
  await readFile(path.join(CONFIG_DIR, "surrogates.json"), "utf8"),
);

const record = () => ({ counts: { in: 0, kept: 0, rewritten: 0, dropped: 0 }, transforms: [], drops: [], dropCounts: {} });
const rule = (text) => ({ ...parseRule(text), text });

test("config/ubo-alias.json is the generated shape and is pinned to 2.5.1", () => {
  assert.equal(ALIAS.schemaVersion, 1);
  assert.equal(ALIAS.generatedFrom.package, "@adguard/scriptlets");
  assert.equal(ALIAS.generatedFrom.version, "2.5.1");
  assert.ok(Object.keys(ALIAS.scriptlets).length > 50);
  assert.ok(Object.keys(ALIAS.redirects).length > 20);
  assert.ok(Array.isArray(ALIAS.unmapped));
  for (const entry of Object.values(ALIAS.scriptlets)) {
    assert.equal(typeof entry.adguard, "string");
    assert.equal(entry.args, "identity");
  }
});

test("an alias resolves with and without the .js suffix", () => {
  assert.equal(lookupAlias(ALIAS.scriptlets, "aopr").adguard, "abort-on-property-read");
  assert.equal(lookupAlias(ALIAS.scriptlets, "aopr.js").adguard, "abort-on-property-read");
  assert.equal(lookupAlias(ALIAS.scriptlets, "rmnt.js").adguard, "remove-node-text");
  assert.equal(lookupAlias(ALIAS.scriptlets, "nowoif").adguard, "prevent-window-open");
  assert.equal(lookupAlias(ALIAS.redirects, "google-ima.js").adguard, "google-ima3");
  assert.equal(lookupAlias(ALIAS.scriptlets, "no-such-scriptlet"), null);
});

test("scriptlet calls round-trip through both syntaxes", () => {
  assert.deepEqual(parseUboScriptletBody("+js(aopr, adblock)"), {
    name: "aopr",
    args: ["adblock"],
  });
  assert.deepEqual(parseUboScriptletBody("+js(rmnt, script, ads, )"), {
    name: "rmnt",
    args: ["script", "ads", ""],
  });
  assert.deepEqual(parseAdguardScriptletBody("//scriptlet('set-constant', 'a', 'false')"), {
    name: "set-constant",
    args: ["a", "false"],
  });
  assert.equal(
    formatAdguardScriptletBody("remove-node-text", ["script", "ads"]),
    "//scriptlet('remove-node-text', 'script', 'ads')",
  );
  assert.equal(
    formatAdguardScriptletBody("set-constant", ["a", "it's"]),
    "//scriptlet('set-constant', 'a', 'it\\'s')",
  );
});

test("a uBO scriptlet is rewritten to AdGuard syntax, keeping the exception marker", () => {
  const trusted = { id: "fx.ubo", trust: "trusted" };
  const log = record();
  assert.equal(
    translateScriptlet(rule("example.com##+js(aopr, adblock)"), trusted, ALIAS, log, 1).text,
    "example.com#%#//scriptlet('abort-on-property-read', 'adblock')",
  );
  assert.equal(
    translateScriptlet(rule("example.com#@#+js(aopr, adblock)"), trusted, ALIAS, log, 2).text,
    "example.com#@%#//scriptlet('abort-on-property-read', 'adblock')",
  );
  assert.equal(log.counts.rewritten, 2);
});

test("a name in unmapped is dropped as scriptlet.no-alias", () => {
  const log = record();
  const result = translateScriptlet(
    rule("example.com##+js(hd-main)"),
    { id: "fx.ubo", trust: "trusted" },
    ALIAS,
    log,
    1,
  );
  assert.equal(result.keep, false);
  assert.equal(log.dropCounts["scriptlet.no-alias"], 1);
});

test("a uBO-syntax rule that already names an AdGuard scriptlet is only re-syntaxed", () => {
  const log = record();
  const result = translateScriptlet(
    rule("video.example##+js(trusted-set-cookie, consent, ok)"),
    { id: "fx.ubo", trust: "trusted" },
    ALIAS,
    log,
    1,
  );
  assert.equal(result.keep, true);
  assert.equal(result.text, "video.example#%#//scriptlet('trusted-set-cookie', 'consent', 'ok')");
  assert.equal(log.transforms[0].kind, "scriptlet-syntax");

  // The same rule from an untrusted list is refused, as the gate would have.
  const untrusted = record();
  const refused = translateScriptlet(
    rule("video.example##+js(trusted-set-cookie, consent, ok)"),
    { id: "fx.untrusted", trust: "untrusted" },
    ALIAS,
    untrusted,
    1,
  );
  assert.equal(refused.keep, false);
  assert.equal(untrusted.dropCounts["alias.trusted-target"], 1);
  assert.ok(ALIAS.adguardNames.includes("trusted-set-cookie"));
  assert.ok(ALIAS.adguardNames.includes("prevent-window-open"));
});

test("an alias onto a trusted-* scriptlet is refused for an untrusted list", () => {
  const alias = {
    scriptlets: { "set-cookie.js": { adguard: "trusted-set-cookie", args: "identity", trusted: true } },
    redirects: {},
    unmapped: [],
  };
  const untrusted = record();
  const refused = translateScriptlet(
    rule("example.com##+js(set-cookie, consent, ok)"),
    { id: "fx.untrusted", trust: "untrusted" },
    alias,
    untrusted,
    1,
  );
  assert.equal(refused.keep, false);
  assert.equal(untrusted.dropCounts["alias.trusted-target"], 1);

  const trusted = record();
  const allowed = translateScriptlet(
    rule("example.com##+js(set-cookie, consent, ok)"),
    { id: "fx.ubo", trust: "trusted" },
    alias,
    trusted,
    1,
  );
  assert.equal(allowed.keep, true);
  assert.equal(allowed.text, "example.com#%#//scriptlet('trusted-set-cookie', 'consent', 'ok')");
});

test("every surrogate pattern reduces to at least one probe URL", () => {
  const { probes, hints } = surrogateProbes(SURROGATES);
  assert.ok(probes.length >= SURROGATES.surrogates.length);
  for (const surrogate of SURROGATES.surrogates) {
    assert.ok(
      probes.some((probe) => probe.id === surrogate.id),
      `no probe for ${surrogate.id}`,
    );
  }
  assert.ok(hints.includes("doubleclick.net"));
  assert.ok(hints.includes("googleapis.com"));
});

test("the stage produces the three payloads and the surrogate candidates", async () => {
  const buildDir = await tempBuildDir();
  try {
    await runFetch(await testContext({ stage: "fetch", buildDir }));
    await runPreprocess(await testContext({ stage: "preprocess", buildDir }));
    await runTrustgate(await testContext({ stage: "trustgate", buildDir }));
    const summary = await runTranslate(await testContext({ stage: "translate", buildDir }));

    assert.deepEqual(await readLines(path.join(buildDir, "xlated", "fx.ubo.txt")), [
      "example.com#%#//scriptlet('abort-on-property-read', 'adblock')",
      "example.com#%#//scriptlet('prevent-window-open')",
      "example.com#%#//scriptlet('remove-node-text', 'script', 'ads')",
      "video.example#%#//scriptlet('set-cookie', 'consent', 'ok')",
      "example.org#%#//scriptlet('abort-on-property-read', 'adblock')",
      "example.org#%#window.__adblock = false;",
      "example.com#?#div:has-text(sponsored)",
      "example.com#@#.sidebar-ad",
      "@@||securepubads.g.doubleclick.net/tag/js/gpt.js$domain=news.example",
      "@@||imasdk.googleapis.com/js/sdkloader/ima3.js",
      "||tracker.example.com/track.js$badfilter,script",
      "||nothing.example^$badfilter",
      "||example.com/ima3.js$redirect=google-ima3,script",
    ]);

    // $removeparam never ships as content rules.
    for (const listId of ["fx.adguard", "fx.removeparam"]) {
      const lines = await readLines(path.join(buildDir, "xlated", `${listId}.txt`));
      assert.ok(!lines.some((line) => line.includes("removeparam")), listId);
      assert.ok(!lines.some((line) => line.includes("$csp")), listId);
    }

    const linkcleaner = await readJson(path.join(buildDir, "auxdata", "linkcleaner.json"));
    assert.equal(linkcleaner.schemaVersion, 1);
    assert.deepEqual(linkcleaner.global, ["fbclid", "utm_medium", "utm_source"]);
    assert.deepEqual(linkcleaner.byDomain["shop.example"], ["ref"]);
    assert.deepEqual(linkcleaner.byDomain["example.com"], ["pd_rd_r", "ref", "utm_source"]);
    assert.deepEqual(linkcleaner.regex[0], {
      domains: ["example.com"],
      pattern: "^ad_[0-9]+$",
    });

    const popups = await readJson(path.join(buildDir, "auxdata", "popup-index.json"));
    assert.deepEqual(popups, {
      schemaVersion: 1,
      domains: [
        "another-popup.example",
        "host.example",
        "popads.example",
        "popunder.example",
        "torrent.example",
      ],
    });

    const sitefix = await readJson(path.join(buildDir, "auxdata", "sitefix.json"));
    assert.deepEqual(sitefix.entries, [
      { domains: ["example.com"], csp: "script-src 'self'", source: "fx.adguard#18" },
    ]);
    assert.deepEqual(sitefix.csp, [{ domains: ["example.com"], csp: "script-src 'self'" }]);
    assert.deepEqual(sitefix.surrogates, []);

    const candidates = await readJsonl(path.join(buildDir, "xlated", "surrogate-candidates.jsonl"));
    assert.deepEqual(candidates, [
      {
        rule: "||securepubads.g.doubleclick.net/tag/js/gpt.js$script",
        kind: "block",
        surrogate: "googletagservices-gpt",
        listId: "fx.adguard",
      },
      {
        rule: "||imasdk.googleapis.com/js/sdkloader/ima3.js$script",
        kind: "block",
        surrogate: "google-ima3",
        listId: "fx.adguard",
      },
      {
        rule: "||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js$script",
        kind: "block",
        surrogate: "googlesyndication-adsbygoogle",
        listId: "fx.adguard",
      },
      {
        rule: "@@||securepubads.g.doubleclick.net/tag/js/gpt.js$domain=news.example",
        kind: "exception",
        surrogate: "googletagservices-gpt",
        listId: "fx.ubo",
      },
      {
        rule: "@@||imasdk.googleapis.com/js/sdkloader/ima3.js",
        kind: "exception",
        surrogate: "google-ima3",
        listId: "fx.ubo",
      },
    ]);

    assert.equal(summary.perList["fx.ubo"].causes["scriptlet.no-alias"], 1);
    assert.equal(summary.perList["fx.adguard"].causes["csp.generic"], 1);
    assert.equal(summary.perList["fx.removeparam"].causes["removeparam.unsupported"], 2);
  } finally {
    await removeDir(buildDir);
  }
});
