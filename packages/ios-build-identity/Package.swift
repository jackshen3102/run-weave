// swift-tools-version:6.0
import PackageDescription
let package = Package(name: "IOSBuildIdentity", platforms: [.iOS(.v15)],
  products: [.library(name: "IOSBuildIdentity", targets: ["IOSBuildIdentity"])],
  targets: [.target(name: "IOSBuildIdentity")], swiftLanguageModes: [.v5])
