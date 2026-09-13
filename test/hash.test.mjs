// Pins the numbers every bucket assignment depends on. If any assertion in this
// file has to change, every phone re-downloads every bucket.

import test from "node:test";
import assert from "node:assert/strict";
import { fnv1a32, pad2, sha256hex, sha8 } from "../src/lib/hash.mjs";
import { etldPlusOne, isSubdomainOf, normaliseHost, publicSuffix } from "../src/lib/psl.mjs";

test("fnv1a32 matches the published 32-bit FNV-1a vectors", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("b"), 0xe70c2de5);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
  assert.equal(fnv1a32("example.com"), fnv1a32("example.com"));
});

test("fnv1a32 hashes UTF-8 bytes, not code units", () => {
  const host = "xn--e1afmkfd.xn--p1ai";
  assert.equal(fnv1a32(host), fnv1a32(Buffer.from(host, "utf8")));
  assert.notEqual(fnv1a32("\u00e9"), fnv1a32("e"));
  assert.equal(fnv1a32("\u00e9"), fnv1a32(Buffer.from([0xc3, 0xa9])));
});

test("fnv1a32 stays unsigned 32-bit", () => {
  for (const value of ["", "a", "zzzzzzzzzzzzzzzz", "\u00ff\u00ff\u00ff"]) {
    const hash = fnv1a32(value);
    assert.ok(Number.isInteger(hash));
    assert.ok(hash >= 0 && hash <= 0xffffffff);
  }
});

test("bucket arithmetic is stable for a known key set", () => {
  const keys = ["example.com", "ads.example.co.uk", "doubleclick.net", "reddit.com"];
  const assignment = keys.map((key) => pad2(fnv1a32(key) % 4));
  assert.deepEqual(assignment, ["02", "03", "01", "02"]);
});

test("sha256 and sha8 are the derivation the app uses", () => {
  assert.equal(
    sha256hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(sha8("abc"), "ba7816bf");
  assert.equal(sha8(Buffer.from("abc", "utf8")), "ba7816bf");
  assert.equal(pad2(0) + pad2(7) + pad2(12), "000712");
});

test("normaliseHost lower-cases, strips a trailing dot and punycodes", () => {
  assert.equal(normaliseHost("EXAMPLE.COM."), "example.com");
  assert.equal(normaliseHost("\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444"), "xn--e1afmkfd.xn--p1ai");
  assert.equal(normaliseHost("xn--e1afmkfd.xn--p1ai"), "xn--e1afmkfd.xn--p1ai");
  assert.equal(normaliseHost("192.168.1.4"), "192.168.1.4");
  assert.equal(normaliseHost("a b.com"), null);
  assert.equal(normaliseHost(""), null);
});

test("publicSuffix and etldPlusOne follow the curated list", () => {
  assert.equal(publicSuffix("www.example.com"), "com");
  assert.equal(publicSuffix("a.b.example.co.uk"), "co.uk");
  assert.equal(etldPlusOne("www.example.com"), "example.com");
  assert.equal(etldPlusOne("a.b.example.co.uk"), "example.co.uk");
  assert.equal(etldPlusOne("example.com"), "example.com");
  assert.equal(etldPlusOne("co.uk"), "co.uk");
  assert.equal(etldPlusOne("sub.foo.github.io"), "foo.github.io");
  assert.equal(etldPlusOne("a.b.c.ne.jp"), "c.ne.jp");
  assert.equal(etldPlusOne("192.168.1.4"), "192.168.1.4");
  assert.equal(etldPlusOne("localhost"), "localhost");
  assert.equal(etldPlusOne("\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444"), "xn--e1afmkfd.xn--p1ai");
});

test("isSubdomainOf never matches a suffix that is not a label boundary", () => {
  assert.ok(isSubdomainOf("example.com", "example.com"));
  assert.ok(isSubdomainOf("ads.example.com", "example.com"));
  assert.ok(!isSubdomainOf("notexample.com", "example.com"));
});
