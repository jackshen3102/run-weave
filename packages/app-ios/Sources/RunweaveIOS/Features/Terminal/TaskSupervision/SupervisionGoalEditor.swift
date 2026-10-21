import Clarity
import SwiftUI

struct SupervisionGoalEditor: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var model: TaskSupervisionModel
  let regenerate: Bool
  @State private var base: TaskWatch
  @State private var draft: SupervisionGoalContent
  @State private var preview: SupervisionGoalPreview?
  @State private var busy = false
  @State private var applying = false
  @State private var failure: String?
  @State private var operation: Task<Void, Never>?
  @State private var requestID = UUID()

  init(model: TaskSupervisionModel, watch: TaskWatch, regenerate: Bool) {
    self.model = model; self.regenerate = regenerate
    _base = State(initialValue: watch); _draft = State(initialValue: watch.goalContent)
  }

  private var available: Bool {
    model.canRead && model.watch?.watchId == base.watchId && model.watch?.target == base.target
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if !available { Text("连接或会话已变化，恢复原会话后再核对目标。").font(.caption).foregroundColor(.orange) }
        if regenerate && preview == nil {
          regenerationStatus
        } else {
          if let failure { failureCard(failure) }
          if busy { ProgressView(applying ? "正在采用目标…" : "正在核对目标变更…") }
        }
        if let preview {
          review(preview)
        } else if !regenerate {
          editorField("任务目标", text: $draft.objective, limit: 1500, id: "objective")
          editorField("完成条件", text: $draft.completionCriteria, limit: 2000, id: "criteria")
          editorField("范围与约束", text: $draft.constraints, limit: 2000, id: "constraints")
          Text("后续“继续”和进度询问会沿用修订后的目标。").font(.caption).foregroundColor(.secondary)
          Button(failure == nil ? "查看变更" : "基于最新状态核对") { generate() }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(busy || !available || !draft.valid).accessibilityIdentifier("task-supervision-goal-preview")
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(TerminalAppearance.background.ignoresSafeArea())
      .safeAreaInset(edge: .bottom, spacing: 0) {
        Button(preview == nil ? "取消" : "保留当前目标") { dismiss() }
          .frame(maxWidth: .infinity, minHeight: 44).disabled(applying)
          .accessibilityIdentifier("task-supervision-goal-cancel")
          .padding(.horizontal, 20).padding(.vertical, 8)
          .background(TerminalAppearance.background)
      }
      .navigationTitle(preview != nil ? "核对目标变更" : regenerate ? "重新生成目标" : "编辑目标")
      .navigationBarTitleDisplayMode(.inline).navigationBarBackButtonHidden(applying)
      .interactiveDismissDisabled(applying).clarityMask()
      .onAppear { if regenerate && preview == nil && failure == nil && !busy { generate() } }
      .onDisappear { requestID = UUID(); operation?.cancel(); operation = nil }
  }

  private var regenerationStatus: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack(alignment: .top, spacing: 14) {
        Image(systemName: failure == nil ? "arrow.triangle.2.circlepath" : "exclamationmark.arrow.triangle.2.circlepath")
          .font(.title2).foregroundColor(TerminalAppearance.accent)
          .frame(width: 48, height: 48)
          .background(TerminalAppearance.accent.opacity(0.10)).cornerRadius(14)
        VStack(alignment: .leading, spacing: 6) {
          Text(failure == nil ? "从最近对话整理目标" : "暂时没能生成目标").font(.headline)
          Text("根据最近几轮对话，整理任务目标、完成条件和范围。核对并采用后才会生效。")
            .font(.subheadline).foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if let failure { failureCard(failure) }
      if busy {
        HStack(spacing: 12) {
          ProgressView()
          Text("正在整理最近的对话…").font(.subheadline).foregroundColor(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
          .background(TerminalAppearance.panel).cornerRadius(14)
      } else {
        Button { generate() } label: {
          Text(failure == nil ? "重新生成" : "重试").frame(maxWidth: .infinity, minHeight: 30)
        }.buttonStyle(.borderedProminent).controlSize(.large)
          .foregroundColor(TerminalAppearance.background).disabled(!available)
          .accessibilityIdentifier("task-supervision-goal-regenerate-retry")
      }
      Text("当前目标会保留，生成失败也不会修改它。")
        .font(.caption).foregroundColor(.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private func failureCard(_ message: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("本次操作未完成", systemImage: "exclamationmark.circle").font(.subheadline.weight(.medium))
      Text(message).font(.subheadline).textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }.foregroundColor(.orange).frame(maxWidth: .infinity, alignment: .leading)
      .padding(16).background(Color.orange.opacity(0.08)).cornerRadius(14)
  }

  private func editorField(_ title: String, text: Binding<String>, limit: Int, id: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(title).font(.caption)
        Spacer()
        Text("\(text.wrappedValue.utf16.count)/\(limit)").font(.caption2)
          .foregroundColor(text.wrappedValue.utf16.count > limit ? .orange : .secondary)
      }
      TextEditor(text: text).frame(minHeight: 100).padding(6)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(TerminalAppearance.border))
        .disabled(busy || !available).accessibilityLabel(title)
        .accessibilityIdentifier("task-supervision-goal-\(id)")
    }
  }

  private func review(_ preview: SupervisionGoalPreview) -> some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("核对任务范围 · 尚未生效").font(.caption).foregroundColor(.secondary)
      Text(preview.changed ? "v\(base.goalDefinition?.version ?? 0) → v\(preview.goal.version)" : "目标内容无变化")
        .font(.subheadline).accessibilityIdentifier("task-supervision-goal-version-change")
      Text(preview.reason).font(.caption).foregroundColor(preview.needsClarification ? .orange : .secondary)
      difference("任务目标", before: base.goalContent.objective, after: preview.goal.objective)
      difference("完成条件", before: base.goalContent.completionCriteria, after: preview.goal.completionCriteria)
      difference("范围与约束", before: base.goalContent.constraints, after: preview.goal.constraints)
      DisclosureGroup("本次整理依据") { SupervisionGoalSources(detail: preview.detail).padding(.top, 10) }
      Text("采用后按新目标重新判断，历史记录保留当时的目标；不会开启已关闭的监控或重置续接额度。")
        .font(.caption).foregroundColor(.secondary)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let stale = preview.expiration <= context.date || model.watch?.revision != preview.expectedRevision
          || model.watch?.target != preview.target
        VStack(alignment: .leading, spacing: 12) {
          if stale {
            Text("任务状态或预览已变化，当前预览不能采用。请基于最新状态重新核对。")
              .font(.caption).foregroundColor(.orange).accessibilityIdentifier("task-supervision-goal-stale")
            Button("重新核对") { generate() }.disabled(busy || !available)
          } else {
            Button("采用并重新判断") { apply(preview) }
              .buttonStyle(.borderedProminent).controlSize(.large)
              .disabled(busy || model.writing || !available || !preview.requiresAdoption || preview.needsClarification)
              .accessibilityIdentifier("task-supervision-goal-apply")
          }
        }
      }
      if !regenerate { Button("返回编辑") { self.preview = nil; failure = nil }.disabled(busy) }
    }
  }

  @ViewBuilder private func difference(_ title: String, before: String, after: String) -> some View {
    if before != after {
      VStack(alignment: .leading, spacing: 10) {
        Text(title).font(.headline)
        goalText("当前", before).padding(12).background(Color.secondary.opacity(0.06)).cornerRadius(8)
        goalText("更新后", after).padding(12).background(TerminalAppearance.accent.opacity(0.08)).cornerRadius(8)
      }
    }
  }

  private func generate() {
    guard available, !busy, let current = model.watch, regenerate || draft.valid else { return }
    operation?.cancel()
    let id = UUID(); requestID = id
    base = current; preview = nil; failure = nil; busy = true
    operation = Task {
      defer { if requestID == id { busy = false; operation = nil } }
      do {
        let value = try await model.previewGoal(base: current, content: regenerate ? nil : draft)
        guard !Task.isCancelled, requestID == id else { return }
        preview = value
      } catch {
        guard !Task.isCancelled, requestID == id else { return }
        failure = goalFailure(error)
        await model.refresh()
      }
    }
  }

  private func apply(_ value: SupervisionGoalPreview) {
    guard !busy, available else { return }
    let id = UUID(); requestID = id
    busy = true; applying = true; failure = nil
    operation = Task {
      defer { if requestID == id { busy = false; applying = false; operation = nil } }
      do {
        try await model.applyGoal(watchID: base.watchId, preview: value)
        guard !Task.isCancelled, requestID == id else { return }
        dismiss()
      } catch {
        guard !Task.isCancelled, requestID == id else { return }
        failure = "采用结果未确认，请核对最新目标；不要重复创建修订。\n" + goalFailure(error)
        await model.refresh()
      }
    }
  }
}
