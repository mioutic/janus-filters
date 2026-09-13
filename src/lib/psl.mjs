// Host normalisation and eTLD+1 extraction. The result is the bucket key
// (PIPELINE 10.3), so it must be deterministic and it must never throw.

import { domainToASCII } from "node:url";
import { EXACT_SUFFIXES, SECOND_LEVEL_LABELS, WILDCARD_TLDS } from "./psl-data.mjs";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIpAddress(host) {
  if (IPV4.test(host)) return true;
  return host.includes(":") || (host.startsWith("[") && host.endsWith("]"));
}

/**
 * Lower-cases, strips a trailing dot, and converts to punycode (UTS-46).
 * @returns {string|null} null when the host cannot be represented (PIPELINE 7.3 step 5)
 */
export function normaliseHost(host) {
  if (typeof host !== "string" || host.length === 0) return null;
  let value = host.trim().toLowerCase();
  while (value.endsWith(".")) value = value.slice(0, -1);
  if (value.length === 0) return null;
  if (value.startsWith("[") && value.endsWith("]")) return value; // IPv6 literal
  if (IPV4.test(value)) return value;
  if (/[\s/\\?#@]/.test(value)) return null;
  // Already ASCII and plain: skip the converter, which is the hot path.
  if (/^[a-z0-9.*_-]+$/.test(value)) return value;
  const ascii = domainToASCII(value);
  return ascii.length === 0 ? null : ascii;
}

/**
 * The public suffix of an already-normalised host.
 * @returns {string} the suffix, or the last label when nothing longer matches
 */
export function publicSuffix(host) {
  if (isIpAddress(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 1) return host;
  // Longest exact match first: co.uk beats uk.
  for (let start = Math.max(0, labels.length - 4); start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join(".");
    if (EXACT_SUFFIXES.has(candidate)) return candidate;
  }
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (WILDCARD_TLDS.has(tld)) return `${second}.${tld}`;
  if (tld.length === 2 && SECOND_LEVEL_LABELS.has(second)) return `${second}.${tld}`;
  return tld;
}

/**
 * eTLD+1 of a host: the public suffix plus one label. Returns the host itself
 * when it is not longer than its own suffix (a bare suffix, or an IP address).
 * @param {string} host any case, any encoding
 * @returns {string|null}
 */
export function etldPlusOne(host) {
  const normalised = normaliseHost(host);
  if (normalised === null) return null;
  if (isIpAddress(normalised)) return normalised;
  const suffix = publicSuffix(normalised);
  if (normalised === suffix) return normalised;
  const suffixLabels = suffix.split(".").length;
  const labels = normalised.split(".");
  if (labels.length <= suffixLabels) return normalised;
  return labels.slice(labels.length - suffixLabels - 1).join(".");
}

/** True when `host` is `base` or a subdomain of it. Both must be normalised. */
export function isSubdomainOf(host, base) {
  return host === base || host.endsWith(`.${base}`);
}
