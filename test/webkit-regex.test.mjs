import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webKitRegexProblem } from "../src/lib/webkit-regex.mjs";

test("an escaped hyphen inside a character class is rejected", () => {
  assert.ok(webKitRegexProblem("^https?://[a-z0-9.\\-]*\\.example\\.com/"));
});

test("the same class with the hyphen last is accepted", () => {
  assert.equal(webKitRegexProblem("^https?://[a-z0-9.-]*\\.example\\.com/"), null);
});

test("other unsupported constructs are rejected", () => {
  const bad = ["^a(?:bc)d", "^a{2,3}b", "^(a)\\1", "^\\d+x", "\\bword"];
  for (const pattern of bad) {
    assert.ok(webKitRegexProblem(pattern), `expected a problem for ${pattern}`);
  }
});

test("every pattern in config/surrogates.json is WebKit-safe", async () => {
  const config = JSON.parse(
    await readFile(new URL("../config/surrogates.json", import.meta.url), "utf8"),
  );
  for (const surrogate of config.surrogates) {
    for (const pattern of surrogate.patterns ?? []) {
      assert.equal(webKitRegexProblem(pattern), null, `${surrogate.id}: ${pattern}`);
    }
  }
});
