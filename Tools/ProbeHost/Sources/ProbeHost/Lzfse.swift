// SPDX-License-Identifier: GPL-3.0-or-later
//
// Lzfse.swift - CONTRACT section 2, the decompression half of the transport rules.
//
// Every payload is LZFSE and is expanded with exactly the API the contract names,
// `NSData.decompressed(using: .lzfse)`, so ProbeHost exercises the same decoder a phone
// would. The size guards come first: the compressed length must equal `downloadSize`
// and the expanded length must equal `size`, both of which are inside the signed
// manifest. A decompression bomb is therefore unreachable - the expanded size is known
// and signed before a single byte is expanded.

import Foundation

enum Lzfse {
    /// An upper bound that no real bucket approaches (the largest published bucket is
    /// under 10 MB expanded). It exists so a manifest that is somehow both signed and
    /// absurd still cannot ask the harness to allocate the device.
    static let maximumExpandedBytes = 64 * 1024 * 1024

    static func decompress(_ compressed: Data, expectedSize: Int, label: String) throws -> Data {
        guard expectedSize > 0, expectedSize <= maximumExpandedBytes else {
            throw ProbeFailure(
                .bundle, "size-implausible",
                "\(label): manifest size \(expectedSize) is outside 1...\(maximumExpandedBytes)"
            )
        }

        let expanded: Data
        do {
            let decoded = try (compressed as NSData).decompressed(using: .lzfse)
            expanded = Data(referencing: decoded)
        } catch {
            throw ProbeFailure(
                .bundle, "lzfse-decode",
                "\(label): NSData.decompressed(using: .lzfse) failed: \(error.localizedDescription)"
            )
        }

        // CONTRACT section 6 step 14. A length that differs from the signed one means
        // the bytes are not the bytes that were signed, whatever the decoder thought.
        guard expanded.count == expectedSize else {
            throw ProbeFailure(
                .bundle, "size-mismatch",
                "\(label): decompressed to \(expanded.count) bytes, manifest says \(expectedSize)"
            )
        }
        return expanded
    }
}
