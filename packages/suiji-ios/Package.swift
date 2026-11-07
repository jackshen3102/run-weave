// swift-tools-version:6.0
import PackageDescription
let package = Package(name: "SuijiIOS", platforms: [.iOS("18.6")],
  products: [.library(name: "SuijiIOS", targets: ["SuijiIOS"]), .library(name: "SuijiCaptureCore", targets: ["SuijiCaptureCore"])],
  dependencies: [.package(path: "../browser-ios"), .package(path: "../ios-build-identity"), .package(url: "https://github.com/microsoft/clarity-apps", exact: "4.1.0")],
  targets: [.target(name: "SuijiCaptureCore"), .target(name: "SuijiIOS", dependencies: ["SuijiCaptureCore", .product(name: "Clarity", package: "clarity-apps"), .product(name: "RunweaveBrowser", package: "browser-ios"), .product(name: "IOSBuildIdentity", package: "ios-build-identity")],
    resources: [.process("Resources")])], swiftLanguageModes: [.v5])
