# 随记复用内置浏览器：iOS 实施计划

状态：代码已实现，构建与核心交互已验证，完整 required 验收矩阵尚未完成（2026-09-17）。本计划保留跟踪剩余验收，不表示所有用例通过。

用户已确定采用「iOS 抽完整共享组件包，桌面端复用现有浏览器入口」。两个子系统可独立交付；桌面部分见[桌面实施计划](2026-09-17-suiji-browser-desktop-reuse.md)。代码已实现，并在独立 Simulator 和 Electron Dev Session 验证；随记另以候选工作区源码覆盖安装到 iPhone 17，已确认启动，不代表全量真机交互验收。

## 本轮验证记录

Runweave Debug/Profile/Release、随记 Debug/Release 均构建通过，新共享 Swift 文件进入两个宿主编译。独占 iPhone 17 Simulator（iOS 26.5）已实测随记列表链接、收起恢复与表单保留、取消/确认替换、Cookie 与 localStorage 清理。Runweave 最终 Debug 原生终端也实测 HTTPS 点击打开、回终端和恢复同一页面。HTTP 只读比对四条测试记录正文与版本均未变化。

完整用例中的业务草稿、所有来源失效、双 App 网站身份、原生选区与大字号矩阵尚未全部执行；飞书客户端交接和真实 SSO 缺授权真机/账号，不能以受控站点代替。证据位于本工作区 `.runweave/browser-reuse/`，逐例状态见其中 `verification.md`。

## 目标与范围

- Runweave 与随记 iOS 依赖同一份独立 Swift Package，复用网页会话、WKWebView、导航策略和默认浏览器 UI。
- 随记列表卡片和详情正文的 HTTP(S) 链接默认在 App 内打开；保留普通文字选择、复制和卡片进入详情的行为。
- Runweave 终端现有浏览体验、来源隔离、网站登录数据和终端草稿不因提取模块而改变。
- 不复制两套浏览器，不让随记依赖 RunweaveIOS、SwiftTerm 或 SwiftUIX，不把 Swift 实现放入 TypeScript shared/common。
- 不增加多标签页、下载管理、跨 App Cookie 同步、电脑端口代理、浏览历史落盘或新的原生网页业务桥。后端和随记服务 API 不变。

## 实施前事实与关键差异

| 当前入口                                                            | 事实                                                                                 | 改动要求                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/app-ios/Sources/RunweaveIOS/Features/Browser/`            | 4 个 Swift 文件共约 1,193 行，包含 Screen、Session、WebView/Page、URLPolicy          | 原实现迁移为一份共享源码，限制公开 API                             |
| `BrowserSession.swift`                                              | 持有默认 WKWebsiteDataStore、单页、退役页面集合、过期回调保护；呈现注册绑定 Terminal | 保留状态机与安全卸载，把终端注册改为宿主呈现注册                   |
| `BrowserURLPolicy.swift`                                            | 来源含 connectionScope、generation、terminalID；选区识别与通用导航策略同文件         | 通用作用域不认识终端；终端选区识别留在 Runweave 适配层             |
| `State/AppSession.swift`、`Features/Terminal/TerminalScreen.swift`  | 当前连接与终端生成来源；关闭终端失效；多个原生 modal 决定能否打开                    | 继续由宿主拥有业务生命周期，不在共享包读取业务状态                 |
| `packages/suiji-ios/Sources/SuijiIOS/DesignSystem/RecordBody.swift` | UITextView 链接属性交给系统处理，未接浏览器                                          | 使用真实 UITextView 链接 delegate 转发用户意图，防止系统和内置双开 |
| `packages/suiji-ios/Sources/SuijiIOS/State/SuijiSession.swift`      | resetConnection 统一更新身份代次，取消旧 client，清理业务状态                        | 在异步取消前同步使浏览器失效，不把列表刷新当账户切换               |

就近约束见两个包的 `AGENTS.md`。随记纯展示组件不读凭据、不自行发网络请求。

## 确定的用户行为

1. 列表链接点击只打开链接，不同时进入记录详情；非链接区域仍进入详情。详情的文字选择与复制保持。
2. 每个 App 进程内首版只有一个浏览器会话。收起保留页面、滚动、历史和未提交表单；宿主提供「继续浏览」入口。确认关闭才卸载页面并移除入口。
3. 再开当前完整 URL 只恢复；另一个 URL 必须先确认替换，取消不损失旧页，确认后新页不能后退到旧会话。query/fragment 参与完整 URL 比较。
4. 随记浏览器由当前已验证账户的根会话持有。同账户的列表刷新、筛选、详情与 Tab 切换不自行销毁收起页面；recordID 只作为来源信息，不作为账户隔离键。浏览器显示期间保持原导航栈，收起回到打开前的列表或详情位置。
5. 随记环境切换、更换连接、登出或身份失效都同步失效旧网页及旧提示；再次登录不能自动恢复旧网页。业务 resetConnection 即为浏览器失效边界，即使重新连接到相同身份也建立新代次。
6. 编辑器、附件预览、系统媒体选择器等冲突呈现期间拒绝新的浏览器呈现；不排队，不在冲突解除后自动重放。
7. 网页标题、返回文案与授权提示使用宿主配置：Runweave 显示「回终端」「返回 Runweave」，随记显示「回随记」「返回随记」。默认视觉沿用现有浏览器，不另做 UI 设计。

## 模块与接口合同

新包路径定为 `packages/browser-ios`，Swift product/module 为 `RunweaveBrowser`，最低 iOS 15，Swift 语言模式与当前宿主一致。不引入第三方依赖；两个 App 原有部署下限不变。共享包只有 Foundation、SwiftUI、UIKit、WebKit 等系统依赖。

依赖方向：RunweaveIOS → RunweaveBrowser ← SuijiIOS。不建立两个业务 App 间的依赖。Package.swift 使用相邻本地路径；Xcode host 原则上沿用现有业务 product，只有实际解析要求时才改工程引用。

以下是新接口的语义合同，名称允许在实现中按 Swift 风格调整，但职责不能合并回业务模型：

| 接口                               | 输入与输出 / 不变量                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `BrowserContext`                   | 不含凭据的不透明业务作用域 ID 与生命周期代次；比较完整身份，不把 terminalID/ownerId 定义为共享包必需字段                   |
| `BrowserOpenIntent`                | 原始目标、打开/外部打开/查看链接动作、业务入口或页面入口、可选当前页面 identity；保留当前防过期语义                        |
| `BrowserHostRegistration`          | 注册 ID、宿主实例身份、context、实时可呈现查询；打开前和 await 后都重新校验，不缓存初次 Bool                               |
| `BrowserSession`                   | 每个宿主一份稳定对象；公开只读展示状态、open/resume/collapse/invalidate 及受控提示动作；Page 与 WKWebView 生命周期内部管理 |
| `BrowserPresentationConfiguration` | 宿主名称、返回标签、网站数据清除说明和外部跳转策略；仅传必要文案与策略，不传整个 AppSession/SuijiSession                   |
| `BrowserScreen` / 提示呈现组件     | 默认 UI 及可访问性标识；不自行访问终端、随记 API、Keychain 或草稿                                                          |

Runweave 适配层将 connection scope、generation、terminal identity 映射到 context；保持退出终端就失效的现有行为。随记映射 environment、规范 endpoint、serverId、ownerId 与连接代次。共享包不解析这些业务字段，context 不进入 URL、网页 JS 或对外日志。

### 数据、安全与失败语义

- 共享实现继续使用各 App 沙箱中的默认持久 WKWebsiteDataStore，不迁移已有 Runweave 网站数据。不声称共享库能共享两个 App 的 Cookie。
- 同一 App 内的网站登录独立于业务账户；随记切账户销毁页面，但默认不清网站 Cookie。清除确认明确写「清除此 App 的全部内置网站数据」，不声称仅当前随记账户网站数据。
- 保留先同步失效回调、再受控卸载旧文档、确认卸载后才删网站数据的顺序。卸载失败时停止清理并提示，不允许旧网页继续写入已清数据。
- 不给网页注入随记 token、Runweave 凭据或业务 API 原生桥；随记 APIClient 无 Cookie 的现状不变。
- 保留现有 HTTP(S)、本地地址、TLS、下载和新窗口策略。不得因随记 Debug 服务在 loopback 就放开浏览器 loopback 策略，也不新增全局 ATS 放行。
- 保留飞书/Lark 精确白名单、可信 HTTPS 来源和原生确认，以及页面 identity/navigationRevision/lifetime 的过期检查；授权失败留在原页并提供真实提示。不要重新改成任意 scheme 可打开。
- 普通后台往返不主动卸载；进程冷启动不恢复网页和表单。主文档错误与 WebContent 回收继续走已有显式重试，不自动执行业务写入。

## 分阶段任务与文件范围

### I1：提取共享实现，先迁移 Runweave

- [x] 新建 `packages/browser-ios/Package.swift`、`AGENTS.md`、`README.md` 与 `Sources/RunweaveBrowser/`。迁移现有四文件的通用部分，不保留复制实现。
- [x] 将终端选区 URL 识别保留在 `packages/app-ios/Sources/RunweaveIOS/Features/Terminal/`；更新实际 import/调用者，包括 Terminal/Input 下引用 BrowserOpenIntent 的入口，不改手势算法。
- [x] 更新 `packages/app-ios/Package.swift`，调整 `State/AppSession.swift` 和 `Features/Terminal/TerminalScreen.swift` 的宿主注册、context 和 UI 装配。保留原可访问性标识、default data store 和数据清理顺序。
- [ ] 校验全仓对旧类型的引用；构建 Runweave Debug/Profile/Release，确认新包 Swift 文件实际进入编译产物。通过下述 Runweave 原生回归后再进行 I2。

### I2：随记宿主接入

- [x] 更新 `packages/suiji-ios/Package.swift`；新增 `Sources/SuijiIOS/Features/Browser/SuijiBrowserHost.swift`，负责根呈现、继续浏览入口和宿主文案，不复制共享状态机。
- [x] 更新 `State/SuijiSession.swift`，在统一连接重置和视图会话销毁边界使旧浏览器失效，保证先失效再 await；浏览器对象不得在 body 或列表行中临时创建。
- [x] 更新 `App/SuijiRootView.swift`、`DesignSystem/RecordBody.swift`，通过根环境回调贯通列表/详情；现有 `Components.swift` 与 `RecordDetail.swift` 复用 RecordBody，无需修改。纯展示组件只接收回调；UITextView delegate 拦截生效，不能仅依赖 SwiftUI openURL 环境推测 UIKit 行为。
- [x] 在根层实际协调编辑器、附件预览和系统选择器；注册查询用当前绑定，不能因浏览器自身呈现导致普通 onDisappear 误判来源已经销毁。
- [ ] 构建随记 Debug/Release；执行新增原生验收，并按双宿主矩阵检查共享行为。

### I3：收尾

- [x] 更新 `docs/architecture/README.md` 的 Swift 共享模块边界及两个业务包 README，给新包文档入口；实现完成前不提前把目标写成当前架构事实。
- [ ] 整理运行证据，逐例区分 pass/fail/blocked/not-run；格式、编译、原生交互和真实飞书授权分别报告。
- [ ] 迁移仍有效的设计结论到包文档后，按文档治理删除本临时计划。提交与安装范围由实际执行请求决定，不夹带工作区已有手势、滚动和文档改动。

## 验证与测试合同

新增[随记 iOS 浏览器复用用例](../testing/suiji/ios-browser-reuse.testplan.yaml)，默认 required 全部通过才算随记接入完成。每例拥有独立账户、页面 fixture、资源与证据，清数据仅在独占候选安装运行。

Runweave 提取回归复用[原生浏览器计划](../testing/app/ios-native-browser.testplan.yaml)的 IOSBROWSE-001、003～019；OSC 8 路径同时按 002 验证，但将跨进程重启取证与点击/换行取证拆成独立执行项后再执行，不能让组合结果遮蔽某条失败。

共享导航与安全复用[安全计划](../testing/app/ios-native-browser-safety.testplan.yaml)的 IOSBSAFE-002～007、009～010，在两个宿主分别建立入口执行并分开记录结果；随记入口为正文链接，不伪造终端依赖。这些 case 的业务凭据与草稿断言替换为各自宿主对应状态，核心网页断言不降低。

旧安全计划 008 的「所有自动 scheme 跳转直接阻止」已落后于当前飞书原生确认能力；执行前应在同一实现变更中修正文案，明确仅非白名单直接阻止，白名单转原生确认，覆盖由新增用例承担。旧 001 中网站账号说明也必须核对实际菜单，不能把当前未存在的文案当已实现。真实业务 SSO 按 012 单独报告；缺真实账号或设备不能用受控页面代替宣称成功。

实施检查命令（把 `<UDID>` 替换为 doctor 列出的目标）：

```bash
pnpm testplan:validate docs/testing/suiji/ios-browser-reuse.testplan.yaml
node packages/app-ios/scripts/ios.mjs doctor
node packages/app-ios/scripts/ios.mjs build --simulator <UDID> --configuration Debug
node packages/app-ios/scripts/ios.mjs build --simulator <UDID> --configuration Profile
node packages/app-ios/scripts/ios.mjs build --simulator <UDID> --configuration Release
pnpm --filter @runweave/suiji-ios ios:doctor
pnpm --filter @runweave/suiji-ios ios:build --simulator <UDID> --configuration Debug
pnpm --filter @runweave/suiji-ios ios:build --simulator <UDID> --configuration Release
pnpm architecture:check
pnpm docs:check
git diff --check
```

所有命令应退出 0；另外核对编译文件列表和依赖图，SuijiIOS 不得引入 RunweaveIOS/SwiftTerm。原生行为使用 `$toolkit:agent-device`，固定 XCTest 走包现有入口；构建和设备预检不算 UI 通过。每例记录候选源码、Bundle ID、设备、fixture、操作前后控件树/截图，网络与内存证据按用例需要补充；证据不记录凭据。缺少所需环境记 blocked。

## 风险、兼容与回滚

最高风险是把来源隔离或安全卸载当作业务耦合删除，以及 root/modal 生命周期导致误销毁。I1 先让原宿主回归，再接随记，避免同时改变状态机与业务入口。

保持两个 App 的 Bundle ID、Keychain、UserDefaults、网站存储和草稿目录不变；无数据迁移，无数据库改动。I1 与 I2 分成可审查改动；若随记接入失败可单独撤回 I2，保留已验证的共享包。若包提取失败则回退 I1 对应改动，不清数据、不 hard reset 工作区、不覆盖其他任务代码。回滚也需复核相同构建和入口行为。
