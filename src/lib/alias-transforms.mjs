// Scriptlet call syntax and the argument transforms named by config/ubo-alias.json.
// PIPELINE 9.1: `args: "identity"` passes arguments through; any other value
// names a transform here, and a transform is only added together with a test
// that pins the before and after text of a real rule.

import { policyError } from "./errors.mjs";

/** uBO `+js(name, a, b)` -> {name, args} . Returns null when the body is not a call. */
export function parseUboScriptletBody(body) {
  const match = /^\+js\(([\s\S]*)\)\s*$/.exec(body.trim());
  if (!match) return null;
  const parts = splitCallArguments(match[1]);
  if (parts.length === 0) return null;
  const [name, ...args] = parts;
  return { name: unquote(name.trim()), args: args.map((arg) => unquote(arg.trim())) };
}

/** AdGuard `//scriptlet('name', 'a')` -> {name, args}. Returns null when not a call. */
export function parseAdguardScriptletBody(body) {
  const match = /^\/\/scriptlet\s*\(([\s\S]*)\)\s*$/.exec(body.trim());
  if (!match) return null;
  const parts = splitCallArguments(match[1]);
  if (parts.length === 0) return { name: "", args: [] };
  const [name, ...args] = parts;
  return { name: unquote(name.trim()), args: args.map((arg) => unquote(arg.trim())) };
}

/** Splits a call's argument list on commas that are neither escaped nor quoted. */
export function splitCallArguments(text) {
  const parts = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      current += ch + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0 || parts.length > 0) parts.push(current);
  return parts.filter((part, index) => index === 0 || part.trim().length > 0 || part.length > 0);
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return value.slice(1, -1).replace(/\\(['"\\])/g, "$1");
    }
  }
  return value.replace(/\\,/g, ",");
}

function quoteArgument(value) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Renders an AdGuard scriptlet body: `//scriptlet('name', 'a', 'b')`. */
export function formatAdguardScriptletBody(name, args) {
  const parts = [quoteArgument(name), ...args.map(quoteArgument)];
  return `//scriptlet(${parts.join(", ")})`;
}

/** The transform registry. Keys are the `args` values used in ubo-alias.json. */
export const TRANSFORMS = {
  /** Arguments are passed through unchanged. */
  identity: (args) => [...args],
};

/**
 * @param {string} name transform name from the alias map
 * @param {string[]} args source arguments
 * @returns {string[]} transformed arguments
 */
export function applyTransform(name, args) {
  const transform = TRANSFORMS[name];
  if (!transform) {
    throw policyError(`config/ubo-alias.json names an unknown argument transform "${name}"`, {
      transform: name,
    });
  }
  return transform(args);
}
