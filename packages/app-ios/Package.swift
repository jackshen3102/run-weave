// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "RunweaveIOS",
  platforms: [.iOS(.v15)],
  products: [.library(name: "RunweaveIOS", targets: ["RunweaveIOS"])],
  dependencies: [
    .package(path: "Vendor/SwiftTerm"),
    .package(path: "../browser-ios"), .package(path: "../ios-build-identity")
  ],
  targets: [
    .target(name: "RunweaveIOS", dependencies: [
      "SwiftTerm", .product(name: "RunweaveBrowser", package: "browser-ios"), .product(name: "IOSBuildIdentity", package: "ios-build-identity")
    ])
  ],
  swiftLanguageModes: [.v5]
)
