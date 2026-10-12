import Foundation

// Version projection of @runweave/shared/runtime-status; unknown fields remain compatible.
struct RuntimeVersionSnapshot: Decodable {
  let protocolVersion: Int
  let generatedAt: Double
  let reports: [Report]

  struct Report: Decodable { let items: [Item] }
  struct Item: Decodable {
    let id: String
    let state: String
    let facts: [Fact]

    var versionFacts: [Fact] {
      var values = facts.filter { $0.id.hasPrefix("runtime-version.") }
      // Older App Servers reported their installed version under this owner-specific ID.
      if id == "app-server.process", !values.contains(where: { $0.id == "runtime-version.number" }),
        let legacy = facts.first(where: { $0.id == "app-server.version" }) {
        values.insert(Fact(id: "runtime-version.number", label: legacy.label, value: legacy.value), at: 0)
      }
      return values
    }
    var historical: Bool { ["blocked", "unhealthy", "disabled"].contains(state) }
  }
  struct Fact: Decodable, Identifiable {
    let id: String
    let label: String
    let value: String
  }

  var items: [Item] { reports.flatMap(\.items) }
}
