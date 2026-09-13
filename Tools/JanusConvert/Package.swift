// swift-tools-version:5.9
//
// JanusConvert - converts one bucket of AdGuard-syntax filter rules into the
// WKContentRuleList JSON flavours Janus ships (PIPELINE.md section 12).
//
// macOS-only, CI-only: there is no Swift toolchain on the development machine,
// so this package must build on the first `swift build` on macos-26 / Xcode 26.6.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import PackageDescription

let package = Package(
    name: "JanusConvert",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "JanusConvert", targets: ["JanusConvert"])
    ],
    dependencies: [
        // Pinned exactly. The library product "ContentBlockerConverter" vends both the
        // ContentBlockerConverter and the FilterEngine modules.
        .package(url: "https://github.com/AdguardTeam/SafariConverterLib", exact: "4.3.0"),
        // The same version SafariConverterLib pins, so SwiftPM resolves a single copy.
        .package(url: "https://github.com/apple/swift-argument-parser", exact: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "JanusConvert",
            dependencies: [
                .product(name: "ContentBlockerConverter", package: "SafariConverterLib"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/JanusConvert"
        )
    ]
)
