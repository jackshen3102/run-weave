import Clarity
import SwiftUI

struct DevelopmentResourceConfirmation: View {
  let pending: DevelopmentResourcesModel.Confirmation
  let cancel: () -> Void
  let confirm: () -> Void
  @AccessibilityFocusState private var cancelFocused: Bool

  var body: some View {
    VStack(spacing: 20) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          VStack(alignment: .leading, spacing: 8) {
            Text("\(pending.resource.actionLabel)？").font(.title2.bold())
            Text("\(pending.hostName) · \(pending.resource.kind == "simulator" ? "模拟器测试" : "桌面测试")")
              .font(.subheadline).foregroundColor(.secondary)
          }
          VStack(alignment: .leading, spacing: 8) {
            Text(pending.resource.label).font(.headline)
            Text(pending.resource.owner?.task ?? pending.resource.owner?.id ?? "").font(.subheadline)
            if let worktree = pending.resource.owner?.worktree {
              Text("工作树　\(worktree)").font(.caption).foregroundColor(.secondary)
            }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .background(Color(uiColor: .tertiarySystemGroupedBackground)).cornerRadius(12)
          VStack(alignment: .leading, spacing: 6) {
            if pending.resource.release.action == "stop-and-release" {
              Text("将中断这个资源上的测试任务。").foregroundColor(.red)
            }
            Text(pending.resource.kind == "simulator"
              ? "将清理本任务的自动化进程，关闭模拟器并释放占用。其他任务不受影响。"
              : "将停止本会话的服务、清理测试环境并释放占用。其他任务不受影响。")
              .foregroundColor(.secondary)
          }.font(.subheadline)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      VStack(spacing: 10) {
        Button(action: confirm) {
          Text(pending.resource.actionLabel).font(.headline).frame(maxWidth: .infinity, minHeight: 48)
            .foregroundColor(.white).background(Color.red).cornerRadius(12)
        }.accessibilityIdentifier("development-resources-confirm")
        Button(action: cancel) {
          Text("取消").font(.headline).frame(maxWidth: .infinity, minHeight: 48)
            .background(Color(uiColor: .tertiarySystemGroupedBackground)).cornerRadius(12)
        }.accessibilityIdentifier("development-resources-cancel")
          .accessibilityFocused($cancelFocused).keyboardShortcut(.cancelAction)
      }.buttonStyle(.plain)
    }.padding(24).background(Color(uiColor: .secondarySystemGroupedBackground))
      .onAppear { cancelFocused = true }.clarityMask()
  }
}
