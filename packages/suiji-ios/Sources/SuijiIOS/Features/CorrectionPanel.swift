import SwiftUI

struct CorrectionPanel: View {
  @ObservedObject var model: EditorModel
  let selectedText: String?
  @State private var showOriginal = false
  @State private var managing = false
  @State private var canonical = ""
  @State private var variant = ""
  @State private var formVisible = false
  @State private var undoEntries: [CorrectionEntry]?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Button(model.correctionBusy ? "正在纠正…" : "纠正文字") { Task { await model.correct() } }
          .disabled(!model.correctionAvailable || !model.editable || model.correctionBusy || model.draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button("纠错词库") { managing.toggle() }
      }
      Text("点击后，本次文字和专有词库会经 Codex CLI 发送给模型提供方。").font(.caption).foregroundStyle(.secondary)
      if !model.correctionAvailable { Text("此服务尚未启用文字纠错；词库仍可管理。").font(.caption).foregroundStyle(.secondary) }
      if let selectedText {
        Button("记住选词") { canonical = selectedText; variant = ""; formVisible = true }
      }
      if !model.correctionMessage.isEmpty { Text(model.correctionMessage).font(.footnote).accessibilityIdentifier("correction-status") }
      if model.lexiconPending { Button("手动重试确认词库写入") { Task {
        let before = model.lexicon?.entries ?? []
        do { try await model.putLexicon(before); undoEntries = before; formVisible = false } catch {}
      } } }
      if let correction = model.correction, correction.status == "completed", let corrected = correction.correctedText {
        VStack(alignment: .leading, spacing: 10) {
          DisclosureGroup("查看原文", isExpanded: $showOriginal) {
            Text(verbatim: model.correctionSource ?? "").textSelection(.enabled)
          }
          Text(previewText(corrected, terms: correction.suggestedTerms ?? []))
            .environment(\.openURL, OpenURLAction { url in
              guard url.scheme == "suiji-term", let index = Int(url.host ?? ""),
                let term = correction.suggestedTerms?[safe: index] else { return .discarded }
              canonical = term.canonical; variant = term.variant; formVisible = true
              return .handled
            })
          if let uncertain = correction.uncertainTerms, !uncertain.isEmpty {
            Text("仍不确定：" + uncertain.joined(separator: "、") + "。请核对原文。")
          }
          HStack {
            Button("应用到草稿") { Task { await model.applyCorrection() } }
              .disabled(!model.editable || model.draft.body != model.correctionSource)
            Button("取消") { Task { await model.cancelCorrection() } }
          }
        }.padding(12).background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      }
      if formVisible {
        VStack(alignment: .leading, spacing: 8) {
          Text("记住这个写法").font(.headline)
          TextField("正确写法", text: $canonical).textInputAutocapitalization(.never)
          TextField("误识别写法（可留空）", text: $variant).textInputAutocapitalization(.never)
          HStack {
            Button("加入词库") { Task { await remember() } }.disabled(model.lexiconPending || model.lexicon == nil)
            Button("取消") { formVisible = false }
          }
        }.padding(12).background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      }
      if let undoEntries {
        Button("撤销本次添加") { Task { do { try await model.putLexicon(undoEntries); self.undoEntries = nil } catch {} } }
      }
      if managing {
        VStack(alignment: .leading, spacing: 8) {
          HStack { Text("纠错词库").font(.headline); Spacer(); Button("刷新") { Task { await model.loadLexicon() } } }
          ForEach(model.lexicon?.entries ?? []) { entry in
            HStack {
              Text(entry.canonical + (entry.variants.isEmpty ? "" : " ← " + entry.variants.joined(separator: "、")))
              Spacer()
              Button("移除") { Task { try? await model.putLexicon((model.lexicon?.entries ?? []).filter { $0.canonical != entry.canonical }) } }
            }
          }
          Button("新增词条") { canonical = ""; variant = ""; formVisible = true }
        }
      }
    }
    .task { await model.loadLexicon() }
  }
  private func remember() async {
    guard let entries = model.lexicon?.entries else { return }
    let name = canonical.trimmingCharacters(in: .whitespacesAndNewlines)
    let alias = variant.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return }
    var next = entries
    if let index = next.firstIndex(where: { $0.canonical == name }) {
      if alias.isEmpty || next[index].variants.contains(alias) { model.correctionMessage = "这个写法已在词库中"; formVisible = false; return }
      next[index].variants.append(alias)
    } else { next.append(CorrectionEntry(canonical: name, variants: alias.isEmpty ? [] : [alias])) }
    do { try await model.putLexicon(next); undoEntries = entries; formVisible = false } catch {}
  }
  private func previewText(_ text: String, terms: [CorrectionTerm]) -> AttributedString {
    var value = AttributedString(text)
    for (index, term) in terms.enumerated() {
      if let range = value.range(of: term.canonical) {
        value[range].link = URL(string: "suiji-term://\(index)")
        value[range].underlineStyle = .single
      }
    }
    return value
  }
}
private extension Collection {
  subscript(safe index: Index) -> Element? { indices.contains(index) ? self[index] : nil }
}
