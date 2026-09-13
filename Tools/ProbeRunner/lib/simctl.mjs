// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every `xcrun` call the repository makes (docs/probehost/00-index.md section 3:
// "nothing outside Tools/ProbeRunner may shell out to xcrun"). One module, one
// place to audit, one place where a timeout is enforced.
//
// Process discipline, stated once because it is a hard rule: this module spawns
// child processes and lets Node terminate the exact child handle it created when
// a timeout expires. It never enumerates host processes, never matches one by
// name, and never signals anything it did not start. The only "stop" it issues
// inside a simulator is `simctl terminate <udid> <bundleId>`, which is bounded to
// one app in one device (02-runner.md section 2.4).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** simctl output can be large (`list -j` on a full image); JSON needs room. */
const MAX_BUFFER = 64 * 1024 * 1024;

export const TIMEOUTS = Object.freeze({
  quick: 60_000,
  list: 90_000,
  create: 120_000,
  boot: 120_000,
  bootstatus: 300_000,
  install: 300_000,
  launch: 120_000,
  screenshot: 60_000,
  shutdown: 120_000,
});

export class SimctlError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SimctlError";
    this.details = details;
    this.timedOut = Boolean(details.timedOut);
  }
}

const clip = (text, max = 4000) => {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

/**
 * @param {object} [options]
 * @param {(file: string, args: string[], opts: object) => Promise<{stdout: string, stderr: string}>} [options.exec]
 *   injectable for tests; defaults to promisified execFile
 * @param {{debug: Function, warn: Function}} [options.log]
 */
export function createSimctl({ exec = execFileAsync, log = null } = {}) {
  async function xcrun(args, { timeoutMs = TIMEOUTS.quick, allowFailure = false } = {}) {
    const started = Date.now();
    try {
      const { stdout, stderr } = await exec("xcrun", args, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        killSignal: "SIGTERM",
      });
      log?.debug?.("xcrun", { args: args.slice(0, 3).join(" "), ms: Date.now() - started });
      return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "", ms: Date.now() - started };
    } catch (error) {
      const result = {
        ok: false,
        stdout: clip(error.stdout),
        stderr: clip(error.stderr),
        code: typeof error.code === "number" ? error.code : null,
        signal: error.signal ?? null,
        timedOut: error.killed === true || error.signal === "SIGTERM",
        ms: Date.now() - started,
      };
      if (allowFailure) return result;
      throw new SimctlError(`xcrun ${args[0] ?? ""} ${args[1] ?? ""} failed`, {
        args,
        ...result,
      });
    }
  }

  const simctl = (args, options) => xcrun(["simctl", ...args], options);

  return {
    xcrun,
    simctl,

    /** `simctl list -j runtimes devicetypes devices`, parsed. */
    async list(domains = ["runtimes", "devicetypes", "devices"]) {
      const { stdout } = await simctl(["list", "-j", ...domains], { timeoutMs: TIMEOUTS.list });
      try {
        return JSON.parse(stdout);
      } catch (error) {
        throw new SimctlError("simctl list did not return JSON", {
          reason: error.message,
          head: clip(stdout, 400),
        });
      }
    },

    /** Returns the new UDID. The device type and runtime must already exist. */
    async create(name, deviceTypeId, runtimeId) {
      const { stdout } = await simctl(["create", name, deviceTypeId, runtimeId], {
        timeoutMs: TIMEOUTS.create,
      });
      const udid = stdout.trim().split(/\s+/).pop() ?? "";
      if (!/^[0-9A-Fa-f-]{36}$/.test(udid)) {
        throw new SimctlError("simctl create did not return a UDID", { head: clip(stdout, 200) });
      }
      return udid;
    },

    /**
     * Boot is idempotent here: a device already booted reports "Unable to boot
     * device in current state: Booted", which is success for our purposes.
     */
    async boot(udid) {
      const result = await simctl(["boot", udid], { timeoutMs: TIMEOUTS.boot, allowFailure: true });
      if (result.ok) return { booted: true, alreadyBooted: false };
      if (/current state: Booted/i.test(`${result.stderr}${result.stdout}`)) {
        return { booted: true, alreadyBooted: true };
      }
      throw new SimctlError("simctl boot failed", { udid, ...result });
    },

    /** Blocks until the device finished booting. Replaces every sleep-and-hope loop. */
    async bootstatus(udid, timeoutMs = TIMEOUTS.bootstatus) {
      await simctl(["bootstatus", udid, "-b"], { timeoutMs });
      return true;
    },

    /**
     * 9:41, full battery, full bars: two runs then differ only where the page
     * differs (02-runner.md section 2.3). Advisory — a runtime that refuses the
     * override still measures fine, so this returns ok/false instead of throwing.
     */
    async statusBarOverride(udid) {
      const result = await simctl(
        [
          "status_bar",
          udid,
          "override",
          "--time",
          "9:41",
          "--batteryState",
          "charged",
          "--batteryLevel",
          "100",
          "--cellularMode",
          "active",
          "--cellularBars",
          "4",
          "--wifiMode",
          "active",
          "--wifiBars",
          "3",
        ],
        { timeoutMs: TIMEOUTS.quick, allowFailure: true },
      );
      if (!result.ok) log?.warn?.("status bar override refused", { reason: clip(result.stderr, 200) });
      return result.ok;
    },

    async install(udid, appPath) {
      await simctl(["install", udid, appPath], { timeoutMs: TIMEOUTS.install });
      return true;
    },

    /** The host-side path of the app container. Resolved once per install. */
    async getAppContainer(udid, bundleId, kind = "data") {
      const { stdout } = await simctl(["get_app_container", udid, bundleId, kind], {
        timeoutMs: TIMEOUTS.quick,
      });
      const dir = stdout.trim();
      if (dir.length === 0) throw new SimctlError("empty app container path", { udid, bundleId, kind });
      return dir;
    },

    /**
     * Detached by default: `--console-pty` blocks on a pty that a hung web content
     * process can hold open, and the DONE sentinel is the completion signal
     * (02-runner.md section 5 step 2). `--console-pty` stays available behind
     * run.mjs --console for a human debugging one scenario.
     */
    async launch(udid, bundleId, appArgs = [], { console: pty = false, timeoutMs = TIMEOUTS.launch } = {}) {
      const flags = ["--terminate-running-process"];
      if (pty) flags.push("--console-pty");
      const result = await simctl(["launch", ...flags, udid, bundleId, ...appArgs], {
        timeoutMs,
        allowFailure: true,
      });
      if (!result.ok) {
        throw new SimctlError("simctl launch failed", { udid, bundleId, ...result });
      }
      // "io.github.mioutic.probehost: 41234" — the launch result, not the app exit
      // code, which is why run.json carries harness.exitCode (00-index.md section 1).
      const pid = Number((result.stdout.match(/:\s*(\d+)\s*$/m) ?? [])[1] ?? NaN);
      return { pid: Number.isFinite(pid) ? pid : null, stdout: clip(result.stdout, 400) };
    },

    /** The only stop this runner ever issues: one app, inside one simulator. */
    async terminate(udid, bundleId) {
      const result = await simctl(["terminate", udid, bundleId], {
        timeoutMs: TIMEOUTS.quick,
        allowFailure: true,
      });
      return result.ok;
    },

    async screenshot(udid, outPath) {
      const result = await simctl(["io", udid, "screenshot", outPath], {
        timeoutMs: TIMEOUTS.screenshot,
        allowFailure: true,
      });
      return result.ok;
    },

    async shutdown(udid) {
      const result = await simctl(["shutdown", udid], {
        timeoutMs: TIMEOUTS.shutdown,
        allowFailure: true,
      });
      if (!result.ok && !/current state: Shutdown/i.test(`${result.stderr}${result.stdout}`)) {
        log?.warn?.("simctl shutdown reported an error", { reason: clip(result.stderr, 200) });
        return false;
      }
      return true;
    },

    async deleteDevice(udid) {
      const result = await simctl(["delete", udid], { timeoutMs: TIMEOUTS.shutdown, allowFailure: true });
      return result.ok;
    },

    /** `Xcode 26.6\nBuild version 26F1` -> { version, build }. */
    async xcodeVersion() {
      const result = await xcrun(["xcodebuild", "-version"], {
        timeoutMs: TIMEOUTS.quick,
        allowFailure: true,
      });
      if (!result.ok) return { version: null, build: null };
      const version = (result.stdout.match(/Xcode\s+([0-9.]+)/) ?? [])[1] ?? null;
      const build = (result.stdout.match(/Build version\s+(\S+)/) ?? [])[1] ?? null;
      return { version, build };
    },
  };
}

/** `sw_vers -productVersion`, kept here because it is the other host fact we shell out for. */
export async function macosVersion(exec = execFileAsync) {
  try {
    const { stdout } = await exec("sw_vers", ["-productVersion"], {
      timeout: TIMEOUTS.quick,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
