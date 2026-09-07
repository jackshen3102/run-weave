// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "RunweaveIOS",
  platforms: [.iOS(.v15)],
  products: [.library(name: "RunweaveIOS", targets: ["RunweaveIOS"])],
  dependencies: [
    .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.19.0")
  ],
  targets: [
    .target(name: "RunweaveIOS", dependencies: ["SwiftTerm"])
  ],
  swiftLanguageModes: [.v5]
)
