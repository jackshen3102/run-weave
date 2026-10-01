import Clarity
import SwiftUI

struct TerminalQuickCommandsView: View {
  private enum Sheet: Identifiable {
    case editor(BackendQuickInput?), preview(BackendQuickInput), runs, run(ScheduledRun), sorting
    var id: String {
      switch self {
      case .editor(let item): return "editor:\(item?.id ?? "new")"
      case .preview(let item): return "preview:\(item.id)"
      case .runs: return "runs"
      case .run(let run): return "run:\(run.id)"
      case .sorting: return "sorting"
      }
    }
  }

  @EnvironmentObject private var model: BackendQuickInputModel
  @Environment(\.dynamicTypeSize) private var typeSize
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  let projectId: String
  let projectLabel: String
  let active: Bool
  let send: (BackendQuickInput) async throws -> Void
  let insert: (BackendQuickInput) -> Void
  let onOpenTerminal: () -> Void
  @State private var sheet: Sheet?
  @State private var deleting: BackendQuickInput?
  @State private var sending: String?
  @State private var failure: String?
  @State private var notice: String?

  private var polling: Bool {
    active && session.foreground && session.authenticated && session.health.status == .online
  }
  private var currentTerminal: Bool {
    session.terminalController === controller && session.terminal?.projectId == projectId
  }
  private var canSend: Bool { active && currentTerminal && model.canEdit(session) && controller.canSend && sending == nil }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        dashboard
        Rectangle().fill(TerminalAppearance.border).frame(height: 0.5).padding(.vertical, 20)
        HStack {
          Text("快捷指令").font(.subheadline.weight(.semibold))
          Spacer()
          Button { sheet = .editor(nil) } label: { Image(systemName: "plus") }
            .frame(width: 36, height: 44).accessibilityLabel("新增指令")
            .accessibilityIdentifier("quick-command-add").disabled(!model.canEdit(session))
          Menu {
            Button("管理排序") { sheet = .sorting }
          } label: { Image(systemName: "ellipsis").frame(width: 32, height: 44) }
          .accessibilityLabel("指令管理").disabled(!model.canEdit(session))
        }.foregroundColor(TerminalAppearance.accent)
        Label("当前执行位置：\(projectLabel)", systemImage: "folder")
          .font(.caption2).foregroundColor(.secondary).lineLimit(1).padding(.bottom, 12)
          .accessibilityIdentifier("quick-command-context")
        if model.loading { ProgressView("正在读取…").padding(.bottom, 10) }
        if let error = failure ?? model.failure {
          Text(error).font(.caption).foregroundColor(.red).padding(.bottom, 10)
          if model.failure != nil {
            Button("重试读取") { Task { await model.refresh(session) } }.padding(.bottom, 10)
          }
        }
        if let notice { Text(notice).font(.caption).foregroundColor(TerminalAppearance.accent).padding(.bottom, 8) }
        if model.items.isEmpty && !model.loading && model.failure == nil {
          Text("还没有快捷指令").font(.subheadline).foregroundColor(.secondary).padding(.vertical, 12)
        }
        LazyVStack(spacing: 8) { ForEach(model.items) { commandRow($0) } }
      }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
    }
    .buttonStyle(.plain)
    .background(TerminalAppearance.background)
    .sheet(item: $sheet) { target in
      NavigationView {
        switch target {
        case .editor(let item): QuickReplyEditorView(session: session, item: item).mobileAnalyticsScreen(.quickReplyEditor)
        case .preview(let item): preview(item)
        case .runs: QuickCommandRunsView(session: session, model: model, onOpenTerminal: openedTerminal)
        case .run(let run): QuickCommandRunDetail(session: session, model: model, initial: run, onOpenTerminal: openedTerminal)
        case .sorting:
          QuickReplyLibraryView(session: session, initiallySorting: true)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { sheet = nil }.disabled(model.saving) } }
        }
      }
      .navigationViewStyle(.stack).tint(TerminalAppearance.accent)
      .environmentObject(model)
      .interactiveDismissDisabled(model.saving)
    }
    .confirmationDialog("删除快捷指令？", isPresented: Binding(
      get: { deleting != nil }, set: { if !$0 { deleting = nil } }
    ), titleVisibility: .visible) {
      if let item = deleting {
        Button("删除", role: .destructive) {
          deleting = nil
          let epoch = session.generation
          Task {
            do { try await model.delete(session, id: item.id) }
            catch { if epoch == session.generation, !(error is CancellationError) { failure = displayError(error) } }
          }
        }
      }
      Button("取消", role: .cancel) { deleting = nil }
    } message: { Text("已创建的后台任务及运行记录会保留。") }
    .task(id: "\(polling):\(session.generation)") {
      guard polling else { return }
      await model.refresh(session)
      while !Task.isCancelled {
        await model.refreshRuns(session)
        do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
      }
    }
    .onChange(of: session.generation) { _ in sheet = nil; deleting = nil; failure = nil; notice = nil }
    .clarityMask()
  }

  private func openedTerminal() {
    sheet = nil
    onOpenTerminal()
  }

  private var dashboard: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        (Text("后台任务").fontWeight(.semibold) + Text(" · \(model.dashboardRuns.count)").foregroundColor(.secondary))
          .font(.subheadline)
        Spacer()
        Button { sheet = .runs } label: {
          HStack(spacing: 3) {
            Text(model.dashboardRuns.count > 3 ? "查看全部 \(model.dashboardRuns.count) 个" : "全部")
            Image(systemName: "chevron.right").font(.caption2)
          }.font(.caption).foregroundColor(TerminalAppearance.accent).frame(minHeight: 36)
        }.accessibilityIdentifier("quick-command-all-runs")
      }
      if let error = model.runFailure {
        Text(error).font(.caption).foregroundColor(.red)
        Button("重试读取任务") { Task { await model.refreshRuns(session) } }.font(.caption)
      } else if model.dashboardRuns.isEmpty {
        Text("暂无后台任务").font(.caption).foregroundColor(.secondary).padding(.vertical, 10)
      }
      let attentionCount = model.dashboardRuns.filter(\.needsAttention).count
      if attentionCount > 0 {
        Label("\(attentionCount) 项需处理", systemImage: "exclamationmark.triangle.fill")
          .font(.caption).foregroundColor(.orange)
      }
      if !model.dashboardRuns.isEmpty {
        VStack(spacing: 0) {
          ForEach(Array(model.dashboardRuns.prefix(3).enumerated()), id: \.element.id) { index, run in
            if index > 0 { Divider() }
            Button { sheet = .run(run) } label: { QuickCommandRunRow(run: run) }
              .accessibilityIdentifier("quick-command-run-\(run.id)")
              .modifier(QuickCommandArchiveMenu(session: session, model: model, run: run))
          }
        }.padding(.horizontal, 12).background(TerminalAppearance.panel).cornerRadius(14)
      }
    }
  }

  private func commandRow(_ item: BackendQuickInput) -> some View {
    let run = model.run(for: item.id, projectId: projectId)
    return HStack(spacing: 6) {
      Button { sheet = .preview(item) } label: {
        VStack(alignment: .leading, spacing: 3) {
          Text(item.title).font(.system(size: 14, weight: .semibold)).foregroundColor(.primary).lineLimit(1)
          Text(item.data.replacingOccurrences(of: "\n", with: " "))
            .font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
      }.layoutPriority(1).accessibilityLabel("查看全文 \(item.title)")
      VStack(spacing: 0) {
        if typeSize.isAccessibilitySize {
          executionButtons(item, run: run)
        } else {
          HStack(spacing: 5) { executionButtons(item, run: run) }
        }
      }
      Menu {
        Button("插入输入框") { insert(item) }
          .disabled(!session.canWrite || sending != nil)
        Button("编辑指令") { sheet = .editor(item) }.disabled(!model.canEdit(session))
        Button("删除指令", role: .destructive) { deleting = item }.disabled(!model.canEdit(session))
      } label: {
        Image(systemName: "ellipsis").font(.caption).foregroundColor(.secondary)
          .frame(width: 24, height: 44).contentShape(Rectangle())
      }.accessibilityLabel("管理 \(item.title)")
    }
    .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 8)
    .background(TerminalAppearance.panel).cornerRadius(12)
    .accessibilityIdentifier("quick-command-card-\(item.id)")
  }

  @ViewBuilder private func executionButtons(_ item: BackendQuickInput, run: ScheduledRun?) -> some View {
    Button { sendCommand(item) } label: {
      compactLabel(sending == item.id ? "发送中" : "发送", symbol: "arrow.up", primary: true)
    }.disabled(!canSend).accessibilityLabel("发送到终端 \(item.title)")
      .accessibilityIdentifier("quick-command-send-\(item.id)")
    if let run, run.active {
      Button { sheet = .run(run) } label: { compactLabel("查看", symbol: "clock", primary: false) }
        .accessibilityLabel("查看运行 \(item.title)")
    } else {
      Button { start(item) } label: {
        compactLabel(model.starting.contains(item.id) ? "提交中" : "后台", symbol: "play", primary: false)
      }.disabled(!currentTerminal || !model.canEdit(session) || model.starting.contains(item.id))
        .accessibilityLabel("后台运行 \(item.title)").accessibilityIdentifier("quick-command-background-\(item.id)")
    }
  }

  private func compactLabel(_ text: String, symbol: String, primary: Bool) -> some View {
    HStack(spacing: 4) {
      Image(systemName: symbol).font(.system(size: 11))
      Text(text).font(.system(size: 12, weight: .medium))
    }
    .frame(minWidth: 48, minHeight: 30).padding(.horizontal, 6)
    .foregroundColor(primary ? TerminalAppearance.background : TerminalAppearance.accent)
    .background(primary ? TerminalAppearance.accent : TerminalAppearance.accent.opacity(0.03))
    .cornerRadius(7)
    .overlay(RoundedRectangle(cornerRadius: 7).stroke(primary ? Color.clear : TerminalAppearance.accent.opacity(0.25)))
    .frame(minHeight: 44).contentShape(Rectangle())
  }

  private func sendCommand(_ item: BackendQuickInput) {
    guard canSend else { return }
    sending = item.id; failure = nil; notice = nil
    let epoch = session.generation
    Task {
      defer { sending = nil }
      do { try await send(item); await model.markUsed(session, id: item.id) }
      catch {
        if !(error is CancellationError), session.generation == epoch {
          failure = "发送未确认，请核对终端结果；不会自动重发。\n" + displayError(error)
        }
      }
    }
  }

  private func start(_ item: BackendQuickInput) {
    guard active, currentTerminal else { return }
    failure = nil; notice = nil
    let epoch = session.generation
    Task {
      do {
        guard epoch == session.generation, currentTerminal else { throw CancellationError() }
        _ = try await model.start(session, item: item, projectId: projectId)
        guard epoch == session.generation else { return }
        notice = "已提交后台运行"
      } catch {
        if !(error is CancellationError), epoch == session.generation { failure = displayError(error) }
      }
    }
  }

  private func preview(_ item: BackendQuickInput) -> some View {
    ScrollView {
      Text(item.data).font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(20)
    }
    .navigationTitle(item.title).navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { sheet = nil } } }
    .clarityMask()
  }
}
