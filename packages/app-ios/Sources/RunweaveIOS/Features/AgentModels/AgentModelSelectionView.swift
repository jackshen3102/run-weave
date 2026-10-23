import SwiftUI

/// Selection stays local until the second step commits a model/effort pair.
struct AgentModelSelectionView: View {
  let models: [AgentModelOption]
  let currentModelID: String?
  let currentEffort: String?
  @Binding var selectedModelID: String?
  var allowedEfforts: [String]? = nil
  var allowDefaultEffort = false
  var saving = false
  var error: String? = nil
  var identifierPrefix = "model-picker"
  let onClose: () -> Void
  let onSelect: (String, String?) -> Void

  private var selected: AgentModelOption? { models.first { $0.id == selectedModelID } }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Button {
          if selectedModelID != nil { selectedModelID = nil } else { onClose() }
        } label: { Label("返回", systemImage: "chevron.left") }
          .accessibilityIdentifier("\(identifierPrefix)-settings-back")
        Spacer()
        Text(selectedModelID == nil ? "选择模型版本" : "选择推理强度")
          .font(.subheadline.weight(.semibold))
        Spacer()
        Button("关闭", action: onClose)
          .accessibilityIdentifier("\(identifierPrefix)-settings-close")
      }
      .buttonStyle(.plain)
      .foregroundColor(.accentColor)
      .disabled(saving)
      if let error {
        Text(error).font(.caption).foregroundColor(.red)
          .accessibilityIdentifier("\(identifierPrefix)-settings-error")
      }
      if saving {
        HStack(spacing: 8) { ProgressView(); Text("正在确认当前终端设置…") }
          .font(.caption).accessibilityIdentifier("\(identifierPrefix)-settings-saving")
      }
      ScrollView(.vertical) {
        LazyVStack(alignment: .leading, spacing: 2) {
          if selectedModelID == nil {
            if let currentModelID, !currentModelID.isEmpty,
              !models.contains(where: { $0.id == currentModelID }) {
              Text("当前模型 \(currentModelID) 已不在目录中，请重新选择")
                .font(.caption).foregroundColor(.secondary).padding(.vertical, 6)
            }
            ForEach(models) { option in
              Button { selectedModelID = option.id } label: {
                HStack(spacing: 8) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.subheadline.weight(.medium))
                    if !option.description.isEmpty {
                      Text(option.description).font(.caption).foregroundColor(.secondary).lineLimit(2)
                    }
                  }
                  Spacer(minLength: 4)
                  Image(systemName: currentModelID == option.id ? "checkmark" : "chevron.right")
                    .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading).contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("模型 \(option.label)")
              .accessibilityIdentifier("\(identifierPrefix)-model-\(option.id)")
              .disabled(saving)
            }
          } else if let option = selected {
            Text(option.label).font(.caption).foregroundColor(.secondary)
            if allowDefaultEffort { effortRow(option, effort: nil) }
            let efforts = option.reasoningEfforts.filter { allowedEfforts?.contains($0) ?? true }
            ForEach(efforts, id: \.self) { effortRow(option, effort: $0) }
            if efforts.isEmpty && !allowDefaultEffort {
              Text("此模型暂无可选推理强度").font(.caption).foregroundColor(.secondary)
            }
          }
        }
      }
    }
  }

  private func effortRow(_ option: AgentModelOption, effort: String?) -> some View {
    Button { onSelect(option.id, effort) } label: {
      HStack {
        Text(effort.map { "\(AgentModelOption.effortLabel($0)) · \($0)" } ?? "模型默认强度")
        Spacer()
        if currentModelID == option.id, currentEffort == effort {
          Image(systemName: "checkmark").accessibilityHidden(true)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("\(identifierPrefix)-effort-\(effort ?? "default")")
    .disabled(saving)
  }
}
