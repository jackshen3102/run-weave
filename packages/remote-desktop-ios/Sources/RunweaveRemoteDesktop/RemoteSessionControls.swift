import SwiftUI

/// Local overlays never participate in the remote surface's layout or input gestures.
struct RemoteSessionControls: View {
    @ObservedObject var session: RemoteDesktopSession
    let hostName: String
    let returnLabel: String
    @Binding var showsMenu: Bool
    let openKeyboard: () -> Void
    let onClose: () -> Void
    @AppStorage("remoteDesktop.controls.leading") private var onLeadingEdge = false
    @AppStorage("remoteDesktop.controls.verticalFraction") private var verticalFraction = 1.0
    @AppStorage("remoteDesktop.controls.collapsed") private var collapsed = false
    @State private var page: MenuPage = .session
    @GestureState private var dragOffset = CGSize.zero
    @ScaledMetric(relativeTo: .body) private var preferredMenuHeight: CGFloat = 476

    private enum MenuPage { case session, statistics, gestures }
    private let inset: CGFloat = 12
    private let toolbarHeight: CGFloat = 52
    private var toolbarWidth: CGFloat { 113 + (collapsed ? 52 : 104) }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let center = toolbarCenter(in: size)
            ZStack(alignment: .topLeading) {
                if showsMenu {
                    Color.black.opacity(0.08)
                        .contentShape(Rectangle())
                        .onTapGesture { showsMenu = false }
                        .accessibilityLabel("关闭会话菜单")
                        .accessibilityAddTraits(.isButton)
                    menu(in: size, toolbarCenter: center)
                }
                toolbar
                    .position(x: clamp(center.x + dragOffset.width,
                                       toolbarWidth / 2 + inset, size.width - toolbarWidth / 2 - inset),
                              y: clamp(center.y + dragOffset.height,
                                       toolbarHeight / 2 + inset, size.height - toolbarHeight / 2 - inset))
                    .highPriorityGesture(DragGesture(minimumDistance: 8)
                        .updating($dragOffset) { value, offset, _ in offset = value.translation }
                        .onChanged { _ in showsMenu = false }
                        .onEnded { value in
                            onLeadingEdge = center.x + value.translation.width < size.width / 2
                            let margin = toolbarHeight / 2 + inset
                            let travel = max(1, size.height - margin * 2)
                            verticalFraction = Double(clamp((center.y + value.translation.height - margin) / travel, 0, 1))
                        })
                    .accessibilityAction(named: Text("移到左侧")) { onLeadingEdge = true }
                    .accessibilityAction(named: Text("移到右侧")) { onLeadingEdge = false }
            }
            .frame(width: size.width, height: size.height)
        }
        .onChange(of: showsMenu) { if !$0 { page = .session } }
    }

    private var toolbar: some View {
        HStack(spacing: 0) {
            Button { showsMenu = false; onClose() } label: {
                Label(returnLabel, systemImage: "chevron.left")
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 112, height: 44)
            }
            .accessibilityIdentifier("remote-desktop-return")
            Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1, height: 22)
            if !collapsed {
                Button(action: openKeyboard) {
                    Image(systemName: "keyboard").foregroundColor(.blue).frame(width: 50, height: 44)
                }
                .disabled(session.state != .controllable)
                .accessibilityLabel("远程键盘")
                .accessibilityIdentifier("remote-desktop-keyboard-toggle")
                Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1, height: 22)
            }
            Button { showsMenu.toggle() } label: {
                Image(systemName: showsMenu ? "xmark" : "ellipsis")
                    .frame(width: collapsed ? 44 : 45, height: 44)
                    .background(showsMenu ? Color.primary.opacity(0.08) : .clear, in: Circle())
            }
            .foregroundColor(.primary)
            .accessibilityLabel(showsMenu ? "关闭会话菜单" : "会话菜单")
            .accessibilityIdentifier("remote-desktop-menu-toggle")
        }
        .font(.system(size: 20, weight: .medium))
        .buttonStyle(.plain)
        .tint(.blue)
        .frame(width: toolbarWidth, height: toolbarHeight)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.14), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote-desktop-controls")
    }

    private func menu(in size: CGSize, toolbarCenter: CGPoint) -> some View {
        let above = max(0, toolbarCenter.y - toolbarHeight / 2 - inset * 2)
        let below = max(0, size.height - toolbarCenter.y - toolbarHeight / 2 - inset * 2)
        let opensAbove = above >= below
        let width = min(320, max(0, size.width - inset * 2))
        // Wide layouts can use the full height beside the capsule instead of a tiny menu above it.
        let fitsBeside = size.width >= width + toolbarWidth + inset * 3
        let height = min(preferredMenuHeight, fitsBeside ? max(0, size.height - inset * 2) : max(above, below))
        let x: CGFloat
        let y: CGFloat
        if fitsBeside {
            x = onLeadingEdge ? toolbarWidth + inset * 2 + width / 2 : size.width - toolbarWidth - inset * 2 - width / 2
            y = clamp(toolbarCenter.y, inset + height / 2, size.height - inset - height / 2)
        } else {
            x = onLeadingEdge ? inset + width / 2 : size.width - inset - width / 2
            y = opensAbove
                ? toolbarCenter.y - toolbarHeight / 2 - inset - height / 2
                : toolbarCenter.y + toolbarHeight / 2 + inset + height / 2
        }
        return VStack(spacing: 0) {
            if page == .session {
                ScrollView { sessionMenu.padding(.horizontal, 12).padding(.top, 12) }
                menuFooter.padding(.horizontal, 12).padding(.bottom, 12)
            } else {
                HStack {
                    Button { page = .session } label: {
                        Image(systemName: "chevron.left").frame(width: 44, height: 44)
                    }.accessibilityLabel("返回会话菜单")
                    Text(page == .statistics ? "连接统计" : "手势帮助").font(.headline)
                    Spacer()
                }
                Divider()
                if page == .statistics {
                    RemoteStatisticsView(statistics: session.statistics, maximumHeight: max(0, height - 45))
                } else {
                    ScrollView { gestures.padding(16) }
                }
            }
        }
        .frame(width: width, height: height)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.25), radius: 16, y: 6)
        .position(x: x, y: y)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote-desktop-menu")
    }

    private var sessionMenu: some View {
        VStack(spacing: 4) {
            HStack(spacing: 12) {
                Image(systemName: "display")
                    .font(.title3).frame(width: 40, height: 40)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 5) {
                    Text(hostName).font(.headline).lineLimit(2)
                    Label(session.state.label, systemImage: session.state == .controllable ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .font(.caption).foregroundColor(.secondary)
                        .accessibilityIdentifier("remote-desktop-state")
                    if let route = session.connectionRoute {
                        Label(route == .local ? "局域网连接" : "隧道连接",
                              systemImage: route == .local ? "wifi" : "network")
                            .font(.caption).foregroundColor(.secondary)
                            .accessibilityIdentifier("remote-desktop-route")
                    }
                }
                Spacer(minLength: 0)
            }.padding(8)
            Picker("输入模式", selection: $session.inputMode) {
                ForEach(RemoteInputMode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.vertical, 8)
            menuButton("适应屏幕", symbol: "arrow.up.left.and.arrow.down.right", identifier: "remote-desktop-fit") {
                session.resetViewport(); showsMenu = false
            }
            menuButton("右击", symbol: "computermouse", identifier: "remote-desktop-right-click") {
                session.click(button: 2); showsMenu = false
            }.disabled(session.state != .controllable)
            menuButton("连接统计", symbol: "waveform.path.ecg", identifier: "remote-desktop-statistics-toggle") {
                page = .statistics
            }
            menuButton("手势帮助", symbol: "questionmark.circle", identifier: "remote-desktop-gestures") {
                page = .gestures
            }
        }
    }

    // Keep ending the session reachable even when large text or rotation requires scrolling.
    private var menuFooter: some View {
        VStack(spacing: 4) {
            Divider().padding(.vertical, 4)
            menuButton(collapsed ? "展开工具栏" : "收起工具栏", symbol: "sidebar.right", identifier: "remote-desktop-collapse") {
                collapsed.toggle(); showsMenu = false
            }
            menuButton("结束会话", symbol: "rectangle.portrait.and.arrow.right", identifier: "remote-desktop-close", destructive: true) {
                showsMenu = false; onClose()
            }
        }
    }

    private func menuButton(_ title: String, symbol: String, identifier: String,
                            destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.subheadline)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 10)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundColor(destructive ? .red : .primary)
        .accessibilityIdentifier(identifier)
    }

    private var gestures: some View {
        VStack(spacing: 16) {
            gestureRow(session.inputMode == .trackpad ? "移动指针" : "指向位置", "单指滑动")
            gestureRow("点击 / 双击", "轻点 / 连点两下")
            gestureRow("右击", "双指轻点")
            gestureRow("滚动", "双指滑动")
            gestureRow("缩放画面", "双指捏合")
            gestureRow("移动画面", "三指拖动")
            gestureRow("拖拽", "长按后移动")
        }
    }

    private func gestureRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).foregroundColor(.secondary)
            Spacer()
            Text(value)
        }.font(.subheadline).accessibilityElement(children: .combine)
    }

    private func toolbarCenter(in size: CGSize) -> CGPoint {
        let margin = toolbarHeight / 2 + inset
        return CGPoint(x: onLeadingEdge ? toolbarWidth / 2 + inset : size.width - toolbarWidth / 2 - inset,
                       y: margin + CGFloat(min(1, max(0, verticalFraction))) * max(0, size.height - margin * 2))
    }

    private func clamp(_ value: CGFloat, _ lower: CGFloat, _ upper: CGFloat) -> CGFloat {
        min(max(lower, upper), max(lower, value))
    }
}
