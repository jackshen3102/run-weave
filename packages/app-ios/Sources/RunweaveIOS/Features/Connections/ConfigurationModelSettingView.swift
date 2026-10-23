import SwiftUI

struct ConfigurationModelSettingView: View {
  let field: ConfigurationSnapshot.Field
  let effortField: ConfigurationSnapshot.Field
  let model: String
  let effort: String
  let catalog: AgentModelCatalogs.Catalog?
  let loading: Bool
  let onRetry: () -> Void
  let onChange: (String?, String?) -> Void
  @State private var choosing = false
  @State private var selectedModelID: String?

  private var selection: ConfigurationSnapshot.Field.ModelSelection { field.modelSelection! }
  private var models: [AgentModelOption] { catalog?.availability == "available" ? catalog?.models ?? [] : [] }
  private var effectiveModel: String { model.isEmpty ? field.default?.value?.text ?? "" : model }
  private var effectiveEffort: String { effort.isEmpty ? effortField.default?.value?.text ?? "" : effort }
  private var selected: AgentModelOption? { models.first { $0.id == effectiveModel } }
  private var summary: String {
    let label = selected?.label ?? (effectiveModel.isEmpty ? "未选择模型" : effectiveModel)
    return "\(label) · \(effectiveEffort.isEmpty ? "模型默认强度" : AgentModelOption.effortLabel(effectiveEffort))"
  }
  private var unavailableSelection: Bool {
    !effectiveModel.isEmpty && (selected == nil || !effectiveEffort.isEmpty && selected?.reasoningEfforts.contains(effectiveEffort) != true)
  }

  var body: some View {
    Button {
      selectedModelID = nil
      choosing = true
    } label: {
      HStack {
        Text(summary).multilineTextAlignment(.leading)
        Spacer()
        Image(systemName: "chevron.right").accessibilityHidden(true)
      }
    }
    .disabled(loading || models.isEmpty)
    .accessibilityIdentifier("configuration-model-\(field.path)")
    if loading { ProgressView("正在加载模型…") }
    else if models.isEmpty {
      Text("模型目录暂不可用，已有配置仍会保留。").font(.caption).foregroundColor(.secondary)
      Button("重试加载模型", action: onRetry)
    } else {
      if catalog?.source == "cache" {
        Text("正在使用此电脑缓存的模型目录。").font(.caption).foregroundColor(.secondary)
        Button("刷新模型目录", action: onRetry)
      }
      if unavailableSelection {
        Text("已保存的模型或推理强度不在当前目录中，保留原值；可重新选择。")
          .font(.caption).foregroundColor(.secondary)
      }
    }
    Button("恢复默认") { onChange(nil, nil) }
      .accessibilityIdentifier("configuration-model-reset-\(field.path)")
      .sheet(isPresented: $choosing) {
        VStack(alignment: .leading, spacing: 16) {
          Text(selection.label).font(.headline)
          AgentModelSelectionView(
            models: models, currentModelID: effectiveModel,
            currentEffort: effectiveEffort.isEmpty ? nil : effectiveEffort,
            selectedModelID: $selectedModelID,
            allowedEfforts: selection.allowedEfforts,
            allowDefaultEffort: selection.allowDefaultEffort,
            identifierPrefix: "configuration",
            onClose: { choosing = false },
            onSelect: { model, effort in
              onChange(model, effort)
              choosing = false
            }
          )
        }
        .padding()
      }
  }
}
