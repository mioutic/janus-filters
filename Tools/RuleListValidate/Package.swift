// swift-tools-version:5.9
//
// RuleListValidate - compiles every produced bucket with the real WebKit compiler,
// the only authority on whether a rule list will load on the phone
// (PIPELINE.md section 13).
//
// macOS-only, CI-only: there is no Swift toolchain on the development machine, so
// this package must build on the first `swift build` on macos-26 / Xcode 26.6.
// No external dependencies by design - it links WebKit, CryptoKit and Compression
// from the SDK and parses its own arguments.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import PackageDescription

let package = Package(
    name: "RuleListValidate",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "RuleListValidate", targets: ["RuleListValidate"])
    ],
    targets: [
        .executableTarget(
            name: "RuleListValidate",
            path: "Sources/RuleListValidate",
            linkerSettings: [
                .linkedFramework("WebKit")
            ]
        )
    ]
)
