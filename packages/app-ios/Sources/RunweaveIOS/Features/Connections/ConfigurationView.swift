import SwiftUI

struct ConfigurationView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @State private var snapshot: ConfigurationSnapshot?
  @State private var draft: [String: String] = [:]
  @State private var removed = Set<String>()
  @State private var replacing = Set<String>()
  @State private var failure: String?
  @State private var busy = false
  @State private var work: Task<Void, Never>?

  var body: some View {
    NavigationView {
      Form {
        Section(header: Text("当前连接电脑")) {
          Text(session.connection?.name ?? "当前连接")
          Text(session.connection?.url ?? "").font(.caption)
          Button("重新加载") { load() }.disabled(busy)
        }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
        if let snapshot {
          Section {
            Text("\(snapshot.environment.kind == "stable" ? "Stable" : "Dev Session") · \(snapshot.environment.instanceId)")
            Text("保存版本：\(snapshot.savedRevision.map(String.init) ?? "不可读取")").font(.caption)
            if snapshot.diskError != nil { Text("磁盘配置无法读取，请在当前电脑运行 rw config doctor。") }
          }
          ForEach(snapshot.fields.filter { !$0.path.contains("<") }) { field in
            Section(header: Text(field.description)) {
              if let consumer = snapshot.consumers[field.domain] {
                Text(consumer.label + (consumer.appliedRevision.map { " · 生效版本 \($0)" } ?? ""))
                  .font(.caption).foregroundColor(.secondary)
              }
              if field.sensitive {
                Picker("凭据操作", selection: Binding(get: {
                  removed.contains(field.path) ? "delete" : replacing.contains(field.path) ? "replace" : "keep"
                }, set: { action in
                  removed.remove(field.path); replacing.remove(field.path); draft.removeValue(forKey: field.path)
                  if action == "delete" { removed.insert(field.path) }
                  if action == "replace" { replacing.insert(field.path) }
                })) {
                  Text(snapshot.values[field.path + ".configured"]?.text == "true" ? "保留现有值" : "保持未配置").tag("keep")
                  Text("替换").tag("replace")
                  Text("删除").tag("delete")
                }
                if replacing.contains(field.path) { SecureField("新凭据", text: binding(field.path)).autocapitalization(.none) }
              } else {
                TextField(field.type.hasPrefix("array") ? "JSON 数组" : field.type == "boolean" ? "true 或 false" : "留空恢复默认值", text: binding(field.path))
                  .autocapitalization(.none).disableAutocorrection(true)
              }
            }.disabled(busy)
          }
          Section {
            Button("保存配置") { save(snapshot) }
              .disabled(busy || snapshot.savedRevision == nil || draft.isEmpty && removed.isEmpty && replacing.isEmpty)
          }
        }
      }
      .navigationTitle("电脑配置")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("关闭") { dismiss() } }
    }
    .navigationViewStyle(.stack)
    .onAppear { load() }
    .onDisappear { work?.cancel(); draft = [:]; replacing = []; removed = [] }
    .onChange(of: session.generation) { _ in work?.cancel(); dismiss() }
    .onChange(of: session.authenticated) { if !$0 { work?.cancel(); dismiss() } }
    .onChange(of: session.foreground) { if !$0 { work?.cancel(); busy = false } }
  }

  private func binding(_ key: String) -> Binding<String> {
    Binding(get: { draft[key] ?? (replacing.contains(key) ? "" : snapshot?.values[key]?.text ?? "") }, set: { draft[key] = $0 })
  }
  private func load() {
    guard let api = session.api, session.authenticated else { return }
    work?.cancel(); busy = true; failure = nil
    let generation = session.generation
    work = Task { @MainActor in
      defer { if generation == session.generation, !Task.isCancelled { busy = false } }
      do {
        let value = try await api.configuration()
        guard generation == session.generation, !Task.isCancelled else { return }
        snapshot = value; draft = [:]; removed = []; replacing = []
      } catch { if !Task.isCancelled { failure = displayError(error) } }
    }
  }
  private func save(_ current: ConfigurationSnapshot) {
    guard let api = session.api, session.authenticated else { return }
    var changes: [String: Any] = [:]
    do {
      for field in current.fields where draft[field.path] != nil || replacing.contains(field.path) || removed.contains(field.path) {
        let text = draft[field.path] ?? ""
        if removed.contains(field.path) || !field.sensitive && text.isEmpty { changes[field.path] = NSNull() }
        else if field.sensitive && text.isEmpty { failure = "替换凭据时请填写新值。"; return }
        else if field.type == "string" { changes[field.path] = text }
        else { changes[field.path] = try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) }
      }
    } catch { failure = "请检查布尔值、数字或数组的格式。"; return }
    work?.cancel(); busy = true; failure = nil
    let generation = session.generation
    work = Task { @MainActor in
      defer { if generation == session.generation, !Task.isCancelled { busy = false } }
      do {
        let value = try await api.saveConfiguration(current, changes: changes)
        guard generation == session.generation, !Task.isCancelled else { return }
        snapshot = value; draft = [:]; removed = []; replacing = []
      } catch APIError.http(409) { failure = "配置已被其他操作修改，请重新加载后再保存。" }
      catch { if !Task.isCancelled { failure = displayError(error) } }
    }
  }
}
