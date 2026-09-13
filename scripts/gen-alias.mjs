#!/usr/bin/env node
// Regenerates config/ubo-alias.json from the pinned @adguard/scriptlets package.
// PIPELINE section 9.1. The map is generated and committed; never hand-edited.
//
//   node scripts/gen-alias.mjs [--write]  rewrite config/ubo-alias.json
//   node scripts/gen-alias.mjs --check    fail (exit 3) when the committed file has drifted
//
// Exit codes follow PIPELINE section 3: 0 ok, 2 usage/missing input, 3 drift.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "config", "ubo-alias.json");
const PACKAGE = "@adguard/scriptlets";
const FALLBACK_VERSION = "2.5.1";

// The uBO resource and scriptlet name inventory, used only to compute `unmapped`:
// every name here that the pinned AdGuard package does not claim is a name a uBO
// list can use and we cannot translate. Names that ARE claimed drop out
// automatically, so an entry that AdGuard later adds an alias for needs no edit.
// Reviewed against uBlock Origin's resources.js and scriptlets.js (uBO 1.66).
const UBO_INVENTORY = [
  "1x1.gif", "2x2.png", "32x32.png", "3x2.png",
  "abort-current-script.js", "abort-on-property-read.js", "abort-on-property-write.js",
  "abort-on-stack-trace.js", "acis.js", "acs.js", "addthis_widget.js",
  "addEventListener-defuser.js", "addEventListener-logger.js", "adjust-setInterval.js",
  "adjust-setTimeout.js", "aeld.js", "aell.js", "amazon_ads.js", "amazon_apstag.js",
  "ampproject_v0.js", "aopr.js", "aopw.js", "aost.js", "call-nothrow.js",
  "chartbeat.js", "click2load.html", "close-window.js", "cookie-remover.js",
  "disable-newtab-links.js", "doubleclick_instream_ad_status.js", "empty",
  "evaldata-prune.js", "fingerprint2.js", "fingerprint3.js",
  "google-analytics_analytics.js", "google-analytics_cx_api.js",
  "google-analytics_ga.js", "google-analytics_inpage_linkid.js", "google-ima.js",
  "googlesyndication_adsbygoogle.js", "googletagmanager_gtm.js",
  "googletagservices_gpt.js", "hd-main.js", "href-sanitizer.js", "json-prune.js",
  "json-prune-fetch-response.js", "json-prune-xhr-response.js",
  "ligatus_angular-tag.js", "m3u-prune.js", "monkeybroker.js", "multiup.js",
  "nano-sib.js", "nano-stb.js", "no-fetch-if.js", "no-requestAnimationFrame-if.js",
  "no-setInterval-if.js", "no-setTimeout-if.js", "no-window-open-if.js", "no-xhr-if.js",
  "nobab.js", "nobab2.js", "noeval.js", "noeval-if.js", "noeval-silent.js",
  "nofab.js", "nofetch.js", "noop-0.1s.mp3", "noop-0.5s.mp3", "noop-1s.mp4",
  "noop.css", "noop.html", "noop.js", "noop.json", "noop.txt", "noop-vast2.xml",
  "noop-vast3.xml", "noop-vast4.xml", "noop-vmap1.0.xml", "nooptext",
  "norafif.js", "nosiif.js", "nostif.js", "nowebrtc.js", "nowoif.js",
  "outbrain-widget.js", "popads.js", "popads-dummy.js", "prebid-ads.js",
  "prevent-canvas.js", "prevent-element-src-loading.js", "prevent-fetch.js",
  "prevent-refresh.js", "prevent-xhr.js", "ra.js", "rc.js", "refresh-defuser.js",
  "remove-attr.js", "remove-class.js", "remove-cookie.js", "remove-node-text.js",
  "replace-node-text.js", "rmnt.js", "rpnt.js", "scorecardresearch_beacon.js",
  "set.js", "set-attr.js", "set-constant.js", "set-cookie.js", "set-cookie-reload.js",
  "set-local-storage-item.js", "set-session-storage-item.js", "spoof-css.js",
  "trusted-click-element.js", "trusted-prune-inbound-object.js",
  "trusted-replace-fetch-response.js", "trusted-replace-xhr-response.js",
  "trusted-set-cookie.js", "window.name-defuser.js", "window.open-defuser.js",
  "xml-prune.js",
];

function die(code, message) {
  process.stderr.write(
    JSON.stringify({ stage: "gen-alias", event: "error", level: "error", message }) + "\n",
  );
  process.exit(code);
}

function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** uBO alias -> the bare name a rule would write. `null` for names we do not own. */
function uboNameOf(alias) {
  if (alias.startsWith("abp-")) return null;
  if (alias.startsWith("ubo-")) return alias.slice(4);
  return alias;
}

function stripJs(name) {
  return name.endsWith(".js") ? name.slice(0, -3) : name;
}

async function readPin() {
  const versionsPath = path.join(ROOT, "VERSIONS.json");
  if (!existsSync(versionsPath)) return FALLBACK_VERSION;
  let doc;
  try {
    doc = JSON.parse(await readFile(versionsPath, "utf8"));
  } catch (err) {
    die(2, `VERSIONS.json is not valid JSON: ${err.message}`);
  }
  const found = findVersion(doc, PACKAGE);
  return found ?? FALLBACK_VERSION;
}

/** Finds a pinned version for `name` anywhere in VERSIONS.json, whatever the shape. */
function findVersion(node, name) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findVersion(item, name);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === name) {
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && typeof value.version === "string") {
        return value.version;
      }
    }
    if (value && typeof value === "object") {
      if (value.name === name && typeof value.version === "string") return value.version;
      const hit = findVersion(value, name);
      if (hit) return hit;
    }
  }
  return null;
}

function packageDirFromArgs(argv) {
  const i = argv.indexOf("--package-dir");
  if (i !== -1) {
    if (!argv[i + 1]) die(2, "--package-dir needs a path");
    return path.resolve(argv[i + 1]);
  }
  return path.join(ROOT, "node_modules", "@adguard", "scriptlets");
}

async function build(pkgDir, expectedVersion) {
  const manifestPath = path.join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) {
    die(
      2,
      `${PACKAGE} is not installed at ${pkgDir}; run \`npm ci\` first, or pass --package-dir`,
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== expectedVersion) {
    die(
      3,
      `${PACKAGE} is ${manifest.version} but the pin is ${expectedVersion}; ` +
        "update VERSIONS.json and regenerate in the same commit",
    );
  }

  const corelibs = JSON.parse(
    await readFile(path.join(pkgDir, "dist", "scriptlets.corelibs.json"), "utf8"),
  );
  const redirectsDoc = JSON.parse(
    await readFile(path.join(pkgDir, "dist", "redirects.json"), "utf8"),
  );

  const scriptlets = {};
  const claim = (map, key, entry, kind) => {
    const existing = map[key];
    if (existing && existing.adguard !== entry.adguard) {
      die(
        3,
        `${kind} alias "${key}" is claimed by both ${existing.adguard} and ${entry.adguard}`,
      );
    }
    map[key] = entry;
  };

  for (const item of corelibs.scriptlets ?? []) {
    const names = item.names ?? [];
    const adguard = names[0];
    if (!adguard) continue;
    const trusted = adguard.startsWith("trusted-");
    for (const alias of names.slice(1)) {
      const ubo = uboNameOf(alias);
      if (!ubo || ubo === adguard) continue;
      const entry = { adguard, args: "identity" };
      if (trusted) entry.trusted = true;
      claim(scriptlets, ubo, entry, "scriptlet");
    }
  }

  const redirects = {};
  for (const item of redirectsDoc) {
    const adguard = item.title;
    if (!adguard) continue;
    for (const alias of item.aliases ?? []) {
      const ubo = uboNameOf(alias);
      if (!ubo || ubo === adguard) continue;
      claim(redirects, ubo, { adguard }, "redirect");
    }
  }

  // Everything the pinned package can answer to, in bare form.
  const known = new Set();
  for (const map of [scriptlets, redirects]) {
    for (const key of Object.keys(map)) known.add(stripJs(key));
  }
  for (const item of corelibs.scriptlets ?? []) {
    for (const name of item.names ?? []) known.add(stripJs(uboNameOf(name) ?? name));
  }
  for (const item of redirectsDoc) {
    known.add(stripJs(item.title));
    for (const alias of item.aliases ?? []) known.add(stripJs(uboNameOf(alias) ?? alias));
  }

  const unmapped = UBO_INVENTORY.filter((name) => !known.has(stripJs(name)))
    .slice()
    .sort(byCodeUnit);

  // The canonical AdGuard names. A uBO-syntax rule that already uses one of them
  // (`##+js(trusted-set-cookie, ...)`) needs no rename, only the syntax rewrite -
  // without this list translate would leave it in uBO syntax for the converter
  // to discard.
  const adguardNames = (corelibs.scriptlets ?? [])
    .map((item) => item.names?.[0])
    .filter((name) => typeof name === "string")
    .sort(byCodeUnit);

  return serialise({
    scriptlets,
    redirects,
    adguardNames,
    unmapped,
    version: manifest.version,
  });
}

/** Fixed key order, 2-space indent, exactly one trailing newline. */
function serialise({ scriptlets, redirects, adguardNames, unmapped, version }) {
  const ordered = (map, fields) => {
    const out = {};
    for (const key of Object.keys(map).sort(byCodeUnit)) {
      const entry = {};
      for (const field of fields) {
        if (map[key][field] !== undefined) entry[field] = map[key][field];
      }
      out[key] = entry;
    }
    return out;
  };
  const doc = {
    schemaVersion: 1,
    generatedFrom: { package: PACKAGE, version },
    scriptlets: ordered(scriptlets, ["adguard", "args", "trusted"]),
    redirects: ordered(redirects, ["adguard"]),
    adguardNames,
    unmapped,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    if (!["--check", "--write", "--package-dir"].includes(arg) && arg.startsWith("--")) {
      die(2, `unknown flag ${arg}`);
    }
  }
  const check = argv.includes("--check");
  const expectedVersion = await readPin();
  const text = await build(packageDirFromArgs(argv), expectedVersion);

  if (!check) {
    await writeFile(OUT, text, "utf8");
    const doc = JSON.parse(text);
    process.stdout.write(
      JSON.stringify({
        wrote: path.relative(ROOT, OUT).split(path.sep).join("/"),
        scriptlets: Object.keys(doc.scriptlets).length,
        redirects: Object.keys(doc.redirects).length,
        adguardNames: doc.adguardNames.length,
        unmapped: doc.unmapped.length,
      }) + "\n",
    );
    return;
  }

  if (!existsSync(OUT)) die(3, "config/ubo-alias.json is missing; run node scripts/gen-alias.mjs");
  const committed = await readFile(OUT, "utf8");
  if (committed === text) {
    process.stdout.write(JSON.stringify({ check: "ok" }) + "\n");
    return;
  }
  const a = committed.split("\n");
  const b = text.split("\n");
  const firstDiff = a.findIndex((line, i) => line !== b[i]) + 1;
  die(
    3,
    "config/ubo-alias.json has drifted from the pinned package " +
      `(first difference at line ${firstDiff}, committed ${a.length} lines, ` +
      `generated ${b.length}); run node scripts/gen-alias.mjs and commit the result`,
  );
}

await main();
