// swift-tools-version:6.0
import PackageDescription
let package = Package(name: "SuijiIOS", platforms: [.iOS("18.6")],
  products: [.library(name: "SuijiIOS", targets: ["SuijiIOS"])],
  dependencies: [.package(path: "../browser-ios"), .package(path: "../ios-build-identity")],
  targets: [.target(name: "SuijiIOS", dependencies: [.product(name: "RunweaveBrowser", package: "browser-ios"), .product(name: "IOSBuildIdentity", package: "ios-build-identity")],
    resources: [.process("Resources")])], swiftLanguageModes: [.v5])
