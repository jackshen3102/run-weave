// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "RunweaveIOS",
  platforms: [.iOS(.v15)],
  products: [.library(name: "RunweaveIOS", targets: ["RunweaveIOS"])],
  dependencies: [
    .package(path: "Vendor/SwiftTerm")
  ],
  targets: [
    .target(name: "RunweaveIOS", dependencies: ["SwiftTerm"])
  ],
  swiftLanguageModes: [.v5]
)
