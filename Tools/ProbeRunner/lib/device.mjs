// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runtime and device-type selection, create/boot/prepare, teardown, and the
// environment block of report.json (docs/probehost/02-runner.md section 2,
// 03-report.md section 2).
//
// Two rules this module exists to enforce:
//   1. Never download a runtime. `simctl runtime add` costs minutes and can fail;
//      the suite uses what the image carries and records exactly what it got.
//   2. Never substitute silently. An explicit `--runtime 26.4` that is not
//      installed is a usage error with the installed list printed, never a
//      quiet fallback to a different iOS whose numbers would be filed as 26.4.

import { UsageError, EXIT } from "./args.mjs";
import { isCi } from "./log.mjs";

/** The lowest iOS the Janus contract targets (CONTRACT section 8.1). */
export const MIN_IOS_MAJOR = 17;

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.iOS-";

/** Exit 3: the harness could not get far enough to measure anything. */
export class HarnessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HarnessError";
    this.code = EXIT.HARNESS;
    this.details = details;
  }
}

/** "26.4" -> [26, 4, 0]; tolerant of "18", "26.4.1" and stray whitespace. */
export function parseVersion(version) {
  const parts = String(version ?? "")
    .trim()
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

const isIosRuntime = (runtime) =>
  runtime?.platform === "iOS" || String(runtime?.identifier ?? "").startsWith(RUNTIME_PREFIX);

/**
 * Every installed, available iOS runtime with major >= 17, ascending.
 * Older Xcode spells the platform only in the identifier, so both are matched.
 */
export function availableIosRuntimes(list) {
  const runtimes = Array.isArray(list?.runtimes) ? list.runtimes : [];
  return runtimes
    .filter((runtime) => runtime?.isAvailable === true && isIosRuntime(runtime))
    .filter((runtime) => parseVersion(runtime.version)[0] >= MIN_IOS_MAJOR)
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * @param {object} list parsed `simctl list -j runtimes devicetypes devices`
 * @param {"newest"|"all"|string} spec
 * @returns {object[]} one runtime for `newest` and an exact version, every runtime for `all`
 */
export function selectRuntimes(list, spec) {
  const available = availableIosRuntimes(list);
  if (available.length === 0) {
    throw new HarnessError("no available iOS simulator runtime with major >= 17 is installed", {
      installed: (list?.runtimes ?? []).map((runtime) => `${runtime.name ?? runtime.identifier}`),
    });
  }
  if (spec === "all") return available;
  if (spec === "newest") return [available[available.length - 1]];

  const wanted = parseVersion(spec);
  const exact = available.filter((runtime) => {
    const got = parseVersion(runtime.version);
    // "26" matches 26.x; "26.4" matches 26.4 and 26.4.x.
    const depth = String(spec).split(".").length;
    for (let i = 0; i < depth; i += 1) {
      if (got[i] !== wanted[i]) return false;
    }
    return true;
  });
  if (exact.length === 0) {
    throw new UsageError(`requested runtime ${spec} is not installed`, {
      requested: spec,
      installed: available.map((runtime) => runtime.version),
    });
  }
  return [exact[exact.length - 1]];
}

/** 02-runner.md section 2.2, in order, each entry skipped when absent. */
export const DEVICE_TYPE_PREFERENCE = [
  "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max",
  "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
  "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro-Max",
];

/** `iPhone 16 Pro Max` -> 16. A model with no number (iPhone SE) ranks lowest. */
export function modelNumber(name) {
  const match = /^iPhone\s+(\d+)/.exec(String(name ?? ""));
  return match ? Number(match[1]) : -1;
}

/**
 * The device types this runtime supports, taken from the runtime when it lists
 * them (Xcode 15+) and from the global device-type list otherwise.
 */
export function deviceTypesFor(runtime, list) {
  const all = Array.isArray(list?.devicetypes) ? list.devicetypes : [];
  const supported = Array.isArray(runtime?.supportedDeviceTypes) ? runtime.supportedDeviceTypes : [];
  const source = supported.length > 0 ? supported : all;
  const byIdentifier = new Map(all.map((type) => [type.identifier, type]));
  return source
    .map((type) => ({ ...(byIdentifier.get(type.identifier) ?? {}), ...type }))
    .filter((type) => {
      const family = type.productFamily ?? "iPhone";
      return family === "iPhone" && /iPhone/.test(String(type.name ?? type.identifier));
    });
}

/**
 * The owner's phone class first (a 430-440 pt wide, 932-956 pt tall iPhone,
 * DESIGN 1), then the highest-numbered Pro Max, then the highest-numbered iPhone.
 * Device width changes ad layout, so report.environment.deviceType records the
 * answer and the trend keys on it (03-report.md section 4.2).
 */
export function selectDeviceType(runtime, list, overrideId = null) {
  const candidates = deviceTypesFor(runtime, list);
  if (candidates.length === 0) {
    throw new HarnessError("the chosen runtime supports no iPhone device type", {
      runtime: runtime?.version ?? null,
    });
  }
  if (overrideId) {
    const found = candidates.find((type) => type.identifier === overrideId);
    if (!found) {
      throw new UsageError("--device-type is not supported by the chosen runtime", {
        requested: overrideId,
        available: candidates.map((type) => type.identifier),
      });
    }
    return { ...found, reason: "override" };
  }
  for (const identifier of DEVICE_TYPE_PREFERENCE) {
    const found = candidates.find((type) => type.identifier === identifier);
    if (found) return { ...found, reason: "preferred" };
  }
  const proMax = candidates
    .filter((type) => /Pro Max/.test(String(type.name ?? "")))
    .sort((a, b) => modelNumber(a.name) - modelNumber(b.name));
  if (proMax.length > 0) return { ...proMax[proMax.length - 1], reason: "highest-pro-max" };

  const anyPhone = [...candidates].sort((a, b) => modelNumber(a.name) - modelNumber(b.name));
  return { ...anyPhone[anyPhone.length - 1], reason: "highest-iphone" };
}

/** `janus-probe-26-4`: one device per runtime, named so a stale one is recognisable. */
export function deviceName(runtime) {
  return `janus-probe-${String(runtime.version ?? "x").replace(/\./g, "-")}`;
}

/**
 * An existing device of that name, under that runtime, of that device type.
 * The device type has to match: reusing a device of a different width would file
 * this run's overlay fractions and lazy-loaded ad counts under the wrong
 * environment row (03-report.md section 4.2).
 */
export function findExistingDevice(list, runtime, name, deviceTypeId = null) {
  const byRuntime = list?.devices ?? {};
  const devices = byRuntime[runtime.identifier];
  if (!Array.isArray(devices)) return null;
  return (
    devices.find(
      (device) =>
        device?.name === name &&
        device?.isAvailable !== false &&
        (!deviceTypeId || !device?.deviceTypeIdentifier || device.deviceTypeIdentifier === deviceTypeId),
    ) ?? null
  );
}

/**
 * Create (or reuse), boot, wait, pin the status bar, install. Any failure here is
 * exit 3: nothing downstream could be measured.
 *
 * @returns {Promise<{udid: string, created: boolean, runtime: object, deviceType: object,
 *                    dataContainer: string, statusBarPinned: boolean}>}
 */
export async function prepareDevice(simctl, { list, runtime, deviceType, appPath, bundleId, log }) {
  const name = deviceName(runtime);
  const existing = findExistingDevice(list, runtime, name, deviceType.identifier);
  let udid = existing?.udid ?? null;
  let created = false;
  try {
    if (!udid) {
      udid = await simctl.create(name, deviceType.identifier, runtime.identifier);
      created = true;
    }
    log?.info?.("device", {
      udid,
      name,
      created,
      runtime: runtime.version,
      deviceType: deviceType.name ?? deviceType.identifier,
      selectedBy: deviceType.reason ?? "preferred",
    });
    await simctl.boot(udid);
    await simctl.bootstatus(udid);
  } catch (error) {
    throw new HarnessError(`simulator would not boot: ${error.message}`, {
      udid,
      runtime: runtime.version,
      detail: error.details ?? null,
    });
  }

  const statusBarPinned = await simctl.statusBarOverride(udid);

  try {
    await simctl.install(udid, appPath);
  } catch (error) {
    throw new HarnessError(`ProbeHost.app would not install: ${error.message}`, {
      udid,
      detail: error.details ?? null,
    });
  }

  let dataContainer;
  try {
    dataContainer = await simctl.getAppContainer(udid, bundleId, "data");
  } catch (error) {
    throw new HarnessError(`app data container is unreachable: ${error.message}`, { udid });
  }

  return { udid, created, runtime, deviceType, dataContainer, statusBarPinned };
}

/**
 * Shut down the exact device this process created or reused, and delete it only
 * when --ephemeral was passed. Never throws: teardown runs in a finally and must
 * not replace a real result with a cleanup error.
 */
export async function teardownDevice(simctl, udid, { ephemeral = false, log = null } = {}) {
  if (!udid) return { shutdown: false, deleted: false };
  let shutdown = false;
  let deleted = false;
  try {
    shutdown = await simctl.shutdown(udid);
  } catch (error) {
    log?.warn?.("shutdown failed", { udid, reason: error.message });
  }
  if (ephemeral) {
    try {
      deleted = await simctl.deleteDevice(udid);
    } catch (error) {
      log?.warn?.("delete failed", { udid, reason: error.message });
    }
  }
  log?.info?.("teardown", { udid, shutdown, deleted });
  return { shutdown, deleted };
}

/**
 * The runner's public egress address, and only when it was asked for AND this is
 * CI. A developer running the suite at home would otherwise write their own home
 * IP into an artifact that gets uploaded to a public repository; that is the one
 * number this harness declines to collect by default.
 */
export async function resolveEgress({
  recordEgress = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  const datacentre = isCi(env) ? true : null;
  if (!recordEgress) return { mode: "direct", datacentre, observedIp: null, reason: "not-requested" };
  if (!isCi(env)) return { mode: "direct", datacentre, observedIp: null, reason: "not-ci" };
  try {
    const response = await fetchImpl("https://checkip.amazonaws.com/", {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) return { mode: "direct", datacentre, observedIp: null, reason: `http-${response.status}` };
    const text = (await response.text()).trim();
    const valid = /^[0-9.]{7,15}$/.test(text) || /^[0-9a-f:]{3,45}$/i.test(text);
    return {
      mode: "direct",
      datacentre,
      observedIp: valid ? text : null,
      reason: valid ? null : "unparseable",
    };
  } catch (error) {
    return { mode: "direct", datacentre, observedIp: null, reason: `lookup-failed: ${error.name}` };
  }
}

/**
 * The environment block, minus the viewport: the viewport is measured by the app
 * and copied out of a run.json by merge.mjs, because guessing it from a device
 * name would be a number nobody measured.
 */
export async function environmentInfo(simctl, { runtime, deviceType, egress, env = process.env }) {
  const xcode = await simctl.xcodeVersion();
  return {
    runnerImage: env.ImageOS ?? env.RUNNER_IMAGE ?? null,
    macosVersion: null,
    xcode: xcode.version,
    xcodeBuild: xcode.build,
    runtime: runtime?.version ?? null,
    runtimeId: runtime?.identifier ?? null,
    runtimeBuild: runtime?.buildversion ?? null,
    deviceType: deviceType?.name ?? null,
    deviceTypeId: deviceType?.identifier ?? null,
    deviceTypeSelectedBy: deviceType?.reason ?? null,
    viewport: null,
    node: process.versions.node,
    egress,
  };
}
