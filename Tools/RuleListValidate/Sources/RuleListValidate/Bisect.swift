// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bisect.swift - PIPELINE.md section 13, failure handling.
//
// A compile error is one of JSONTooManyRules, JSONInvalidRegex (an unsupported
// url-filter, if-top-url or if-frame-url regex), or an invalid action or trigger
// string. Failure is monotone for the per-rule causes: any subset containing an
// offending rule fails too, so halving the array finds the smallest failing set.
// The exception is JSONTooManyRules, which both halves survive; that is detected and
// reported instead of being papered over by dropping rules.

import Foundation

struct DroppedRule {
    let index: Int
    let element: [String: Any]
    let message: String
    /// True when the rule was isolated on its own, false when the attempt budget ran
    /// out and a whole segment had to be dropped together.
    let precise: Bool
}

struct BisectResult {
    var attempts = 0
    var dropped: [DroppedRule] = []
    /// The attempt budget ran out before every failing rule could be isolated.
    var budgetExhausted = false
    /// Both halves compiled on their own: the list is too big, not wrong.
    var sizeFailure = false
}

struct Bisector {
    let compiler: RuleListCompiler
    let bucketId: String
    let timeoutMs: Int
    let maxAttempts: Int

    /// `elements` must already be known to fail as a whole. Returns the rules to drop.
    func locate(in elements: [[String: Any]], firstMessage: String) throws -> BisectResult {
        var result = BisectResult()
        guard !elements.isEmpty else { return result }

        // Ranges known to fail, with the message of the smallest failing set that
        // contained them.
        var failing: [(range: Range<Int>, message: String)] = [(0..<elements.count, firstMessage)]

        while let current = failing.popLast() {
            if current.range.count == 1 {
                let index = current.range.lowerBound
                result.dropped.append(
                    DroppedRule(
                        index: index,
                        element: elements[index],
                        message: current.message,
                        precise: true
                    )
                )
                continue
            }

            if result.attempts + 2 > maxAttempts {
                // Out of budget: drop the smallest failing set found so far, as a
                // unit, and say so. Nothing is dropped without a record.
                result.budgetExhausted = true
                for index in current.range {
                    result.dropped.append(
                        DroppedRule(
                            index: index,
                            element: elements[index],
                            message: current.message,
                            precise: false
                        )
                    )
                }
                continue
            }

            let middle = current.range.lowerBound + current.range.count / 2
            let left = current.range.lowerBound..<middle
            let right = middle..<current.range.upperBound

            let leftOutcome = try attempt(elements, range: left)
            result.attempts += 1
            let rightOutcome = try attempt(elements, range: right)
            result.attempts += 1

            if leftOutcome.succeeded && rightOutcome.succeeded {
                // Neither half contains an offending rule, so the failure is about the
                // size of the list. Dropping rules would hide a bucketing bug.
                result.sizeFailure = true
                Log.error("bisect-size-failure", [
                    "bucketId": bucketId,
                    "rangeLowerBound": current.range.lowerBound,
                    "rangeUpperBound": current.range.upperBound,
                    "message": current.message,
                ])
                return result
            }

            // Deeper ranges are pushed last so the smallest sets are examined first.
            if !rightOutcome.succeeded {
                failing.append((right, rightOutcome.failureMessage ?? current.message))
            }
            if !leftOutcome.succeeded {
                failing.append((left, leftOutcome.failureMessage ?? current.message))
            }
        }

        return result
    }

    private func attempt(_ elements: [[String: Any]], range: Range<Int>) throws -> CompileOutcome {
        let subset = Array(elements[range])
        let encoded = try RuleListJSON.encode(subset)
        let identifier = compiler.nextProbeIdentifier(for: bucketId)
        let outcome = compiler.compile(identifier: identifier, encoded: encoded, timeoutMs: timeoutMs)
        Log.info("bisect-attempt", [
            "bucketId": bucketId,
            "lowerBound": range.lowerBound,
            "upperBound": range.upperBound,
            "ruleCount": subset.count,
            "succeeded": outcome.succeeded,
            "compileMs": outcome.milliseconds,
        ])
        return outcome
    }
}

/// Serialising a rule array back to JSON. Only a bucket the bisector rewrote goes
/// through this: an untouched bucket keeps the exact bytes SafariConverterLib
/// produced, because the manifest SHA-256 is over those bytes.
enum RuleListJSON {
    static func encodeData(_ elements: [[String: Any]]) throws -> Data {
        do {
            return try JSONSerialization.data(
                withJSONObject: elements,
                options: [.sortedKeys, .withoutEscapingSlashes]
            )
        } catch {
            throw JanusError.internalFailure(
                "rule-list-encode-failed",
                "could not re-encode a rule list: " + error.localizedDescription
            )
        }
    }

    static func encode(_ elements: [[String: Any]]) throws -> String {
        let data = try encodeData(elements)
        guard let text = String(data: data, encoding: .utf8) else {
            throw JanusError.internalFailure(
                "rule-list-encode-not-utf8",
                "a re-encoded rule list was not valid UTF-8"
            )
        }
        return text
    }

    /// Parses a converted bucket: a top-level array whose every element is an object.
    static func parse(_ data: Data, bucketId: String) throws -> [[String: Any]] {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            throw JanusError.integrity(
                "bucket-not-json",
                "bucket " + bucketId + " does not parse as JSON: " + error.localizedDescription,
                ["bucketId": bucketId]
            )
        }
        guard let array = parsed as? [Any] else {
            throw JanusError.integrity(
                "bucket-not-array",
                "bucket " + bucketId + " is not a top-level array",
                ["bucketId": bucketId]
            )
        }
        var elements: [[String: Any]] = []
        elements.reserveCapacity(array.count)
        for (index, element) in array.enumerated() {
            guard let object = element as? [String: Any] else {
                throw JanusError.integrity(
                    "bucket-element-not-object",
                    "bucket " + bucketId + " has a non-object element at index " + String(index),
                    ["bucketId": bucketId, "index": index]
                )
            }
            elements.append(object)
        }
        return elements
    }
}
