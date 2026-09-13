// SPDX-License-Identifier: GPL-3.0-or-later
//
// Lzfse.swift - PIPELINE.md section 13, the compression half of RuleListValidate.
//
// Payloads are compressed here rather than by shelling out to `compression_tool`, so
// there is one implementation and the round trip is verified in memory before a byte
// is written. A corrupted payload that only fails on the phone is exactly the failure
// mode this pipeline must not have.

import Compression
import Foundation

enum Lzfse {
    /// Compresses with COMPRESSION_LZFSE - the same codec
    /// `NSData.decompressed(using: .lzfse)` reads on the device - and verifies the
    /// result decompresses back to the input, both through the raw compression
    /// framework and through the Foundation API the app itself calls.
    static func compress(_ source: Data, label: String) throws -> Data {
        guard !source.isEmpty else {
            throw JanusError.integrity("lzfse-empty-input", "refusing to compress an empty payload: " + label)
        }

        // LZFSE emits an uncompressed block for incompressible input, which is
        // slightly larger than the input, so the destination is deliberately roomy.
        let capacity = source.count + max(4096, source.count / 8)
        var destination = Data(count: capacity)

        let written = destination.withUnsafeMutableBytes { (destinationRaw: UnsafeMutableRawBufferPointer) -> Int in
            source.withUnsafeBytes { (sourceRaw: UnsafeRawBufferPointer) -> Int in
                guard let destinationBase = destinationRaw.bindMemory(to: UInt8.self).baseAddress,
                      let sourceBase = sourceRaw.bindMemory(to: UInt8.self).baseAddress
                else { return 0 }
                return compression_encode_buffer(
                    destinationBase,
                    capacity,
                    sourceBase,
                    source.count,
                    nil,
                    COMPRESSION_LZFSE
                )
            }
        }

        guard written > 0, written <= capacity else {
            throw JanusError.integrity(
                "lzfse-encode-failed",
                "compression_encode_buffer produced no output for " + label,
                ["label": label, "sourceBytes": source.count]
            )
        }
        let compressed = destination.prefix(written)

        try verifyRoundTrip(compressed: Data(compressed), original: source, label: label)
        return Data(compressed)
    }

    /// Decompresses with the raw framework and with the Foundation API the device
    /// uses, and fails unless both reproduce the original bytes exactly.
    static func verifyRoundTrip(compressed: Data, original: Data, label: String) throws {
        var restored = Data(count: original.count)
        let produced = restored.withUnsafeMutableBytes { (restoredRaw: UnsafeMutableRawBufferPointer) -> Int in
            compressed.withUnsafeBytes { (compressedRaw: UnsafeRawBufferPointer) -> Int in
                guard let restoredBase = restoredRaw.bindMemory(to: UInt8.self).baseAddress,
                      let compressedBase = compressedRaw.bindMemory(to: UInt8.self).baseAddress
                else { return 0 }
                return compression_decode_buffer(
                    restoredBase,
                    original.count,
                    compressedBase,
                    compressed.count,
                    nil,
                    COMPRESSION_LZFSE
                )
            }
        }

        guard produced == original.count, restored == original else {
            throw JanusError.integrity(
                "lzfse-roundtrip-failed",
                "the LZFSE round trip did not reproduce " + label,
                ["label": label, "expectedBytes": original.count, "decodedBytes": produced]
            )
        }

        // The device calls NSData.decompressed(using: .lzfse); verifying through that
        // exact API is what proves the published bytes are readable on the phone.
        let viaFoundation: Data
        do {
            let decoded = try (compressed as NSData).decompressed(using: .lzfse)
            viaFoundation = Data(referencing: decoded)
        } catch {
            throw JanusError.integrity(
                "lzfse-foundation-decode-failed",
                "NSData.decompressed(using: .lzfse) rejected " + label + ": " + error.localizedDescription,
                ["label": label]
            )
        }
        guard viaFoundation == original else {
            throw JanusError.integrity(
                "lzfse-foundation-mismatch",
                "NSData.decompressed(using: .lzfse) returned different bytes for " + label,
                ["label": label, "expectedBytes": original.count, "decodedBytes": viaFoundation.count]
            )
        }
    }
}
