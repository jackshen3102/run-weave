import SwiftUI
import UIKit

public struct BrowserScreen: View {
  @ObservedObject var browser: BrowserSession
  @Environment(\.scenePhase) private var scenePhase
  public init(browser: BrowserSession) { self.browser = browser }

  private let chrome = Color(uiColor: .secondarySystemBackground)

  public var body: some View {
    VStack(spacing: 0) {
      if let page = browser.page {
        navigationBar(page)
          .zIndex(1)
        webContent(page)
        navigationControls(page)
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
    HStack(spacing: 4) {
      Button { browser.collapse() } label: {
        Image(systemName: "chevron.left")
          .font(.system(size: 22, weight: .regular))
          .frame(width: 44, height: 48)
          .contentShape(Rectangle())
      }
      .accessibilityLabel(browser.configuration.returnLabel)
      .accessibilityIdentifier("browser-collapse")

      Text(page.title)
        .font(.system(size: 17, weight: .medium))
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("browser-title")

      if page.currentURL.scheme?.lowercased() == "http" {
        Image(systemName: "exclamationmark.shield")
          .font(.system(size: 14))
          .foregroundStyle(.orange)
          .accessibilityLabel("未加密连接")
      }
      pageMenu(page)
    }
    .buttonStyle(.plain)
    .foregroundStyle(.primary)
    .padding(.horizontal, 8)
    .frame(height: 48)
    .background(chrome)
    .overlay(alignment: .bottom) {
      if page.webView.isLoading && page.failure == nil {
        ProgressView(value: page.webView.estimatedProgress)
          .progressViewStyle(.linear)
          .tint(.accentColor)
          .frame(height: 2)
          .clipped()
          .animation(.easeOut(duration: 0.2), value: page.webView.estimatedProgress)
          .accessibilityLabel("正在加载网页")
          .accessibilityIdentifier("browser-loading")
      }
    }
  }

  private func pageMenu(_ page: BrowserPage) -> some View {
    Menu {
      Section {
        Button { perform(page, action: .link) } label: {
          Label("链接", systemImage: "link")
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
          Label("清除网页数据", systemImage: "trash")
        }
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 22, weight: .medium))
        .frame(width: 44, height: 48)
        .contentShape(Rectangle())
    }
    .accessibilityLabel("更多")
    .accessibilityIdentifier("browser-more")
  }

  private func webContent(_ page: BrowserPage) -> some View {
    ZStack {
      BrowserWebView(page: page)
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
    HStack(spacing: 0) {
      Button { page.back() } label: {
        toolbarIcon("chevron.left")
      }
      .disabled(!page.webView.canGoBack)
      .accessibilityLabel("网页后退")
      .accessibilityIdentifier("browser-back")
      Button { page.forward() } label: {
        toolbarIcon("chevron.right")
      }
      .disabled(!page.webView.canGoForward)
      .accessibilityLabel("网页前进")
      .accessibilityIdentifier("browser-forward")
      Button { page.reload() } label: {
        toolbarIcon("arrow.clockwise")
      }
      .accessibilityLabel("刷新网页")
      .accessibilityIdentifier("browser-reload")
    }
    .font(.system(size: 21, weight: .regular))
    .buttonStyle(.plain)
    .foregroundStyle(.primary)
    .frame(height: 48)
    .background(chrome)
    .overlay(alignment: .top) { Divider() }
  }

  private func toolbarIcon(_ name: String) -> some View {
    Image(systemName: name)
      .frame(maxWidth: .infinity)
      .frame(height: 48)
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

public struct BrowserPromptPresenter: ViewModifier {
  @ObservedObject var browser: BrowserSession
  let active: Bool
  public init(browser: BrowserSession, active: Bool) {
    self.browser = browser
    self.active = active
  }
  public func body(content: Content) -> some View {
    content.alert("网页",
      isPresented: Binding(
        get: { active && browser.prompt != nil },
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

  private func confirmationTitle(_ kind: BrowserSession.Prompt.Kind) -> String {
    switch kind {
    case .replace: return "替换网页"
    case .close: return "关闭网页"
    case .clear: return "清除全部网站数据"
    case .address: return "复制链接"
    case .application(let link): return "打开\(link.name)"
    case .message: return "好"
    }
  }
}
