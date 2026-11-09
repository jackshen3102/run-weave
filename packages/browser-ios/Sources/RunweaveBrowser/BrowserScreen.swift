import SwiftUI
import UIKit

public struct BrowserScreen: View {
  @ObservedObject var browser: BrowserSession
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorSchemeContrast) private var contrast
  private let returnLabel: String?
  public init(browser: BrowserSession, returnLabel: String? = nil) {
    self.browser = browser
    self.returnLabel = returnLabel
  }

  private let chrome = Color(uiColor: .secondarySystemBackground)

  public var body: some View {
    VStack(spacing: 0) {
      if let page = browser.page {
        navigationBar(page)
          .zIndex(1)
        webContent(page)
          .overlay(alignment: .bottom) {
            navigationControls(page)
              .padding(.horizontal, 16).padding(.vertical, 12)
          }
      }
    }
    .background(chrome.ignoresSafeArea())
    .modifier(BrowserPromptPresenter(browser: browser, active: true))
    .onChange(of: scenePhase) { phase in
      if phase != .active {
        browser.page?.cancelJavaScriptDialog()
        browser.cancelApplicationRequest()
      }
    }
  }

  private func navigationBar(_ page: BrowserPage) -> some View {
    HStack(spacing: 8) {
      Button { browser.collapse() } label: {
        HStack(spacing: 4) {
          Image(systemName: "chevron.down").font(.system(size: 18, weight: .medium))
          Text(returnLabel ?? browser.configuration.returnLabel)
            .font(.subheadline.weight(.medium)).lineLimit(1)
        }
        .padding(.horizontal, 10).frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
      }
      .background(chrome.opacity(0.65), in: Capsule())
      .accessibilityLabel(returnLabel ?? browser.configuration.returnLabel)
      .accessibilityIdentifier("browser-collapse")

      Button { perform(page, action: .link) } label: {
        HStack(spacing: 8) {
          if page.webView.isLoading && page.failure == nil {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: page.exportURL.scheme == "http" ? "exclamationmark.shield" : "globe")
              .foregroundStyle(page.exportURL.scheme == "http" ? Color.orange : Color.secondary)
          }
          Text(page.exportURL.host ?? "网页")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
          .lineLimit(1).truncationMode(.middle)
          .frame(maxWidth: .infinity)
        }
        .frame(minHeight: 44)
      }
      .accessibilityLabel("网页地址")
      .accessibilityValue(page.exportURL.absoluteString)
      .accessibilityHint("\(page.title)，查看完整链接")
      .accessibilityIdentifier("browser-address")
      pageMenu(page)
    }
    .buttonStyle(.plain)
    .foregroundStyle(.primary)
    .padding(6)
    .modifier(BrowserChromeSurface(reduceTransparency: reduceTransparency || contrast == .increased))
    .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 8)
    .overlay(alignment: .bottom) {
      if page.webView.isLoading && page.failure == nil {
        ProgressView(value: page.webView.estimatedProgress)
          .progressViewStyle(.linear)
          .tint(.accentColor)
          .frame(height: 2)
          .clipped()
          .animation(.easeOut(duration: 0.2), value: page.webView.estimatedProgress)
          .accessibilityLabel("正在加载网页")
          .accessibilityValue("\(Int(page.webView.estimatedProgress * 100))%")
          .accessibilityIdentifier("browser-loading")
      }
    }
  }

  private func pageMenu(_ page: BrowserPage) -> some View {
    Menu {
      Section {
        Button { perform(page, action: .link) } label: {
          Label("查看完整链接", systemImage: "link")
        }
        Button { perform(page, action: .externalOpen) } label: {
          Label("在默认浏览器打开", systemImage: "safari")
        }
      } header: {
        Text(page.exportURL.host ?? "网页")
          .accessibilityIdentifier("browser-domain")
      }
      Section {
        Button(role: .destructive) {
          browser.request(.close, message: page.localPreview == nil ? "关闭网页？未提交内容可能丢失。网站登录数据仍保留。" : "关闭本地预览？未提交内容与临时网站数据将丢失。")
        } label: {
          Label("关闭网页", systemImage: "xmark")
        }
        Button(role: .destructive) {
          browser.request(.clear, message: browser.configuration.clearDataMessage)
        } label: {
          Label("清除全部网站数据", systemImage: "trash")
        }
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 22, weight: .medium))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .background(chrome.opacity(0.65), in: Circle())
    }
    .accessibilityLabel("更多")
    .accessibilityIdentifier("browser-more")
  }

  private func webContent(_ page: BrowserPage) -> some View {
    ZStack {
      BrowserWebView(page: page, bottomContentInset: 76)
        // Extend the webpage to the screen edge; floating controls keep their safe-area layout.
        .ignoresSafeArea(.container, edges: .bottom)
      if let failure = page.failure {
        VStack(spacing: 16) {
          Image(systemName: "globe")
            .font(.system(size: 36, weight: .light))
            .foregroundStyle(.secondary)
          Text("无法打开网页").font(.headline)
          Text(failure)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
          Text(page.exportURL.absoluteString)
            .font(.caption).foregroundStyle(.secondary)
            .lineLimit(4).truncationMode(.middle)
            .accessibilityIdentifier("browser-failed-address")
          Button("重新加载") { page.retry() }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("browser-retry")
        }
        .frame(maxWidth: 320)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityIdentifier("browser-error")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onAppear { browser.reportVisible(); page.showLocalPreviewNoticeIfNeeded() }
    .overlay(alignment: .top) {
      if let message = browser.dataStatus ?? page.notice {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "info.circle")
          Text(message)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("browser-operation-status")
          if browser.dataStatus == nil {
            Button { page.dismissNotice() } label: {
              Image(systemName: "xmark")
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭提示")
            .accessibilityIdentifier("browser-dismiss-notice")
          }
        }
        .font(.footnote)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(12)
      }
    }
  }

  private func navigationControls(_ page: BrowserPage) -> some View {
    HStack(spacing: 12) {
      HStack(spacing: 0) {
        Button { page.back() } label: { toolbarIcon("chevron.left") }
          .disabled(!page.webView.canGoBack)
          .accessibilityLabel("网页后退")
          .accessibilityIdentifier("browser-back")
        if page.webView.canGoForward {
          Button { page.forward() } label: { toolbarIcon("chevron.right") }
            .accessibilityLabel("网页前进")
            .accessibilityIdentifier("browser-forward")
        }
      }
      .modifier(BrowserChromeSurface(reduceTransparency: reduceTransparency || contrast == .increased))
      Spacer(minLength: 0)
      HStack(spacing: 0) {
        Button { browser.shareCurrentPage() } label: { toolbarIcon("square.and.arrow.up") }
          .accessibilityLabel("分享网页")
          .accessibilityIdentifier("browser-share")
        Button { page.reload() } label: { toolbarIcon("arrow.clockwise") }
          .accessibilityLabel("刷新网页")
          .accessibilityIdentifier("browser-reload")
        Button { perform(page, action: .externalOpen) } label: { toolbarIcon("safari") }
          .accessibilityLabel("在默认浏览器打开")
          .accessibilityIdentifier("browser-external-open")
      }
      .modifier(BrowserChromeSurface(reduceTransparency: reduceTransparency || contrast == .increased))
    }
    .font(.system(size: 21, weight: .regular))
    .buttonStyle(.plain)
    .foregroundStyle(.primary)
  }

  private func toolbarIcon(_ name: String) -> some View {
    Image(systemName: name)
      .frame(width: 52, height: 52)
      .contentShape(Rectangle())
  }

  private func perform(_ page: BrowserPage, action: BrowserOpenIntent.Action) {
    browser.open(
      BrowserOpenIntent(
        target: page.exportURL.absoluteString, origin: .page,
        action: action, sessionIdentity: page.id), source: page.source,
      presentationAvailable: true)
  }
}

private struct BrowserChromeSurface: ViewModifier {
  let reduceTransparency: Bool

  func body(content: Content) -> some View {
    content
      .background {
        if reduceTransparency {
          Capsule().fill(Color(uiColor: .secondarySystemBackground))
        } else {
          Capsule().fill(.regularMaterial)
        }
      }
      .overlay { Capsule().strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5).allowsHitTesting(false) }
      .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
  }
}

public struct BrowserPromptPresenter: ViewModifier {
  @ObservedObject var browser: BrowserSession
  @State private var pendingConfirmation: BrowserSession.Prompt?
  let active: Bool
  public init(browser: BrowserSession, active: Bool) {
    self.browser = browser
    self.active = active
  }
  public func body(content: Content) -> some View {
    content.sheet(item: Binding(
      get: { active ? linkPrompt : nil },
      set: { if active && $0 == nil { browser.prompt = nil } }
    ), onDismiss: {
      let pending = pendingConfirmation
      pendingConfirmation = nil
      // Navigate only after the sheet is gone; the host checks live presentation
      // availability and the session validates the original source and lifetime.
      if active, browser.prompt == nil, let pending { browser.confirm(pending) }
    }) { prompt in
      if case .share(let url) = prompt.kind, #available(iOS 16.0, *) {
        shareSheet(url, prompt: prompt)
          .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
      } else if case .share(let url) = prompt.kind {
        shareSheet(url, prompt: prompt)
      } else if #available(iOS 16.0, *) {
        linkSheet(prompt).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
      } else {
        linkSheet(prompt)
      }
    }
    .alert(alertTitle,
      isPresented: Binding(
        get: { active && browser.prompt != nil && linkPrompt == nil },
        set: { value in
          if active && !value { browser.prompt = nil }
        }),
      presenting: browser.prompt
    ) { prompt in
      if case .message = prompt.kind {
        Button("好", role: .cancel) {}
      } else {
        Button(confirmationTitle(prompt.kind)) { browser.confirm(prompt) }
        Button("取消", role: .cancel) {}
      }
    } message: { prompt in
      Text(prompt.message)
    }
  }

  private var linkPrompt: BrowserSession.Prompt? {
    guard let prompt = browser.prompt else { return nil }
    switch prompt.kind {
    case .open, .address, .share: return prompt
    default: return nil
    }
  }

  private func shareSheet(_ url: URL, prompt: BrowserSession.Prompt) -> some View {
    BrowserShareSheet(url: url) {
      if browser.prompt?.id == prompt.id { browser.prompt = nil }
    }
  }

  private var alertTitle: String {
    guard let prompt = browser.prompt else { return "网页" }
    switch prompt.kind {
    case .message: return "无法打开链接"
    default: return confirmationTitle(prompt.kind)
    }
  }

  private func linkSheet(_ prompt: BrowserSession.Prompt) -> some View {
    let target: String
    let opening: Bool
    switch prompt.kind {
    case .open(let url): target = url.absoluteString; opening = true
    case .address(let value): target = value; opening = false
    default: target = prompt.message; opening = false
    }
    return VStack(spacing: 0) {
      HStack {
        Button("取消", role: .cancel) { browser.prompt = nil }
          .accessibilityIdentifier("browser-link-cancel")
        Spacer()
        Text(opening ? "打开链接" : "网页链接").font(.headline).foregroundStyle(.primary)
        Spacer()
        // Balance the leading control without a second visible action.
        Text("取消").hidden().accessibilityHidden(true)
      }
      .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 16)
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          HStack(spacing: 12) {
            Image(systemName: "globe")
              .font(.title2).foregroundStyle(Color.accentColor)
              .frame(width: 44, height: 44)
              .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
              Text(URLComponents(string: target)?.host ?? "链接地址").font(.headline)
              Text(opening ? "核对地址后，在 App 内打开" : "完整地址，可选择或复制")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
          Text(target).font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            .accessibilityIdentifier("browser-full-address")
          if opening {
            Label("已合并终端中的跨行网址", systemImage: "text.alignleft")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }.padding(.horizontal, 20).padding(.bottom, 12)
      }
      Button {
        pendingConfirmation = prompt
        browser.prompt = nil
      } label: {
        Label(opening ? "打开网页" : "复制链接", systemImage: opening ? "arrow.up.right" : "doc.on.doc")
          .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 8)
      }
      .buttonStyle(.borderedProminent).controlSize(.large)
      .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 20)
      .accessibilityIdentifier("browser-link-confirm")
    }
    .background(Color(uiColor: .systemBackground))
  }

  private func confirmationTitle(_ kind: BrowserSession.Prompt.Kind) -> String {
    switch kind {
    case .open: return "打开网页"
    case .replace: return "替换网页"
    case .close: return "关闭网页"
    case .clear: return "清除全部网站数据"
    case .address: return "复制链接"
    case .share: return "分享网页"
    case .application(let link): return "打开\(link.name)"
    case .message: return "好"
    }
  }
}
