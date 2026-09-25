import SwiftUI

struct TerminalAgentSettingsView: View {
  @ObservedObject var model: TerminalAgentSettingsModel
  let session: AppSession
  let terminalID: String
  let height: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Button { model.back() } label: {
          Label("返回", systemImage: "chevron.left").labelStyle(.titleAndIcon)
        }
        .accessibilityIdentifier("terminal-agent-settings-back")
        Spacer()
        Text(model.page == .models ? "选择模型" : "选择推理强度")
          .font(.subheadline.weight(.semibold))
        Spacer()
        Button("关闭") { model.exit() }
          .accessibilityIdentifier("terminal-agent-settings-close")
      }
      .buttonStyle(.plain)
      .foregroundColor(TerminalAppearance.accent)
      .disabled(model.saving)
      if let error = model.error {
        Text(error).font(.caption).foregroundColor(.red)
          .accessibilityIdentifier("terminal-agent-settings-error")
      }
      if model.saving {
        HStack(spacing: 8) { ProgressView(); Text("正在确认当前终端设置…") }
          .font(.caption).accessibilityIdentifier("terminal-agent-settings-saving")
      }
      ScrollView(.vertical) {
        LazyVStack(alignment: .leading, spacing: 2) {
          if model.page == .models {
            if let current = model.response?.settings,
              model.response?.models.contains(where: { $0.id == current.model }) != true {
              Text("当前模型 \(current.model) 已不在目录中，请重新选择")
                .font(.caption).foregroundColor(.secondary).padding(.vertical, 6)
            }
            ForEach(model.response?.models ?? []) { option in
              Button { model.selectModel(option.id) } label: {
                HStack(spacing: 8) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.subheadline.weight(.medium))
                    if !option.description.isEmpty {
                      Text(option.description).font(.caption).foregroundColor(.secondary)
                        .lineLimit(2)
                    }
                  }
                  Spacer(minLength: 4)
                  if model.response?.settings.model == option.id {
                    Image(systemName: "checkmark").accessibilityHidden(true)
                  }
                }
                .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("当前终端模型 \(option.label)")
              .accessibilityIdentifier("terminal-agent-model-\(option.id)")
              .disabled(model.saving)
            }
          } else if let option = model.selectedModel {
            Text(option.label).font(.caption).foregroundColor(.secondary)
            ForEach(option.reasoningEfforts, id: \.self) { effort in
              Button {
                Task { await model.save(effort: effort, session: session, terminalID: terminalID) }
              } label: {
                HStack {
                  Text(TerminalAgentSettingsModel.effortLabel(effort))
                  Spacer()
                  if model.response?.settings.model == option.id,
                    model.response?.settings.reasoningEffort == effort {
                    Image(systemName: "checkmark").accessibilityHidden(true)
                  }
                }
                .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("当前终端推理强度 \(TerminalAgentSettingsModel.effortLabel(effort))")
              .accessibilityIdentifier("terminal-agent-effort-\(effort)")
              .disabled(model.saving)
            }
          }
        }
      }
    }
    .frame(height: height)
    .accessibilityIdentifier("terminal-agent-settings-list")
  }
}
