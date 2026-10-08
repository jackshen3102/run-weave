import SwiftUI
import Clarity

struct ConnectionRouteEditor: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var store: ConnectionStore
  let computerID: String
  let route: ConnectionRoute?
  @State private var name = ""
  @State private var url = ""
  @State private var failure: String?

  var body: some View {
    NavigationView {
      Form {
        Section {
          TextField("线路名称", text: $name).clarityMask().accessibilityIdentifier("connection-route-name")
          TextField("HTTP 或 HTTPS 地址", text: $url).keyboardType(.URL)
            .autocapitalization(.none).disableAutocorrection(true).clarityMask()
            .accessibilityIdentifier("connection-route-url")
        } footer: { Text("添加通向同一台电脑的地址。连接前会验证电脑身份。") }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
      }
      .navigationTitle(route == nil ? "添加线路" : "编辑线路").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("保存") {
            do { try store.saveRoute(computerID: computerID, routeID: route?.id, name: name, url: url); dismiss() }
            catch { failure = displayError(error) }
          }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || url.isEmpty)
        }
      }.onAppear { name = route?.name ?? ""; url = route?.url ?? "" }
    }.navigationViewStyle(.stack)
  }
}
