# RunweaveBrowser

Runweave 与随记 iOS 共用的单页浏览器实现。Swift Package 最低声明 iOS 15，使用 Swift 5 语言模式；
实际 App 部署版本仍由两个宿主决定。只依赖 Foundation、SwiftUI、UIKit、WebKit，无业务包或第三方依赖。

## 接入边界

宿主稳定持有 `BrowserSession(configuration:)`，通过 `currentSource` 提供当前 `BrowserContext`。
context 的 scope 是不透明身份组件数组，generation 是业务生命周期代次；禁止放入凭据。
宿主注册实时 `isAvailable` 查询，再把用户意图交给 `open`。检查会在初次操作和异步卸载后分别执行，
不可呈现时不排队重放。宿主提供 fullScreenCover、非网页状态下的 BrowserPromptPresenter，以及收起页面的恢复入口。

`BrowserScreen` 提供默认工具栏、网页加载/错误 UI 和页面提示。返回标签、宿主名称与清理说明由配置传入，
WebView/Page 内部实现不对业务 App 暴露。真实调用方：

- [Runweave TerminalScreen](../app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalScreen.swift)：连接/终端身份及输入、媒体呈现互斥。
- [随记 SuijiBrowserHost](../suiji-ios/Sources/SuijiIOS/Features/Browser/SuijiBrowserHost.swift)：根账户会话、UIKit 链接意图与继续浏览入口。

## 会话与网站数据

收起保留页面、网页历史和未提交表单；相同完整 URL 恢复页面，不刷新；不同 URL 先确认再替换。
关闭和业务失效同步使旧回调不可用，随后卸载旧文档。清网站数据必须先完成卸载，失败时停止清理。
网页运行时不持久化；重启只保留网站自身的持久 Cookie/存储，不恢复页面或表单。

各 App 使用各自沙箱的默认 WKWebsiteDataStore，不迁移 Runweave 原存储。网站身份与宿主业务身份独立：
切业务账户关闭页面但不自动清 Cookie；清理操作影响当前 App 的全部内置网站，不影响另一 App 或业务草稿。
不注入认证头、Keychain、终端或随记原生桥。飞书/Lark 白名单跳转保留可信 HTTPS 来源、原生确认与过期检查。

## 验证

通过宿主 [Runweave](../app-ios/README.md) 和 [随记](../suiji-ios/README.md) 的现有 Xcode 构建入口验证本包，
核对编译列表包含 `Sources/RunweaveBrowser`，不能用 macOS `swift build` 替代 iOS 构建。
原生行为使用 agent-device 或现有固定 XCTest：

- [Runweave 浏览器](../../docs/testing/app/ios-native-browser.testplan.yaml)
- [导航与身份安全](../../docs/testing/app/ios-native-browser-safety.testplan.yaml)
- [随记浏览器接入](../../docs/testing/suiji/ios-browser-reuse.testplan.yaml)

构建通过不等于原生交互、真机授权或真实业务 SSO 通过；共享代码也不代表跨 App 共享网站登录。
