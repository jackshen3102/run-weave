// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "RunweaveIOS",
  platforms: [.iOS(.v15)],
  products: [.library(name: "RunweaveIOS", targets: ["RunweaveIOS"])],
  dependencies: [
    .package(path: "Vendor/SwiftTerm"),
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", exact: "2.4.1"),
    .package(url: "https://github.com/microsoft/clarity-apps", exact: "4.1.0"),
    .package(path: "../browser-ios"), .package(path: "../ios-build-identity")
  ],
  targets: [
    .target(name: "RunweaveIOS", dependencies: [
      "SwiftTerm", .product(name: "MarkdownUI", package: "swift-markdown-ui"),
      .product(name: "Clarity", package: "clarity-apps"),
      .product(name: "RunweaveBrowser", package: "browser-ios"), .product(name: "IOSBuildIdentity", package: "ios-build-identity")
    ])
  ],
  swiftLanguageModes: [.v5]
)
