import Clarity
import SwiftUI

struct ConnectionAddView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  let onMobileLogin: () -> Void
  let onConnected: () -> Void

  var body: some View {
    NavigationView {
      List {
        ConnectionAddActions(disabled: store.storageError != nil, store: store, session: session,
          onMobileLogin: onMobileLogin, onConnected: onConnected)
        if let error = store.storageError { Text(error).foregroundColor(.red) }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("添加连接").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("关闭") { dismiss() } } }
    }.navigationViewStyle(.stack)
  }
}

/// Shared by the empty picker and the add page, so first use does not hide scanning behind another tap.
struct ConnectionAddActions: View {
  let disabled: Bool
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  let onMobileLogin: () -> Void
  let onConnected: () -> Void
  @State private var scanning = false
  @State private var manual = false
  @State private var manualAfterScan = false

  var body: some View {
    Section {
      VStack(spacing: 16) {
        Image(systemName: "laptopcomputer.and.iphone").font(.system(size: 44)).foregroundColor(.secondary)
        Text("连接你的电脑").font(.title2.bold())
        Text("在电脑端打开「当前连接 → 连接手机」二维码")
          .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
        Button { scanning = true } label: {
          Label("扫码连接电脑", systemImage: "qrcode.viewfinder")
            .font(.headline).frame(maxWidth: .infinity, minHeight: 36)
        }.buttonStyle(.borderedProminent).disabled(disabled)
          .accessibilityIdentifier("connection-scan")
      }.frame(maxWidth: .infinity).padding(.vertical, 20)
    }
    Section {
      Button { manual = true } label: { Label("手动输入地址", systemImage: "link") }
        .disabled(disabled).accessibilityIdentifier("connection-manual-add")
    }
    .sheet(isPresented: $manual) {
      ConnectionEditorView(store: store, connectionID: nil) {
        manual = false
        onConnected()
      }
    }
    .sheet(isPresented: $scanning, onDismiss: {
      if manualAfterScan { manualAfterScan = false; manual = true }
    }) {
      MobileLoginView(store: store, session: session, onManualConnection: { manualAfterScan = true }) {
        scanning = false
        onMobileLogin()
        onConnected()
      }.mobileAnalyticsScreen(.mobileLogin)
    }
  }
}

/// Extracted from the old connection form. Existing addresses stay in ConnectionRouteEditor.
struct ConnectionEditorView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var store: ConnectionStore
  let connectionID: String?
  var onAdded: () -> Void = {}
  @State private var name = ""
  @State private var url = ""
  @State private var failure: String?

  var body: some View {
    NavigationView {
      Form {
        Section {
          TextField("名称", text: $name).clarityMask().accessibilityIdentifier("connection-name")
          if connectionID == nil {
            TextField("HTTP 或 HTTPS 地址", text: $url).keyboardType(.URL)
              .autocapitalization(.none).disableAutocorrection(true).clarityMask()
              .accessibilityIdentifier("connection-url")
          }
        }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
      }
      .navigationTitle(connectionID == nil ? "手动添加连接" : "编辑连接")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(connectionID == nil ? "添加并切换" : "保存") { save() }
            .disabled(store.storageError != nil || (connectionID == nil && url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
        }
      }
      .onAppear {
        if let connection = store.connections.first(where: { $0.id == connectionID }) { name = connection.name }
      }
    }.navigationViewStyle(.stack)
  }

  private func save() {
    do {
      if let connectionID {
        guard let connection = store.connections.first(where: { $0.id == connectionID }) else {
          failure = "连接已移除，请返回列表。"; return
        }
        try store.save(id: connectionID, name: name, url: connection.url)
        dismiss()
      } else {
        try store.save(id: nil, name: name, url: url)
        onAdded()
      }
    } catch { failure = displayError(error) }
  }
}
