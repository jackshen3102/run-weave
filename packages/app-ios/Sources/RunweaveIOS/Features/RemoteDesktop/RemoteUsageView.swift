import Clarity
import SwiftUI
import UIKit

private struct RemoteUsageExport: Identifiable {
  let url: URL
  var id: URL { url }
}

struct RemoteUsageView: View {
  @ObservedObject var store: RemoteUsageStore
  @State private var export: RemoteUsageExport?
  @State private var confirmClear = false
  @State private var failure: String?

  var body: some View {
    List {
      Section {
        Text("最近 \(store.records.count) 次打开；\(store.records.filter { $0.firstVisibleFrameMilliseconds != nil }.count) 次出现画面；\(store.records.filter(\.inputObserved).count) 次发送过输入。")
        Text("自动保留最近 100 次。可在记录中补填使用目的和结果，也可留空。记录保存在这部手机，不依赖 Backend。")
          .font(.footnote).foregroundColor(.secondary)
        Button("导出使用记录") {
          do { export = RemoteUsageExport(url: try store.export()); failure = nil }
          catch { failure = "导出失败，请重试。" }
        }.accessibilityIdentifier("remote-usage-export")
        Button("清空使用记录", role: .destructive) { confirmClear = true }
          .disabled(store.records.isEmpty && store.storageWarning == nil)
      }
      if let warning = store.storageWarning { Section { Text(warning).foregroundColor(.orange) } }
      if let failure { Section { Text(failure).foregroundColor(.red) } }
      Section(header: Text("最近使用")) {
        if store.records.isEmpty { Text("还没有使用记录").foregroundColor(.secondary) }
        ForEach(store.records.reversed()) { record in
          NavigationLink {
            RemoteUsageDetail(store: store, id: record.id)
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              Text(record.startedAt, style: .date) + Text(" ") + Text(record.startedAt, style: .time)
              Text("\(record.purpose.label) · \(record.outcome.label)").font(.caption).foregroundColor(.secondary)
            }
          }
        }
      }
    }
    .navigationTitle("桌面使用记录")
    .navigationBarTitleDisplayMode(.inline)
    .clarityMask()
    .mobileAnalyticsScreen(.remoteUsage)
    .confirmationDialog("清空全部本地桌面使用记录？", isPresented: $confirmClear, titleVisibility: .visible) {
      Button("清空", role: .destructive) { store.clear() }
    }
    .sheet(item: $export) { file in
      RemoteUsageShare(url: file.url).onDisappear {
        try? FileManager.default.removeItem(at: file.url)
      }
    }
  }
}

private struct RemoteUsageDetail: View {
  @ObservedObject var store: RemoteUsageStore
  let id: UUID
  private var record: RemoteUsageRecord? { store.records.first { $0.id == id } }

  var body: some View {
    Form {
      if let record {
        Section(header: Text("使用反馈（可选）")) {
          Picker("为什么打开", selection: Binding(get: { self.record?.purpose ?? .unknown }, set: {
            store.feedback(id, purpose: $0, outcome: self.record?.outcome ?? .unknown)
          })) {
            ForEach(RemoteUsagePurpose.allCases, id: \.self) { Text($0.label).tag($0) }
          }
          Picker("事情办成了吗", selection: Binding(get: { self.record?.outcome ?? .unknown }, set: {
            store.feedback(id, purpose: self.record?.purpose ?? .unknown, outcome: $0)
          })) {
            ForEach(RemoteUsageOutcome.allCases, id: \.self) { Text($0.label).tag($0) }
          }
          Text("连接、显示和发送输入均不能代表事情办成；未填写的结果保留为未知。")
            .font(.footnote).foregroundColor(.secondary)
        }
        Section(header: Text("连接情况")) {
          Text("连接尝试：\(record.attemptCount) 次（含重连和前台恢复）")
          Text("出现画面：\(record.visibleAttemptCount) 次；首次显示只读：\(record.readOnlyAttemptCount) 次")
          if let ms = record.firstVisibleFrameMilliseconds {
            Text("首次出现画面的连接耗时：\(Int(ms)) ms")
          } else { Text("未观察到画面") }
          Text(record.inputObserved ? "曾发送输入" : "未观察到发送输入")
          Text("已结束连接的输入消息：\(record.sentInputMessages)")
          Text("已结束连接累计时长：\(Int(record.completedAttemptMilliseconds / 1_000)) 秒")
          Text(record.endReason == "interrupted_unknown" ? "上次运行中断，结束时间未知" :
            record.endReason == nil ? "尚未关闭" : "已关闭")
          Text("输入消息包含鼠标移动，仅表示客户端已发送。异常退出时，最后一段连接的计数可能不完整。")
            .font(.footnote).foregroundColor(.secondary)
        }
        if !record.recentAttempts.isEmpty {
          Section(header: Text("最近连接尝试")) {
            ForEach(Array(record.recentAttempts.enumerated()), id: \.offset) { _, attempt in
              VStack(alignment: .leading, spacing: 4) {
                Text(attempt.endedAt, style: .time)
                Text(attemptReason(attempt.reason))
                Text("持续 \(Int(attempt.durationMilliseconds / 1_000)) 秒 · \(attempt.firstVisibleFrameMilliseconds == nil ? "未出现画面" : "曾出现画面")")
                  .font(.caption).foregroundColor(.secondary)
              }
            }
            Text("保留最近 20 次已结束尝试。原因来自客户端观察，不能据此确定网络或 Mac 状态；旧记录的连接中断可能包含建连超时。")
              .font(.footnote).foregroundColor(.secondary)
          }
        }
      }
    }
    .navigationTitle("本次使用")
    .clarityMask()
    .mobileAnalyticsScreen(.remoteUsageDetail)
  }

  private func attemptReason(_ reason: String) -> String {
    switch reason {
    case "connection_timeout": return "建立连接超时"
    case "connection_lost": return "连接中断（原因未确定）"
    case "connection_or_stream_error": return "连接或数据流异常"
    case "user_closed": return "用户关闭"
    case "background": return "App 进入后台"
    default: return "连接结束：\(reason)"
    }
  }
}

private struct RemoteUsageShare: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
