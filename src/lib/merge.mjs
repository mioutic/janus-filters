// Dedupe, $badfilter and provenance. PIPELINE 7.5 and 7.6.
//
// Order is preserved because filter semantics inside a compiled list are
// order-dependent (PIPELINE 10.3): dedupe may never reorder. The same merge runs
// twice - once in preprocess over build/prepared/, once in bucket over
// build/xlated/ - and it is idempotent, so the second pass cannot change a
// decision the first one made.

import { hasModifier, neutralisedBadfilterText } from "./rule.mjs";

/**
 * @typedef {{listId: string, entries: Array<{text: string, line: number, rule: object}>}} Stream
 */

/**
 * @param {Stream[]} streams in lists.json order
 * @returns {{lines: string[], provenance: Array<{rule:string,listId:string,line:number}>,
 *            perList: Record<string, {in:number, kept:number, duplicateOfEarlierList:number,
 *            removedByBadfilter:number, badfilterRules:number}>,
 *            unmatchedBadfilters: Array<{listId:string, line:number, rule:string}>,
 *            removedByBadfilter: Array<{listId:string, line:number, rule:string, by:string}>}}
 */
export function mergeRuleStreams(streams) {
  const perList = {};
  const ordered = [];
  const seen = new Map(); // normalised text -> index in ordered

  for (const stream of streams) {
    perList[stream.listId] = {
      in: stream.entries.length,
      kept: 0,
      duplicateOfEarlierList: 0,
      removedByBadfilter: 0,
      badfilterRules: 0,
    };
    for (const entry of stream.entries) {
      if (seen.has(entry.text)) {
        perList[stream.listId].duplicateOfEarlierList += 1;
        continue;
      }
      seen.set(entry.text, ordered.length);
      ordered.push({ ...entry, listId: stream.listId, alive: true });
      perList[stream.listId].kept += 1;
    }
  }

  // $badfilter, across the merged set: a badfilter in unbreak.txt must be able to
  // disable a rule that came from AdGuard Base.
  const unmatchedBadfilters = [];
  const removedByBadfilter = [];
  for (const entry of ordered) {
    if (!entry.alive || entry.rule.type !== "network" || !hasModifier(entry.rule, "badfilter")) {
      continue;
    }
    perList[entry.listId].badfilterRules += 1;
    const neutralised = neutralisedBadfilterText(entry.rule);
    const targetIndex = neutralised === null ? undefined : seen.get(neutralised);
    entry.alive = false; // the badfilter rule itself never ships
    perList[entry.listId].kept -= 1;
    if (targetIndex === undefined) {
      unmatchedBadfilters.push({ listId: entry.listId, line: entry.line, rule: entry.text });
      continue;
    }
    const target = ordered[targetIndex];
    if (!target.alive) continue;
    target.alive = false;
    perList[target.listId].kept -= 1;
    perList[target.listId].removedByBadfilter += 1;
    removedByBadfilter.push({
      listId: target.listId,
      line: target.line,
      rule: target.text,
      by: entry.text,
    });
  }

  const alive = ordered.filter((entry) => entry.alive);
  return {
    lines: alive.map((entry) => entry.text),
    provenance: alive.map((entry) => ({ rule: entry.text, listId: entry.listId, line: entry.line })),
    perList,
    unmatchedBadfilters,
    removedByBadfilter,
  };
}
