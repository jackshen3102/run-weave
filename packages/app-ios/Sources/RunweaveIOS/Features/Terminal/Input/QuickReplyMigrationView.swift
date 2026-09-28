import SwiftUI
import UIKit

struct QuickReplyMigrationView: View {
  @EnvironmentObject private var legacy: LocalQuickReplyStore
  @EnvironmentObject private var migration: QuickReplyMigrationStore
  @EnvironmentObject private var quickInputs: BackendQuickInputModel
  @ObservedObject var session: AppSession
  @State private var confirming = false
  @State private var share: SharedReply?

  private var remaining: [LocalQuickReply] {
    migration.remaining(legacy.items, scope: session.connection?.scope)
  }

  var body: some View {
    NavigationView {
      List {
        Section {
          Text("目标电脑：\(session.connection?.name ?? "未连接")")
          Text(session.connection?.url ?? "请先选择电脑")
            .font(.caption).foregroundColor(.secondary).textSelection(.enabled)
          Text("将此手机的 \(remaining.count) 条旧快捷回复上传到这台电脑。导入后该电脑可以读取；原手机文件不会删除。")
          if let error = legacy.readError ?? migration.failure { Text(error).foregroundColor(.red) }
          Button(migration.importing ? "正在导入…" : "导入到当前电脑") { confirming = true }
            .disabled(migration.importing || migration.loading || remaining.isEmpty
              || legacy.readError != nil || migration.failure != nil || !session.canWrite)
        }
        Section("旧手机记录（只读）") {
          ForEach(remaining) { item in
            VStack(alignment: .leading, spacing: 8) {
              Text(item.title).font(.headline)
              Text(item.body).font(.subheadline).textSelection(.enabled)
              if let error = migration.itemFailures[item.id] {
                Text(error).font(.caption).foregroundColor(.red)
              }
              HStack {
                Button("复制全文") { UIPasteboard.general.string = item.body }
                Button("分享全文") { share = SharedReply(text: item.body) }
              }.buttonStyle(.borderless)
            }
          }
          if remaining.isEmpty { Text("此电脑的旧记录已全部导入。原文件仍保留在手机。") }
        }
      }
      .navigationTitle("导入旧快捷回复")
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog("导入到 \(session.connection?.name ?? "当前电脑")？", isPresented: $confirming) {
        Button("确认上传 \(remaining.count) 条") {
          Task {
            await migration.importReplies(legacy, session: session)
            await quickInputs.refresh(session)
          }
        }
        Button("取消", role: .cancel) {}
      } message: { Text("旧记录原本只保存在手机；上传后这台电脑可以读取。") }
      .sheet(item: $share) { value in ReplyShareSheet(text: value.text) }
      .task { await legacy.loadIfNeeded(); await migration.loadIfNeeded() }
    }.navigationViewStyle(.stack)
  }
}

private struct SharedReply: Identifiable { let id = UUID(); let text: String }

private struct ReplyShareSheet: UIViewControllerRepresentable {
  let text: String
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [text], applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
