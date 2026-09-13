// SPDX-License-Identifier: GPL-3.0-or-later
//
// Manifest.swift - CONTRACT section 4, re-implemented from the document.
//
// This model is deliberately a second, independent reading of the contract: if the
// published manifest can be consumed by a program that has never seen the Janus app's
// source, the contract is complete. Two rules from section 4.1 shape everything here:
// unknown fields are ignored (so the pipeline may add fields within contract version 1),
// and a required field that is absent or of the wrong type is a rejection, which
// Codable gives us for free by making those properties non-optional.
//
// The manifest is only decoded after the signature verifies (ContractVerifier), and the
// downloaded bytes are never re-serialised: the signature covers the bytes as served.

import Foundation

/// One file entry: the shape shared by bucket flavours, advanced rules, the engine and
/// the auxiliary payloads.
struct ManifestFile: Decodable {
    let file: String
    let sha256: String
    let size: Int
    let downloadSha256: String
    let downloadSize: Int
    let ruleCount: Int?
    let compileMs: Int?
    let schemaVersion: Int?
}

struct ManifestGenerator: Decodable {
    let pipeline: String?
    let safariConverterLib: String?
    let scriptlets: String?
    let extendedCss: String?
}

struct ManifestList: Decodable {
    let id: String
    let title: String
    let `default`: Bool
    let trust: String
    let license: String
    let homepage: String
    let ruleCount: Int?
}

struct ManifestBucket: Decodable {
    let id: String
    let family: String
    let optIn: Bool
    let lists: [String]
    let flavours: [String: ManifestFile]

    func entry(forFlavour flavour: String) -> ManifestFile? {
        flavours[flavour]
    }
}

struct Manifest: Decodable {
    let contractVersion: Int
    let schemaVersion: Int
    let layoutVersion: Int
    let version: Int64
    let issuedAt: String
    let expiresAt: String
    let keyId: String
    let minAppBuild: Int
    let baseUrl: String
    let mirrors: [String]
    let flavours: [String]
    let generator: ManifestGenerator
    let lists: [ManifestList]
    let buckets: [ManifestBucket]
    let payloads: [String: ManifestFile]
    let killSwitches: [String: Bool]

    /// `advancedRules` and `engine` are required and optional respectively by the
    /// contract, and neither is used by ProbeHost: the harness measures content rules,
    /// not the advanced-rules engine. They are decoded loosely - present and an object,
    /// nothing more - so that a manifest missing a required section is still rejected
    /// while a shape change inside a section this program does not read cannot fail a
    /// measurement run.
    let advancedRulesPresent: Bool
    let enginePresent: Bool

    private enum CodingKeys: String, CodingKey {
        case contractVersion, schemaVersion, layoutVersion, version, issuedAt, expiresAt
        case keyId, minAppBuild, baseUrl, mirrors, flavours, generator, lists, buckets
        case advancedRules, engine, payloads, killSwitches
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contractVersion = try container.decode(Int.self, forKey: .contractVersion)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        layoutVersion = try container.decode(Int.self, forKey: .layoutVersion)
        version = try container.decode(Int64.self, forKey: .version)
        issuedAt = try container.decode(String.self, forKey: .issuedAt)
        expiresAt = try container.decode(String.self, forKey: .expiresAt)
        keyId = try container.decode(String.self, forKey: .keyId)
        minAppBuild = try container.decode(Int.self, forKey: .minAppBuild)
        baseUrl = try container.decode(String.self, forKey: .baseUrl)
        mirrors = try container.decode([String].self, forKey: .mirrors)
        flavours = try container.decode([String].self, forKey: .flavours)
        generator = try container.decode(ManifestGenerator.self, forKey: .generator)
        lists = try container.decode([ManifestList].self, forKey: .lists)
        buckets = try container.decode([ManifestBucket].self, forKey: .buckets)
        payloads = try container.decode([String: ManifestFile].self, forKey: .payloads)
        killSwitches = try container.decode([String: Bool].self, forKey: .killSwitches)

        // Required by section 4.2, read only for its presence.
        _ = try container.nestedContainer(keyedBy: AnyKey.self, forKey: .advancedRules)
        advancedRulesPresent = true
        enginePresent = container.contains(.engine)
    }

    /// A coding key with no fixed cases, for sections that are checked for presence
    /// rather than parsed.
    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { self.intValue = intValue; self.stringValue = String(intValue) }
    }

    // MARK: - Derived views

    var issuedAtDate: Date? { ProbeClock.parseRFC3339(issuedAt) }

    /// True when this kill switch is absent or true. A kill switch may only ever make
    /// the app do less (CONTRACT 10.4), so "absent" means "not disabled".
    func killSwitchEnabled(_ key: String) -> Bool {
        killSwitches[key] ?? true
    }

    /// CONTRACT 8.2: install every bucket that is not opt-in, plus every opt-in bucket
    /// with at least one enabled list. `janus.active` is never opt-in and is always
    /// installed. `-ProbeFamilies` narrows this afterwards, which is a harness feature,
    /// not a supported app configuration, and the record says which families were used.
    func selectedBuckets(flavour: String, families: Set<String>?, optInLists: [String])
        -> [(bucket: ManifestBucket, entry: ManifestFile)]
    {
        let enabled = Set(optInLists)
        var selected: [(bucket: ManifestBucket, entry: ManifestFile)] = []
        for bucket in buckets {
            guard let entry = bucket.entry(forFlavour: flavour) else { continue }
            if bucket.optIn {
                guard bucket.lists.contains(where: { enabled.contains($0) }) else { continue }
            }
            if let families = families, !families.contains(bucket.family) { continue }
            selected.append((bucket, entry))
        }
        return selected
    }

    /// CONTRACT 8.5. The bucket id is a prefix of the identifier and the parts are never
    /// reordered: `blocked.byFamily` in run.json is derived from that prefix.
    static func identifier(bucketId: String, sha256: String) -> String {
        "\(bucketId).\(String(sha256.prefix(8)))"
    }
}

/// `payloads.siteFix` (CONTRACT 10.3). ProbeHost reads exactly one thing from it: the
/// surrogate pattern list, which CONTRACT 8.6 makes the source of the active action
/// patterns for `janus.active`. Everything else in the payload belongs to layers this
/// harness does not run.
struct SiteFixPayload: Decodable {
    struct Surrogate: Decodable {
        let id: String?
        let patterns: [String]?
        let resourceTypes: [String]?
        let unlessDomains: [String]?
        let globals: [String]?
    }

    let schemaVersion: Int
    let surrogates: [Surrogate]?

    var surrogatePatternCount: Int {
        (surrogates ?? []).reduce(0) { $0 + ($1.patterns?.count ?? 0) }
    }
}
