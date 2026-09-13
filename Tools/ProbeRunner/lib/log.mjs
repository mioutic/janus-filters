// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runner logging (docs/probehost/02-runner.md section 5): one line per work item,
// human-readable, no ANSI under CI, and the same bytes appended to the suite's
// own run.log so the artifact carries what the job log carried.
//
// Hygiene: paths are printed repo-relative, never as a developer's absolute path,
// and nothing read from the environment is logged except the documented public
// GitHub Actions context fields (docs/probehost/03-report.md section 2).

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOURS = {
  debug: "\u001b[2m",
  info: "",
  warn: "\u001b[33m",
  error: "\u001b[31m",
  reset: "\u001b[0m",
};

/** True when this process looks like a hosted CI runner. */
export function isCi(env = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS);
}

/** ANSI is for a human terminal only: CI logs keep the escape codes out. */
export function useColour(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return false;
  if (isCi(env)) return false;
  return Boolean(stream && stream.isTTY);
}

/**
 * A path as the log should print it: relative to the repository root when it is
 * inside it, and otherwise only its last two segments. An absolute path from a
 * developer's machine never reaches a public artifact this way.
 */
export function relativise(target, cwd = process.cwd()) {
  if (typeof target !== "string" || target.length === 0) return target;
  const absolute = path.resolve(target);
  const relative = path.relative(cwd, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  const parts = absolute.split(path.sep).filter(Boolean);
  return parts.length <= 2 ? path.basename(absolute) : `…/${parts.slice(-2).join("/")}`;
}

/** `key=value`, quoting only what needs it. Undefined fields are dropped. */
export function formatFields(fields) {
  if (!fields) return "";
  const parts = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    let value = raw;
    if (value === null) value = "null";
    else if (typeof value === "object") value = JSON.stringify(value);
    else value = String(value);
    parts.push(/[\s"]/.test(value) ? `${key}=${JSON.stringify(value)}` : `${key}=${value}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** `93400` -> `93.4 s`; small values stay in whole milliseconds. */
export function formatMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (Math.abs(ms) < 10000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = (date) =>
  `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

/**
 * @param {object} [options]
 * @param {string|null} [options.filePath] append every line here as well
 * @param {boolean} [options.quiet] suppress debug lines
 * @param {boolean} [options.colour]
 * @param {() => Date} [options.clock]
 * @param {(text: string) => void} [options.write] stdout sink, injectable for tests
 */
export function createRunnerLog({
  filePath = null,
  quiet = false,
  colour = useColour(),
  clock = () => new Date(),
  write = (text) => process.stdout.write(text),
} = {}) {
  const threshold = quiet ? LEVELS.info : LEVELS.debug;
  let fileOk = Boolean(filePath);
  if (fileOk) {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      fileOk = false;
    }
  }

  const emit = (level, message, fields) => {
    const line = `${stamp(clock())} ${level.padEnd(5)} ${message}${formatFields(fields)}\n`;
    if (LEVELS[level] >= threshold) {
      write(colour && COLOURS[level] ? `${COLOURS[level]}${line}${COLOURS.reset}` : line);
    }
    if (fileOk) {
      try {
        appendFileSync(filePath, line, "utf8");
      } catch {
        // A log that cannot be written must never fail a measurement run.
        fileOk = false;
      }
    }
  };

  return {
    filePath: fileOk ? filePath : null,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    /** The one line a work item is entitled to. */
    item: (runId, status, fields) => emit(status === "ok" ? "info" : "warn", `item ${runId} ${status}`, fields),
    /** A blank-line-separated heading, for the few phase boundaries worth one. */
    section: (title) => emit("info", `— ${title} —`),
  };
}

/** A logger that swallows everything, for unit tests. */
export function nullLog() {
  const noop = () => {};
  return { filePath: null, debug: noop, info: noop, warn: noop, error: noop, item: noop, section: noop };
}
