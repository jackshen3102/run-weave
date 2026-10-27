import Clarity
import SwiftUI

private struct BranchCommitFrames: PreferenceKey {
  static var defaultValue: [String: CGRect] = [:]
  static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
    value.merge(nextValue(), uniquingKeysWith: { _, next in next })
  }
}

struct BranchUpdatesView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject var session: AppSession
  @StateObject private var model: BranchUpdatesModel
  @State private var restored = false
  let title: String
  let returnLabel: String

  init(session: AppSession, terminalID: String, cwd: String, title: String, returnLabel: String) {
    self.session = session; self.title = title; self.returnLabel = returnLabel
    _model = StateObject(wrappedValue: BranchUpdatesModel(session: session, terminalID: terminalID, cwd: cwd))
  }
  var body: some View {
    NavigationView {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            header.id("branch-updates-top")
              .background(GeometryReader { geometry in
                Color.clear.preference(key: BranchCommitFrames.self,
                  value: ["header": geometry.frame(in: .named("branch-updates-scroll"))])
              })
            if model.stale {
              Text("暂时无法更新主分支，以下为上次检查结果。")
                .font(.caption).foregroundColor(.orange).accessibilityIdentifier("branch-updates-stale")
            } else if let failure = model.failure {
              Text(failure).font(.caption).foregroundColor(.orange)
            }
            if let snapshot = model.value?.snapshot {
              if model.items.isEmpty {
                VStack(spacing: 12) {
                  Image(systemName: "checkmark.circle").font(.largeTitle).foregroundColor(TerminalAppearance.accent)
                  Text("没有待同步提交").font(.headline)
                  Text("当前分支已包含主分支的全部提交").font(.caption).foregroundColor(.secondary)
                }.frame(maxWidth: .infinity).padding(.vertical, 45)
              } else {
                VStack(alignment: .leading, spacing: 0) {
                  ForEach(model.items) { item in
                    commit(item).id(item.oid)
                      .background(GeometryReader { geometry in
                        Color.clear.preference(key: BranchCommitFrames.self,
                          value: [item.oid: geometry.frame(in: .named("branch-updates-scroll"))])
                      })
                    if item.id != model.items.last?.id { Divider().padding(.leading, 24) }
                  }
                }.padding(.horizontal, 14).background(Color(UIColor.secondarySystemGroupedBackground)).cornerRadius(12)
              }
              Text("\(model.stale ? "上次成功检查" : "检查于") \(formatted(snapshot.checkedAt))")
                .font(.caption2).foregroundColor(.secondary).accessibilityIdentifier("branch-updates-checked-at")
            } else {
              Text(emptyText).font(.subheadline).foregroundColor(.secondary)
                .frame(maxWidth: .infinity).padding(.vertical, 45)
            }
          }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .coordinateSpace(name: "branch-updates-scroll")
        .onPreferenceChange(BranchCommitFrames.self) { frames in
          guard restored else { return }
          if let header = frames["header"], header.maxY > 0 { model.remember(nil); return }
          if let top = frames.filter({ $0.key != "header" && $0.value.maxY > 0 }).min(by: { $0.value.minY < $1.value.minY }) {
            model.remember(top.key)
          }
        }
        .onChange(of: model.revision) { _ in restore(proxy) }
        .onAppear { restore(proxy) }
        .accessibilityIdentifier("branch-updates-scroll")
      }
      .background(Color(UIColor.systemGroupedBackground))
      .navigationTitle("主分支更新").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(returnLabel) { dismiss() }.accessibilityIdentifier("branch-updates-back") }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button { model.refresh(force: true) } label: {
            if model.loading { ProgressView() } else { Image(systemName: "arrow.clockwise") }
          }.disabled(model.loading || !model.canRead).accessibilityLabel("刷新主分支更新")
            .accessibilityIdentifier("branch-updates-refresh")
        }
      }
    }.navigationViewStyle(.stack).tint(TerminalAppearance.accent).clarityMask()
      .mobileAnalyticsScreen(.branchUpdates)
      .onAppear { model.refresh() }
      .onDisappear { model.cancel() }
      .onChange(of: scenePhase) { phase in if phase != .active { model.cancel() } }
      .onChange(of: session.generation) { _ in model.cancel(); dismiss() }
  }
  private var header: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(session.connection?.name ?? "当前电脑", systemImage: "desktopcomputer").font(.caption).foregroundColor(.secondary)
      Label(projectLabel, systemImage: "arrow.triangle.branch").font(.headline)
      Text(title).font(.caption).foregroundColor(.secondary)
      if let snapshot = model.value?.snapshot {
        VStack(alignment: .leading, spacing: 7) {
          Text("\(snapshot.baseRemote)/\(snapshot.baseBranch)").foregroundColor(TerminalAppearance.accent)
          Label(snapshot.currentBranch ?? String(snapshot.headOid.prefix(7)), systemImage: "arrow.down")
        }.font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        Text(model.items.isEmpty ? "没有待同步提交" : "待同步提交 · \(branchUpdatesCountLabel(model.items.count))")
          .font(.subheadline.weight(.medium)).accessibilityIdentifier("branch-updates-count")
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  private var projectLabel: String {
    let terminal = session.overview?.sessions.first { $0.id == model.terminalID }
    let parentID = terminal.map { HomeOverview.parentProjectID($0.projectId) }
    let project = session.overview?.projects.first { $0.id == parentID }
    return "\(project?.name ?? "当前项目") / \((model.cwd as NSString).lastPathComponent)"
  }
  private func commit(_ item: BranchUpdateCommit) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Circle().stroke(TerminalAppearance.accent, lineWidth: 1.5).frame(width: 7, height: 7).padding(.top, 7)
      VStack(alignment: .leading, spacing: 8) {
        Text(item.subject).font(.subheadline).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        HStack(spacing: 8) {
          Text(String(item.oid.prefix(7))).font(.system(.caption2, design: .monospaced))
          Text(item.authorName).lineLimit(1)
          Spacer(minLength: 0)
          Text(formatted(item.committedAt)).font(.caption2)
        }.font(.caption2).foregroundColor(.secondary)
      }
    }.padding(.vertical, 15).accessibilityElement(children: .contain)
      .accessibilityIdentifier("branch-update-\(item.oid)")
  }
  private func restore(_ proxy: ScrollViewProxy) {
    restored = false
    guard model.revision != nil else { return }
    let anchor = model.readingAnchor
    DispatchQueue.main.async {
      if let anchor, model.items.contains(where: { $0.id == anchor }) { proxy.scrollTo(anchor, anchor: .top) }
      else { proxy.scrollTo("branch-updates-top", anchor: .top) }
      DispatchQueue.main.async { restored = true }
    }
  }
  private func formatted(_ value: String) -> String {
    scheduledParseDate(value)?.formatted(date: .abbreviated, time: .shortened) ?? value
  }
  private var emptyText: String {
    if model.loading { return "正在读取主分支更新…" }
    if model.failure != nil { return "点击刷新重试" }
    switch model.value?.state {
    case "not-repository": return "当前目录不是 Git 仓库"
    default:
      switch model.value?.reason {
      case "shallow-repository": return "浅克隆仓库暂时无法比较主分支"
      case "unrelated-history": return "当前提交与主分支没有共同历史"
      default: return "主分支更新暂不可用，请稍后刷新"
      }
    }
  }
}
