# Web 与原生 iOS Clarity 默认采集方案

## 目标和现状

普通 Web 构建和原生 iOS App 默认打包、启用 Microsoft Clarity 自动采集。Web 的 Vite 开发服务与 Runweave Dev Session 属于测试环境，不采集。保持全局初始化，不为业务按钮逐一打事件，不上报 Runweave 用户、连接或终端身份。Electron、Companion 和 overlay harness 继续排除。

Clarity 账户已核对并建立以下项目：

| 用途     | 项目 ID      | 当前状态                                                                                                                               |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Web 生产 | `yo8dc0des6` | 项目已存在且设置为 Strict；项目登记的网站 URL 仍是 `http://127.0.0.1:5001`，不能据此认定线上 Web 已采集。                              |
| Web 验收 | `yo6azwkf18` | 项目已存在，供独立生产模式构建验证。                                                                                                   |
| 原生 iOS | `yofefg4fsy` | 本次新建，Bundle ID 为 `com.runweave.app.native`；Strict、WebView DOM capture 关闭。模拟器会话已在后台实时录制中定位并检查登录页回放。 |

此前 Web 实现要求显式 `VITE_CLARITY_ENABLED=true` 和项目 ID，因此默认关闭；iOS 尚未集成 SDK。本方案把两端的默认行为改为启用，并保留明确的构建期关闭入口。Clarity 项目 ID 是公开客户端标识，不是密钥。

## 实现范围

1. **Web。** `frontend/src/features/analytics/clarity.ts` 使用生产项目 ID 作为默认值；`VITE_CLARITY_PROJECT_ID` 可覆盖为验收项目，显式 `VITE_CLARITY_ENABLED=false` 关闭。`import.meta.env.DEV` 或 `VITE_RUNWEAVE_DEV_SESSION_ID` 存在时跳过初始化。保留协议、Electron、Companion、overlay harness 和同一 Document 幂等检查。托管脚本从微软加载，前端包中内置加载器和项目 ID。
2. **原生 iOS。** `packages/app-ios/Package.swift` 将官方 `microsoft/clarity-apps` 固定在 `4.1.0`（`4.1.1` 的二进制需要当前 Xcode 尚未提供的 Swift 6.4）；`MobileAnalytics.swift` 在 App 主线程启动时只初始化一次。Xcode Debug、Profile、Release 的默认项目均为 `yofefg4fsy` 且启用。`RUNWEAVE_CLARITY_ENABLED=NO` 是显式构建期关闭入口；已安装的旧包不会因修改构建环境而停止。无需用户操作开关，不写新的本地同意状态。
3. **遮盖。** 移动项目保持 Strict 和 WebView DOM capture 关闭。登录和配置字段、任务提示词、终端与命令输入、文件预览、内置浏览器加代码层遮盖，不添加 unmask。需要在真实回放里核对 SwiftUI、SwiftTerm、UIKit 与 WKWebView 的实际效果；关闭 DOM capture 不能推出浏览器视觉内容一定不可见。Web 生产项目也保持 Strict。
4. **文档与验收。** 更新 `frontend/docs/clarity-autocapture.md`、`packages/app-ios/README.md` 和 `docs/testing/analytics/web-clarity-autocapture.testplan.yaml`，使默认启用与 Dev Session 排除一致。移动端独立记录构建、安装、页面交互、上传和云端回放结果，不把前一项当作后一项通过。

## 验收合同

| 场景           | 通过标准                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web 默认构建   | 生产模式构建未传任何 Clarity 环境变量时，普通 Web 只有一个 `yo8dc0des6` tag；页面、菜单和路由正常。                                                                                                     |
| Web 开发排除   | 真实 Vite 开发页和真实 Runweave Dev Session 即使注入项目 ID，也没有 Clarity tag 或 collect 请求。                                                                                                       |
| Web 覆盖和关闭 | 独立生产模式验收构建可将 ID 覆盖为 `yo6azwkf18`；显式 `VITE_CLARITY_ENABLED=false` 后重新构建和刷新不再加载。Electron 与 Companion 继续排除。                                                           |
| iOS 构建与启动 | Xcode 解析锁文件固定 SDK 版本；默认配置含项目 ID 并可构建、安装、启动。显式 `NO` 构建不初始化。                                                                                                         |
| 手机端云端闭环 | 用合成数据在真实设备操作登录、首页、终端、文件与浏览器，移动项目能找到对应的新会话和动作回放；仅有网络请求不算通过。                                                                                    |
| 隐私与体验     | 在合成密码、命令、终端输出、项目路径、任务提示词、文件内容、图片及网页上放唯一标记，逐项检查实际上传与回放不含原文/图像；若出现泄露，先停止该项目采集并修复。比较启动、滚动与终端输入，记录可感知回归。 |

执行代码门禁：`pnpm --filter @runweave/frontend typecheck`、`pnpm --filter @runweave/frontend lint`、`pnpm --filter @runweave/frontend build`、`pnpm testplan:validate docs/testing/analytics/web-clarity-autocapture.testplan.yaml`、`pnpm docs:check`。iOS 按 `packages/app-ios/AGENTS.md` 运行 doctor 和当前设备构建；真机交互使用 `toolkit:agent-device`。如果共享设备不可用，明确记录未完成的设备与云端验证，不以编译通过代替。

## 风险与发布边界

Clarity 官方说明 SwiftUI 输入强制遮盖需逐字段加 `clarityMask()`，遮盖设置最多可能延迟约 1 小时，完整会话可能约 2 小时才显示。默认启用意味着新构建会开始真实采集；发布前核对 App Store 隐私申报和用户披露。Web 与 iOS 的回滚均需重建并发布关闭配置；旧 Web Document 或旧 App 安装不会自动停采。必要时使用 Clarity 后台规则作为紧急处置，但先验证规则的实际生效与时延。

参考：[iOS SDK](https://learn.microsoft.com/en-us/clarity/mobile-sdk/ios-sdk)、[移动端遮盖](https://learn.microsoft.com/en-us/clarity/mobile-sdk/clarity-sdk-masking)、[移动端采集规则](https://learn.microsoft.com/en-us/clarity/mobile-sdk/sdk-data-capture-rules)。

## 本次实施证据（2026-09-27）

- Web typecheck、lint、生产构建、configuration:check、测试计划格式校验及 docs:check 通过；构建包包含生产项目 ID。未执行 Web 页面和云端逐条验收。
- iOS SDK `4.1.0` 解析并锁定；Xcode 26.6 的 Debug 与 Release 模拟器构建通过。Release App 包含 `Clarity.framework`，`Info.plist` 中启用值为 `YES`、项目 ID 为 `yofefg4fsy`。共享模拟器 `0986DF97-0644-4138-847E-5BC690CFEF7E` 已安装最终 Debug 构建；启动、登录页和连接管理页可操作。任务目录为 `.runweave/mobile-qa/clarity-20260927`，租约已正常释放。
- iPhone 17（iOS 26.6.1，UDID `00008150-00195CC03E33401C`）通过设备预检；真机 Debug 构建、安装与固定只读 UI 套件运行成功，`HOME-001`、`CONNECTIONS-002`、`RETURN-003` 均通过。证据位于 `packages/app-ios/.build/ios/device/runs/68feccda-7327-4311-ab68-c6aa65dc3ea1/`；安装包包含 `Clarity.framework`，`Info.plist` 的启用值为 `YES`、项目 ID 为 `yofefg4fsy`。独立 `agent-device` 会话也打开了 App 并读到真实页面，之后输入隐藏搜索框时未获得键盘焦点，runner 随后退出；该输入未成功，不计作合成标记验收。会话已停止并释放资源。
- 随后使用共享模拟器 `0986DF97-0644-4138-847E-5BC690CFEF7E` 的独立租约 `.runweave/mobile-qa/clarity-sim-acceptance-20260927` 重建并安装当前 Debug 源码（`buildId c2d5704b-cb1d-42f2-bd6e-4ac7fda500c8`，未复用构建或安装）。实际进入登录页，在用户名和密码框分别输入唯一合成标记，打开及关闭连接管理，然后清空密码、恢复原用户名。模拟器本地 SDK 配置显示项目 ID 正确、采集已激活、已取得云端配置、存在会话 ID；后台“实时录制”中 01:50 开始的 iOS 26 会话，其 Clarity 用户标识与模拟器本地 SDK 标识相同。该会话的事件时间线出现输入点击及页面切换；登录页回放在合成输入时仅显示遮盖点，没有显示两个标记原文。云端项目再次确认 Strict。任务租约已 `finish` 正常释放。
- 上述证据证明**模拟器**默认采集、上传、实时回放及登录页合成账号/密码在所查回放帧中遮盖；没有覆盖终端、文件、图片、WebView、任务提示词或性能，也没有验证显式 `NO` 关闭构建。真机的 Clarity 会话仍没有独立回放和遮盖验收，不能把模拟器结论外推到真机。
