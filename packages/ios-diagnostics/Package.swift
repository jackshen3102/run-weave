// swift-tools-version:6.0
import PackageDescription

let package = Package(name: "IOSDiagnostics", platforms: [.iOS(.v15), .macOS(.v13)],
  products: [.library(name: "IOSDiagnostics", targets: ["IOSDiagnostics"])],
  targets: [.target(name: "IOSDiagnostics")], swiftLanguageModes: [.v5])
