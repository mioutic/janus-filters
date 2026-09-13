// Deterministic file IO. Every writer here produces LF endings, no BOM, exactly
// one trailing newline, and JSON with a fixed key order from the caller.
// PIPELINE section 3.

import { mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** Sort comparator by UTF-16 code unit. Never localeCompare. */
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortStrings(values) {
  return [...values].sort(byCodeUnit);
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** CRLF and lone CR become LF; a leading BOM is removed. */
export function normaliseNewlines(text) {
  return stripBom(text).replace(/\r\n?/g, "\n");
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

export function exists(p) {
  return existsSync(p);
}

export async function readText(file) {
  return normaliseNewlines(await readFile(file, "utf8"));
}

export async function readTextIfExists(file) {
  if (!existsSync(file)) return null;
  return readText(file);
}

export async function readBytes(file) {
  return readFile(file);
}

/** Writes text with LF endings and exactly one trailing newline. */
export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  let body = normaliseNewlines(text);
  body = body.replace(/\n+$/, "");
  await writeFile(file, body.length === 0 ? "" : body + "\n", "utf8");
}

/** Writes one line per entry. An empty array writes an empty file, not a blank line. */
export async function writeLines(file, lines) {
  await writeText(file, lines.join("\n"));
}

export async function readLines(file) {
  const text = await readTextIfExists(file);
  if (text === null) return null;
  const body = text.replace(/\n+$/, "");
  return body.length === 0 ? [] : body.split("\n");
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function readJson(file) {
  return JSON.parse(stripBom(await readFile(file, "utf8")));
}

export async function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  return readJson(file);
}

export async function writeJsonl(file, records) {
  await ensureDir(path.dirname(file));
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(file, body.length === 0 ? "" : body + "\n", "utf8");
}

export async function readJsonl(file) {
  const lines = await readLines(file);
  if (lines === null) return null;
  return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/** Directory entries with `suffix`, sorted by code unit. Missing directory -> []. */
export async function listFiles(dir, suffix = "") {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  return sortStrings(names.filter((name) => name.endsWith(suffix)));
}

export async function fileSize(file) {
  const info = await stat(file);
  return info.size;
}
