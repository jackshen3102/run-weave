import SwiftUI

struct TagLabel: View {
  let name: String
  var compact = false
  private var color: Color {
    let colors: [Color] = [.green, .blue, .purple, .pink, .orange, .teal]
    let index = name.unicodeScalars.reduce(0) { ($0 * 31 + Int($1.value)) % colors.count }
    return colors[index]
  }
  var body: some View {
    Text(verbatim: name).font(.caption).foregroundStyle(SuijiTheme.ink)
      .padding(.horizontal, compact ? 7 : 10).padding(.vertical, compact ? 2 : 7).background(color.opacity(0.16), in: Capsule())
  }
}

struct RecordTags: View {
  let tags: [String]
  var onSelect: ((String) -> Void)? = nil
  var compact = false
  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: compact ? 6 : 8) { labels }
      VStack(alignment: .leading, spacing: compact ? 6 : 8) { labels }
    }
  }
  @ViewBuilder private var labels: some View {
    ForEach(tags, id: \.self) { tag in
      if let onSelect {
        Button { onSelect(tag) } label: { TagLabel(name: tag, compact: compact) }.buttonStyle(.plain).accessibilityLabel("筛选标签：" + tag)
      } else { TagLabel(name: tag, compact: compact) }
    }
  }
}

struct TagPickerSheet: View {
  let available: [String]
  var selected: [String] = []
  var allowsCreate = false
  let onSelect: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var error = ""
  private var name: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  var body: some View {
    NavigationStack {
      List {
        if !error.isEmpty { Text(error).foregroundStyle(.orange) }
        if allowsCreate && !name.isEmpty && !available.contains(name) {
          Button("创建「\(name)」") { choose(name) }
        }
        ForEach(available.filter { name.isEmpty || $0.contains(name) }, id: \.self) { tag in
          Button { choose(tag) } label: {
            HStack { TagLabel(name: tag); Spacer(); if selected.contains(tag) { Image(systemName: "checkmark") } }
          }.disabled(allowsCreate && selected.contains(tag))
        }
      }.searchable(text: $query, prompt: allowsCreate ? "搜索或创建标签" : "搜索已有标签")
        .navigationTitle(allowsCreate ? "添加标签" : "筛选标签").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("关闭") { dismiss() } }
    }
  }
  private func choose(_ tag: String) {
    do {
      if allowsCreate { _ = try SuijiTags.normalize(selected + [tag]) }
      onSelect(tag); dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct TagFilter: View {
  let available: [String]
  @Binding var selected: String
  @State private var choosing = false
  private var recent: [String] {
    let tags = Array(available.prefix(5))
    return selected.isEmpty || tags.contains(selected) ? tags : tags + [selected]
  }
  var body: some View {
    if !recent.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack {
          ForEach(recent, id: \.self) { tag in
            Button { selected = selected == tag ? "" : tag } label: {
              HStack(spacing: 4) { TagLabel(name: tag); if selected == tag { Image(systemName: "xmark.circle.fill") } }
            }.accessibilityAddTraits(selected == tag ? .isSelected : [])
          }
          Button("更多标签") { choosing = true }.font(.subheadline)
        }.padding(.vertical, 4)
      }.sheet(isPresented: $choosing) {
        TagPickerSheet(available: available, selected: selected.isEmpty ? [] : [selected]) { selected = selected == $0 ? "" : $0 }
      }
    }
  }
}
