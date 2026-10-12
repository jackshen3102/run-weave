import IOSBuildIdentity
import SwiftUI
import UIKit

struct RuntimeVersionsView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @State private var snapshot: RuntimeVersionSnapshot?
  @State private var snapshotGeneration: Int?
  @State private var failure: String?
  @State private var loading = false
  @State private var reload = 0
  @State private var copied: String?

  private struct LoadKey: Hashable {
    let generation: Int
    let authenticated: Bool
    let foreground: Bool
    let reload: Int
  }
  private var loadKey: LoadKey {
    LoadKey(generation: session.generation, authenticated: session.authenticated,
      foreground: session.foreground, reload: reload)
  }
  private let components = [
    ("backend.process", "Backend"), ("backend.cli-version", "CLI（节点 rw）"),
    ("app-server.process", "App Server"), ("electron.process", "Desktop"),
    ("feishu.bridge-lease", "飞书 Bridge"), ("research-mcp.process", "调查 MCP")
  ]
  private let appFacts: [RuntimeVersionSnapshot.Fact] = {
    let fields = AppBuildMetadata.fields
    var facts = [
      RuntimeVersionSnapshot.Fact(id: "runtime-version.number", label: "版本", value: fields["app_version"] ?? "未上报"),
      .init(id: "runtime-version.build", label: "构建号", value: fields["app_build"] ?? "未上报")
    ]
    if let identity = try? AppBuildIdentity.read().identity {
      facts += [
        .init(id: "runtime-version.build-id", label: "构建标识", value: identity.buildId),
        .init(id: "runtime-version.source", label: "源码提交", value: identity.sourceRevision ?? "未上报"),
        .init(id: "runtime-version.dirty", label: "源码状态", value: identity.sourceState),
        .init(id: "runtime-version.built-at", label: "构建时间", value: identity.builtAt)
      ]
    }
    return facts
  }()

  var body: some View {
    NavigationView {
      Form {
        Section(header: Text("当前手机"), footer: Text("此手机上运行的 App 版本。")) {
          versionRow("iOS App", facts: appFacts)
        }
        Section(header: Text(session.connection.map { "当前电脑 · " + $0.name } ?? "当前电脑"),
          footer: Text("服务上报的运行版本；CLI 为这台电脑可调用的 rw。")) {
          if session.authenticated {
            ForEach(components.filter { $0.0 != "electron.process" || item($0.0) != nil }, id: \.0) { id, label in
              versionRow(label, facts: item(id)?.versionFacts ?? [],
                historical: item(id)?.historical == true || failure != nil,
                missingValue: snapshot == nil ? (loading ? "查询中…" : "无法查询") : "未上报")
            }
          } else {
            Text("登录电脑后可查看服务版本。").foregroundColor(.secondary)
          }
        }
        if session.authenticated {
          Section {
            if let failure {
              Text(failure + (hasReportedVersions ? "；已显示的服务版本为上次记录。" : ""))
                .foregroundColor(.orange)
            }
            if let backend = item("backend.process"), !backend.versionFacts.contains(where: { $0.id == "runtime-version.number" }) {
              Text("当前电脑端尚未上报完整组件版本，请更新电脑端后刷新。")
                .font(.caption).foregroundColor(.secondary)
            }
            if let snapshot {
              Text("更新于 \(Date(timeIntervalSince1970: snapshot.generatedAt / 1000).formatted(date: .abbreviated, time: .standard))")
                .font(.caption).foregroundColor(.secondary)
            }
            Button { reload += 1 } label: {
              if loading { HStack { ProgressView(); Text("正在更新…") } }
              else { Text("刷新") }
            }.disabled(loading || !session.foreground)
          }
        }
      }
      .navigationTitle("组件版本").navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("关闭") { dismiss() } }
    }
    .navigationViewStyle(.stack)
    .task(id: loadKey) { await load(loadKey) }
  }

  private func item(_ id: String) -> RuntimeVersionSnapshot.Item? {
    snapshot?.items.first { $0.id == id }
  }

  private var hasReportedVersions: Bool {
    components.contains { id, _ in item(id)?.versionFacts.contains { $0.id == "runtime-version.number" } == true }
  }

  private func versionRow(_ label: String, facts: [RuntimeVersionSnapshot.Fact], historical: Bool = false,
    missingValue: String = "未上报") -> some View {
    let version = facts.first { $0.id == "runtime-version.number" }
    let build = facts.first { $0.id == "runtime-version.build" }
    let details = facts.filter { $0.id != version?.id && $0.id != build?.id }
    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top) {
        Text(label).fontWeight(.medium)
        Spacer()
        Text(version?.value ?? missingValue).font(.system(.subheadline, design: .monospaced))
          .multilineTextAlignment(.trailing).textSelection(.enabled)
        if !facts.isEmpty {
          Button {
            UIPasteboard.general.string = label + "\n" + facts.map { "\($0.label): \($0.value)" }.joined(separator: "\n")
            copied = label
          } label: { Image(systemName: copied == label ? "checkmark" : "doc.on.doc") }
          .buttonStyle(.borderless)
          .accessibilityLabel(copied == label ? "已复制 \(label) 版本" : "复制 \(label) 版本")
        }
      }
      if let build {
        Text(build.label + "：" + build.value).font(.caption.monospaced())
          .foregroundColor(.secondary).textSelection(.enabled)
      }
      if historical, version != nil {
        Text("最近上报，当前状态无法确认").font(.caption).foregroundColor(.orange)
      }
      if !details.isEmpty {
        DisclosureGroup("构建详情") {
          ForEach(details) { fact in
            VStack(alignment: .leading, spacing: 2) {
              Text(fact.label).foregroundColor(.secondary)
              Text(fact.value).font(.caption.monospaced()).textSelection(.enabled)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 2)
          }
        }.font(.caption)
      }
    }.padding(.vertical, 4)
  }

  @MainActor
  private func load(_ key: LoadKey) async {
    if snapshotGeneration != key.generation || !key.authenticated {
      snapshot = nil; snapshotGeneration = nil; copied = nil
    }
    failure = nil
    guard key.authenticated, key.foreground else { loading = false; return }
    loading = true
    defer { if key == loadKey { loading = false } }
    do {
      let value = try await session.withConnection(reportFailure: false) { try await $0.runtimeVersions() }
      guard !Task.isCancelled, key == loadKey else { return }
      guard value.protocolVersion == 1 else {
        failure = "当前 Backend 不支持此版本协议"; return
      }
      snapshot = value; snapshotGeneration = key.generation; copied = nil
    } catch {
      guard !Task.isCancelled, !isRequestCancellation(error), key == loadKey else { return }
      if case APIError.http(404) = error { failure = "当前 Backend 版本不支持组件版本查询" }
      else { failure = "版本查询失败：" + displayError(error) }
    }
  }
}
