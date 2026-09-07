import SwiftUI
enum SuijiTheme {
  static let green = Color(red: 8/255, green: 123/255, blue: 96/255)
  static let pale = Color(red: 230/255, green: 243/255, blue: 238/255)
  static let background = Color(red: 243/255, green: 246/255, blue: 245/255)
  static let ink = Color(red: 32/255, green: 43/255, blue: 41/255)
}
extension TaskStatus {
  var label: String { switch self { case .open: return "未完成"; case .done: return "已完成"; case .archived: return "不再做" } }
  var symbol: String { switch self { case .open: return "circle"; case .done: return "checkmark.circle.fill"; case .archived: return "archivebox" } }
}
struct TaskStatusBadge: View {
  let status: TaskStatus
  var body: some View { Label(status.label, systemImage: status.symbol).font(.caption).padding(6).background(SuijiTheme.pale, in: Capsule()) }
}
struct RecordCard: View {
  let record: SuijiRecord
  let pending: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(record.kind == .note ? "想法" : "待办").font(.caption).foregroundStyle(.secondary)
        Spacer(); if let status = record.taskStatus { TaskStatusBadge(status: status) }
      }
      if !record.body.isEmpty { Text(verbatim: record.body).font(.body).foregroundStyle(SuijiTheme.ink).lineLimit(8).frame(maxWidth: .infinity, alignment: .leading) }
      ForEach(record.attachments) { attachment in
        Label(attachment.fileName, systemImage: attachment.kind == "image" ? "photo" : "doc.text").font(.subheadline).foregroundStyle(SuijiTheme.green)
      }
      if pending { Label("状态结果待确认", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange) }
      Text(displayDate(record.createdAt)).font(.caption).foregroundStyle(.secondary)
    }.padding(16).background(.white, in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.gray.opacity(0.12)))
  }
}
func displayDate(_ value: String) -> String {
  let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let date = formatter.date(from: value) else { return value }
  return date.formatted(date: .abbreviated, time: .shortened)
}
struct FilterBar: View {
  let values: [(String, String)]
  @Binding var selected: String
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack { ForEach(values, id: \.0) { value in
        Button { selected = value.0 } label: {
          Text(value.1).font(.subheadline).padding(.horizontal, 18).padding(.vertical, 12)
            .background(selected == value.0 ? SuijiTheme.pale : Color.clear, in: Capsule())
        }.accessibilityAddTraits(selected == value.0 ? .isSelected : [])
      } }
    }
  }
}
struct CaptureButton: View {
  let action: () -> Void
  var body: some View {
    Button(action: action) { Image(systemName: "plus").font(.title2.bold()).frame(width: 54, height: 54).background(SuijiTheme.green, in: Circle()).foregroundStyle(.white) }
      .accessibilityLabel("新增记录").shadow(color: SuijiTheme.green.opacity(0.2), radius: 8, y: 4)
  }
}
struct EmptyState: View {
  let title: String
  let detail: String
  var body: some View { ContentUnavailableView(title, systemImage: "square.and.pencil", description: Text(detail)) }
}
