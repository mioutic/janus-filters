// SPDX-License-Identifier: GPL-3.0-or-later
//
// The run.mjs command line, exactly as docs/probehost/02-runner.md section 8
// declares it, plus that section's exit codes. Parsing is pure: it touches the
// filesystem never and the environment only where the contract says an option may
// be read from it, so test/probe-scenarios.test.mjs exercises every branch on
// ubuntu without a simulator.

/** docs/probehost/02-runner.md section 8. */
export const EXIT = {
  OK: 0,
  STRICT: 1,
  USAGE: 2,
  HARNESS: 3,
  BUNDLE: 4,
};

/** Thrown for anything that makes the invocation itself wrong: always exit 2. */
export class UsageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UsageError";
    this.code = EXIT.USAGE;
    this.details = details;
  }
}

/** CONTRACT section 6 step 11: the only two prefixes a manifest may be fetched from. */
export const URL_ALLOWLIST = [
  "https://github.com/mioutic/janus-filters/",
  "https://mioutic.github.io/janus-filters/",
];

export const DEFAULTS = Object.freeze({
  suite: "scenario",
  scenarios: "config/scenarios.json",
  runtime: "newest",
  repeats: 1,
  modes: ["blocked", "none"],
  budgetMin: 30,
  bundleId: "io.github.mioutic.probehost",
});

export const USAGE = `Usage: node Tools/ProbeRunner/run.mjs --app <ProbeHost.app> [options]

  --app <path>              required: the built ProbeHost.app (simulator SDK)
  --suite scenario|spike    default scenario
  --scenarios <file>        default config/scenarios.json
  --out <dir>               default build/probe/<runId>
  --run-id <id>             default <utc yyyymmddHHMMSS>-<short random>
  --runtime newest|all|x.y  default newest ("all" is the spike suite only)
  --device-type <id>        override the device-type preference order
  --repeats <n>             default 1
  --modes blocked,none      default both
  --only <id,id>            restrict and reorder the scenarios
  --only-stable             stable scenarios only
  --bundle-dir <path>       offline: stage this bundle instead of fetching
  --manifest-url <url>      override the entry point (allowlisted hosts only)
  --budget-min <n>          suite wall clock in minutes, default 30
  --strict                  expectations become failures for stable scenarios
  --ephemeral               delete the simulator afterwards
  --console                 launch with --console-pty (one scenario, debugging)
  --record-egress           resolve and record the public egress IP (CI only)
  --quiet                   drop debug lines from stdout
  --help                    print this and exit 0

Exit codes: 0 ran, 1 strict expectation missed, 2 usage, 3 harness failure,
4 the published bundle failed contract verification.`;

const BOOLEANS = new Set([
  "only-stable",
  "strict",
  "ephemeral",
  "console",
  "record-egress",
  "quiet",
  "help",
]);

const VALUED = new Set([
  "app",
  "suite",
  "scenarios",
  "out",
  "run-id",
  "runtime",
  "device-type",
  "repeats",
  "modes",
  "only",
  "bundle-dir",
  "manifest-url",
  "budget-min",
]);

const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUNTIME_VERSION = /^\d{1,2}(\.\d{1,2}){0,2}$/;

/** `20260915051022-a3f1`: sortable, unique enough, and safe inside a path. */
export function defaultRunId(now = new Date(), rand = Math.random) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const suffix = Math.floor(rand() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${stamp}-${suffix}`;
}

function intOption(name, raw, min, max) {
  if (!/^\d{1,6}$/.test(raw)) throw new UsageError(`--${name} must be a whole number`, { value: raw });
  const value = Number(raw);
  if (value < min || value > max) {
    throw new UsageError(`--${name} must be between ${min} and ${max}`, { value });
  }
  return value;
}

function checkManifestUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("--manifest-url is not a URL", { value: raw });
  }
  if (url.protocol !== "https:") throw new UsageError("--manifest-url must be https", { value: raw });
  if (!URL_ALLOWLIST.some((prefix) => url.href.startsWith(prefix))) {
    // CONTRACT section 6 step 11 is fail-closed in the app too; catching it here
    // costs a second instead of a booted simulator and a wasted macOS minute.
    throw new UsageError("--manifest-url is outside the CONTRACT section 6 allowlist", {
      value: raw,
      allowed: URL_ALLOWLIST,
    });
  }
  return url.href;
}

/**
 * @param {string[]} argv typically process.argv.slice(2)
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {() => number} [options.rand]
 * @returns {object} frozen options, or `{ help: true }`
 */
export function parseArgs(argv, { now = new Date(), rand = Math.random } = {}) {
  /** @type {Record<string, string|boolean>} */
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new UsageError(`unexpected argument: ${token}`, { token });
    }
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    let value = eq === -1 ? null : token.slice(eq + 1);
    if (BOOLEANS.has(name)) {
      if (value !== null && value !== "true" && value !== "false") {
        throw new UsageError(`--${name} takes no value`, { token });
      }
      raw[name] = value !== "false";
      continue;
    }
    if (!VALUED.has(name)) throw new UsageError(`unknown option --${name}`, { token });
    if (value === null) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} needs a value`, { token });
      }
      i += 1;
    }
    if (value.length === 0) throw new UsageError(`--${name} needs a value`, { token });
    raw[name] = value;
  }

  if (raw.help) return Object.freeze({ help: true, usage: USAGE });

  const suite = String(raw.suite ?? DEFAULTS.suite);
  if (suite !== "scenario" && suite !== "spike") {
    throw new UsageError("--suite must be scenario or spike", { value: suite });
  }

  if (!raw.app) throw new UsageError("--app is required: the path to the built ProbeHost.app");
  const app = String(raw.app);
  if (!app.endsWith(".app")) throw new UsageError("--app must point at a .app bundle", { value: app });

  const runId = raw["run-id"] ? String(raw["run-id"]) : defaultRunId(now, rand);
  if (!RUN_ID.test(runId)) {
    throw new UsageError("--run-id must match [A-Za-z0-9._-]{1,64}", { value: runId });
  }

  const runtime = String(raw.runtime ?? DEFAULTS.runtime);
  if (runtime !== "newest" && runtime !== "all" && !RUNTIME_VERSION.test(runtime)) {
    throw new UsageError("--runtime must be newest, all, or a version like 26.4", { value: runtime });
  }
  if (runtime === "all" && suite !== "spike") {
    // 02-runner.md section 2.1: a scenario suite measures one runtime, so every
    // number in report.json belongs to exactly one environment row.
    throw new UsageError("--runtime all is the spike suite only", { suite });
  }

  const modes = String(raw.modes ?? DEFAULTS.modes.join(","))
    .split(",")
    .map((mode) => mode.trim())
    .filter((mode) => mode.length > 0);
  if (modes.length === 0) throw new UsageError("--modes needs at least one mode");
  for (const mode of modes) {
    if (mode !== "blocked" && mode !== "none") {
      throw new UsageError("--modes accepts only blocked and none", { value: mode });
    }
  }
  if (new Set(modes).size !== modes.length) throw new UsageError("--modes repeats a mode", { modes });

  const only = raw.only
    ? String(raw.only)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : null;
  if (only) {
    if (only.length === 0) throw new UsageError("--only needs at least one scenario id");
    for (const id of only) {
      if (!SCENARIO_ID.test(id)) throw new UsageError("--only holds an invalid scenario id", { id });
    }
  }

  if (raw["bundle-dir"] && raw["manifest-url"]) {
    // 01-probehost.md section 2.1: the app refuses both, so the runner never
    // builds an argv the app will reject with exit 64.
    throw new UsageError("--bundle-dir and --manifest-url are mutually exclusive");
  }

  const repeats =
    raw.repeats === undefined ? DEFAULTS.repeats : intOption("repeats", String(raw.repeats), 1, 20);
  const budgetMin =
    raw["budget-min"] === undefined
      ? DEFAULTS.budgetMin
      : intOption("budget-min", String(raw["budget-min"]), 1, 240);

  if (raw.console && (repeats !== 1 || !only || only.length !== 1)) {
    throw new UsageError("--console is for one scenario and one repeat: pass --only <id> --repeats 1");
  }

  return Object.freeze({
    help: false,
    app,
    suite,
    scenariosPath: String(raw.scenarios ?? DEFAULTS.scenarios),
    outDir: raw.out ? String(raw.out) : `build/probe/${runId}`,
    runId,
    runtime,
    deviceTypeId: raw["device-type"] ? String(raw["device-type"]) : null,
    repeats,
    modes: Object.freeze(modes),
    only: only ? Object.freeze(only) : null,
    onlyStable: Boolean(raw["only-stable"]),
    bundleDir: raw["bundle-dir"] ? String(raw["bundle-dir"]) : null,
    manifestUrl: raw["manifest-url"] ? checkManifestUrl(String(raw["manifest-url"])) : null,
    budgetMin,
    budgetMs: budgetMin * 60_000,
    strict: Boolean(raw.strict),
    ephemeral: Boolean(raw.ephemeral),
    console: Boolean(raw.console),
    recordEgress: Boolean(raw["record-egress"]),
    quiet: Boolean(raw.quiet),
    bundleId: DEFAULTS.bundleId,
  });
}
