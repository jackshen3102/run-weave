// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "RunweaveBrowser",
  platforms: [.iOS(.v15)],
  products: [.library(name: "RunweaveBrowser", targets: ["RunweaveBrowser"])],
  targets: [.target(name: "RunweaveBrowser")],
  swiftLanguageModes: [.v5]
)
