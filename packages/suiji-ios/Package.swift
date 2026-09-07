// swift-tools-version:6.0
import PackageDescription
let package = Package(name: "SuijiIOS", platforms: [.iOS("18.6")],
  products: [.library(name: "SuijiIOS", targets: ["SuijiIOS"])],
  targets: [.target(name: "SuijiIOS", resources: [.process("Resources")])], swiftLanguageModes: [.v5])
