# 手机内置浏览器访问电脑本地服务

状态：待实施。本文记录实施方案与验收合同，不代表功能已实现或通过验收。
粒度：L2；网络权限、凭据和资源回收部分按 L3 明确约束。

## 目标与范围

用户在手机 Runweave 的终端点击 `http://localhost:3000`，直接在内置浏览器查看、操作当前电脑运行的原型。服务只监听电脑 `127.0.0.1` 时也必须可用，无需修改为 `0.0.0.0`、手工查 IP 或开放新的电脑端口。

按“跟随当前 Runweave 连接”设计：局域网及蜂窝网络均在验收范围内。跨网络的前提是用户已经有手机可达、支持 WebSocket 的 Runweave Backend 入口；本功能不新建公网穿透服务。这里的“电脑”准确指当前终端所属 Backend 主机，不推断另一个 Electron 所在主机，更不能把 SSH 会话中的远程 localhost 自动解释成那台远程机器。

支持 HTTP/HTTPS 页面、相对及绝对资源、XHR/fetch、表单、WebSocket 和开发服务器热更新；保持原 URL 的 origin、路径、query、fragment 与浏览器原有同源规则。`172.0.0.1` 不是回环地址，按普通 IP 处理，不替换成电脑地址。

非目标：`file://` 或电脑文件系统直读、自动启动开发服务、通用任意远端代理、系统级 VPN/代理、共享给 Safari 的公开链接、绕过证书/CORS/CSP、远程桌面和设备之间同步网站登录。HTML 文件需先由电脑上的 HTTP 服务提供。现有原型画廊继续使用自身静态预览能力。

## 现状依据

| 当前入口                                                                               | 当前事实与本次差异                                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalScreen.swift`          | `connectBrowserIntents()` 将正式终端链接交给 `BrowserSession.open()`；复用此入口。                                          |
| `packages/app-ios/Sources/RunweaveIOS/State/AppSession.swift`                          | `browserSource` 包含连接、终端和 generation；`closeTerminal()`/`stopResources()` 使浏览器失效。转发必须归属于相同生命周期。 |
| `packages/browser-ios/Sources/RunweaveBrowser/BrowserURLPolicy.swift`                  | 当前一律拒绝 localhost、127/8、未指定地址和 IPv6 loopback；普通私网 IP 并非一律被拒绝。                                     |
| `packages/browser-ios/Sources/RunweaveBrowser/BrowserWebView.swift`                    | WebKit 直接加载 URL，无网络转发；只改入口校验不能解决手机访问。                                                             |
| `backend/src/terminal/workspace-service/proxy.ts`                                      | 已有 HTTP/WS Host 路由，但入口仅允许本机请求。保留该边界，不能直接放开到公网。                                              |
| `backend/src/routes/prototype/preview.ts`                                              | 现有预览是带票据的项目静态文件 GET/HEAD，不覆盖任意 dev server、接口和 HMR，不能充当本功能通道。                            |
| `backend/src/server/http-upgrade-router.ts`、`backend/src/server/transport-runtime.ts` | 可以装配独立 WS 路径并统一关闭入站连接；新增能力仍须拥有和回收出站 TCP。                                                    |
| `backend/src/auth/service.ts`                                                          | 可验证 access token、查询有效 App 会话；原生 URLSession 可在 WS 握手头携带认证，无需把凭据放入网页 URL。                    |

浏览器是 Runweave 与随记共用包。随记没有电脑连接，默认仍拒绝本地地址；不得把 Runweave API 或凭据导入共享浏览器包。

## 推荐结构与首个技术门禁

```text
WKWebView：原 URL，如 http://localhost:3000
    │ WebKit HTTP CONNECT 代理，仅本地浏览会话启用
    ▼
手机 loopback 上的临时代理（随机端口、临时代理凭据）
    ├─ 电脑本地目标 → 原生认证 WS → 当前 Backend → loopback TCP 服务
    └─ 普通 HTTP(S) 目标 → 手机直接建立 TCP（不经电脑）
```

使用手机侧临时代理，是为了让电脑端只新增现有端口上的 WS 路由，兼容已有 HTTPS/WSS 入口；不要假设公网反向代理支持 HTTP CONNECT。每条 WebKit TCP 连接对应一条 WS，不在第一版实现自定义多路复用。

本地浏览会话的全部 WebKit 网络连接先进入手机代理，由它统一规范化目标并分流。这样不依赖 `matchDomains` 能否完整表达 127/8、IPv6 和 `.localhost`，也避免只改主页面却漏掉子资源、API 或 HMR。普通网站直接打开时保持现有无代理会话。

WebKit 有公开的 [`WKWebsiteDataStore.proxyConfigurations`](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations-cdc1) 和 [`ProxyConfiguration`](https://developer.apple.com/documentation/network/proxyconfiguration) API。API 存在不等于 localhost、HTTP、WS/WSS 组合已经验证。本包最低声明 iOS 15，必须使用 availability guard；不支持的系统保持明确拒绝，不擅自提高共享包部署版本。

**P0 必须先验证**：在候选宿主使用真实 WKWebView 与最小临时代理，验证 HTTP 和 HTTPS 都能经 CONNECT、localhost/IPv4/IPv6 未绕过代理、WS/WSS 能传输、普通资源可手机直连、代理认证生效、失败时不会直连手机同端口。必须用另一台物理设备与电脑区分 loopback，模拟器成功不足以证明。若任一项不成立，停止后续正式实现，记录失败组合并调整方案；不能静默降级成改 IP、注入 fetch 补丁或只代理 HTML。

## 行为与隔离合同

1. 从正式终端主动内置打开本地 URL，先取得 Backend 能力，再建立临时代理并配置 WebKit，最后加载网页。准备期间显示“正在连接电脑本地服务”；取消、切换连接或离开终端后不得补开旧页面。
2. 未启用本地会话的普通网页，不因 iframe、重定向、弹窗或脚本请求自动获得电脑访问能力。共享导航策略依据本次会话能力决定是否允许本地地址，不改成全局放开。
3. 本地会话允许页面使用不同 loopback 端口的 API；这属于用户主动打开该本地网页后授予该会话的能力，不限定到入口端口。Backend 只接受规范化后的回环目标，不能接受任意主机或 DNS 解析到私网的普通域名。
4. `localhost`、尾点形式及 `.localhost` 主机连接电脑 `127.0.0.1`，原 HTTP Host/SNI 不改写；字面 127/8 保留其规范化地址；`::1` 连接电脑 IPv6 loopback；`0.0.0.0`/`::` 作为开发服务器展示地址映射到对应族的 loopback。规范化涵盖 URL 解析器接受的短 IPv4、整数、十六进制及 IPv4-mapped IPv6，客户端与服务端必须一致。无法确定的表示拒绝，不能落回手机 loopback。
5. 正常私网 IP（如 `192.168.*`、`172.16.*`）、`172.0.0.1` 和公网域名由手机访问。本功能不保证它们在蜂窝网络可达，不进行自动 IP 改写或远程 DNS 代理。
6. 使用独立、非持久的本地浏览 `WKWebsiteDataStore`，不复用默认公网 store。收起/恢复保持本地页面、Cookie 和表单；关闭、替换会话、退出终端或切换连接后释放。电脑 A 与 B 的相同 `localhost:port` 不共享 Cookie、缓存、LocalStorage 或 Service Worker。首次本地浏览及更多菜单说明“本地预览数据仅保留至网页关闭”。普通公网会话维持现有持久数据行为；清除网页数据须覆盖当前本地 store。
7. 本地会话中的普通外部资源由手机直连，网页自己的 Cookie/Authorization 按 WebKit 原规则传输；Runweave access/refresh token、代理凭据和连接配置不得进入网站请求。保持端到端 TLS 校验，不做 MITM。
8. 完整地址及复制链接保持原始 URL。当前为本地地址时，“在默认浏览器打开”解释“此地址需要 Runweave 连接电脑”，不启动 Safari，也不复制带认证的转发 URL。普通公网 URL 仍按现有外部打开行为处理。
9. 新 Backend 与旧 App 互不影响。新 App 对旧 Backend 的能力接口 404/不支持版本提示“当前电脑版本不支持本地网页，请更新电脑端”，不反复试探、不要求修改服务监听地址。
10. 手机不在线、目标端口拒绝连接、超时、代理失效和证书错误给出可区分提示，保留原目标以供重试。网络恢复后不自动重放已发送请求，不重放 POST/上传；用户主动重试只重新加载当前页面，表单重提交流程由 WebKit 处理。

## 拟新增接口（协议版本 1）

以下为实施合同，路径和字段尚不存在。DTO 放 `packages/shared/src/browser/local-tunnel.ts`，Swift 对照定义；不导入 TS 实现。

| 接口                                  | 输入、输出与边界                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/browser/local/capabilities` | 沿用原生 App Bearer 与现有入口认证。返回 `{ protocolVersion: 1, maxConnections: 32, maxFrameBytes: 65536 }`。能力就绪才返回 200；功能关闭返回 503 与 `local_browser_disabled`。                                                                    |
| `GET /ws/browser-local` 的 WS Upgrade | 原生 URLRequest 发送 `Authorization: Bearer …`；URL 无 token。校验现有 tunnel-auth，access token 及 `getActiveAppSession()`，拒绝网页来源的 Origin 握手。Backend 不信任客户端传入的 owner 或连接身份。                                             |
| 首帧 `open`                           | 文本 JSON `{ type: "open", version: 1, terminalSessionId, browserSessionId, host, port }`，5 秒内必须到达且最多 2 KiB。会话必须仍有效，终端存在且通过现有终端可访问性检查；host 为白名单本地目标，port 是 1–65535 的整数。每条 WS 只允许一个目标。 |
| `ready` / `error`                     | 成功建立 TCP 后返回 `{ type: "ready" }`，之前不向 WebKit报告 CONNECT 成功、不发送网页字节。失败返回 `{ type: "error", code }` 后关闭；不返回系统堆栈、原始请求或凭据。                                                                             |
| 数据与结束                            | ready 后仅二进制帧传输原始 TCP 字节，每帧至多 64 KiB；使用明确的 `eof` 控制帧表示单向结束，待队列排空再半关闭对应 TCP。协议错误、取消或不可恢复错误关闭整条通道；不能靠重建连接重放已发送字节。                                                    |

错误码固定为 `unsupported_version`、`invalid_target`、`unauthorized`、`source_unavailable`、`target_unavailable`、`connect_timeout`、`connection_limit`、`protocol_error`、`buffer_limit`。升级前使用 HTTP 400/401/403/429/503；升级后用错误帧，不把失败伪装成目标站点的 200。

凭据只由 Runweave `APIClient` 创建原生 WS 请求时注入；共享浏览器只接收手机代理地址和本例临时代理凭据。手机代理只监听 loopback，代理凭据每个本地会话重建并检查 CONNECT 认证；普通网页无法读取它。远程入口沿用用户已有连接的 TLS 策略，公网验收使用 HTTPS/WSS。

资源上限：每个有效 App 认证会话最多 32 条活动远程通道，目标 TCP 连接超时 10 秒；每方向积压数据最多 1 MiB，采用背压且超过上限关闭，不持续缓存整个响应。原生侧每 15 秒进行 WS 心跳，45 秒无响应关闭。Backend 每 5 秒重新检查所属认证会话与终端有效性，撤销后至多 5 秒关闭全部关联通道；现有 access token 到期不单独切断已建立连接，新建通道须经 APIClient 正常刷新认证后再握手。

## 实施任务与文件范围

### P0：用真实设备证明传输路径

- [ ] 新建 `scripts/verify/browser-local/fixture.ts`：仅启动本任务拥有的服务，输出 manifest、PID、端口及脱敏请求记录；支持 loopback IPv4/IPv6、echo API、重定向、长响应和 WS。添加固定 Vite 示例目录 `scripts/verify/browser-local/vite-fixture/`，使用锁定版本验证真实 HMR，不以自制 WS 消息冒充 HMR。
- [ ] fixture manifest 包含 runId、backendId、各 listener 的绑定地址/端口、页面与 API URL、请求日志路径、清理信息；页面显示 runId/host/port/加载次数和操作结果。手机同端口的诱饵服务须由独立、明确归属的设备端 fixture 提供，不能依赖执行机 curl 冒充手机。
- [ ] 在原生试验入口验证上文 P0 组合，保存原生操作证据和服务端连接记录。仅使用公开 WebKit/Network API。成功后再执行 P1；失败报告必须注明 OS、设备、URL 组合和实际请求落点。

### P1：Backend 通道与共享协议

- [ ] 新建 `packages/shared/src/browser/local-tunnel.ts` 并增加 `package.json` 显式子路径 export；定义帧、错误码和能力 DTO。
- [ ] 新建 `backend/src/browser-local/target.ts`、`manager.ts`：目标规范化、会话/socket owner、限流、背压、超时及 dispose；普通域名拒绝解析转发，`.localhost` 直接映射字面 loopback。
- [ ] 新建 `backend/src/routes/browser-local.ts`、`backend/src/ws/browser-local-server.ts`：仅完成鉴权、校验、协议装配和错误映射；复用 `AuthService`，不添加另一套长期 token 存储。
- [ ] 修改 `backend/src/bootstrap/runtime-services.ts`、`backend/src/index.ts`：注册资源立即登记清理，接入现有 UpgradeRouter 与 TransportRuntime。新能力使用启动配置 `RUNWEAVE_BROWSER_LOCAL_ENABLED=0` 可关闭，默认启用；关闭时不注册可用通道。
- [ ] 新建 `scripts/verify/browser-local/verify.ts`，通过真实隔离 Backend + TCP/WS fixture 验证协议、鉴权、断开及资源释放。它是集成 verifier，不新增单元测试文件。脚本自行隔离安装态 worker 环境，不占用用户终端，不修改已有 Workspace Service 代理入口策略。

P1 验收：未授权不能连到目标；完整字节流、半关闭及错误可观察；取消和 Backend dispose 后没有剩余本任务 TCP/WS/计时器。

### P2：原生转发与共享浏览器能力注入

- [ ] 新建 `packages/app-ios/Sources/RunweaveIOS/Contracts/BrowserLocalTunnel.swift`、`Services/BrowserLocalTunnel.swift`、`Services/BrowserLoopbackProxy.swift`：Swift DTO、WS↔TCP 流及临时 CONNECT 代理。对普通外部目标执行手机侧直连；双向背压和取消同样生效。
- [ ] 修改 `Services/APIClient.swift`：能力读取、原生 WS 握手请求构造和认证刷新。认证头不返回给网页、不会复制到被代理站点；业务请求发送后不自动重试。
- [ ] 修改 `State/AppSession.swift`：本地转发 owner 绑定 `browserSource` 与 generation。打开期间失效立即取消；登出、切换、关闭终端同步阻断新请求，异步等待旧资源关闭。远端异常不能使旧 source 重新生效。
- [ ] 修改共享包 `BrowserHost.swift`、`BrowserSession.swift`：增加宿主提供的可选网络准备/释放接口，仅返回代理配置及会话身份；默认 nil，随记无需提供。先配置好 store 再创建/加载 WebView；由会话持有网络 lease，页面退役与清数据完成前不复用它。
- [ ] 修改共享包 `BrowserURLPolicy.swift`、`BrowserWebView.swift`：按会话能力检查所有主导航、重定向、子框架和新窗口入口；本地会话使用独立非持久 store。代理失败时关闭通道且禁止回退手机直连。低版本保持拒绝。

P2 验收：电脑只监听 loopback 时，真机仍能加载页面、API 和 WS；电脑 A/B 的同 origin 数据与迟到回调隔离；随记仍可使用既有浏览器。

### P3：用户行为与兼容收口

- [ ] 修改 `BrowserScreen.swift` 与必要的会话错误状态：准备、失败、重试、数据生命周期说明和本地 URL 外部打开提示；保留单页浏览器入口、回终端及原地址展示，不新增连接配置页。
- [ ] 核对新旧客户端/Backend 组合，功能关闭时保持现有终端及公网浏览可用。
- [ ] 实现同时更新既有 `ios-native-browser-safety.testplan.yaml`：`IOSBSAFE-010` 改为无本地能力时仍拒绝；`IOSBSAFE-004` 的 loopback 子框架断言限定普通无代理会话。将“拒绝所有 localhost”迁移为条件合同，其他协议限制不变。本轮保留原文件描述现状，新测试文件明确为待实现合同。
- [ ] 更新 `packages/browser-ios/README.md`、`packages/app-ios/README.md` 与 `docs/architecture/app-mobile.md` 的当前事实，尤其说明临时网站数据及 Backend 主机语义；实现完成后按文档治理删除本临时计划，测试计划保留。

### P4：执行验收与交付证据

- [ ] 执行下面静态命令，再按两份 YAML 用例执行真实协议与原生验收。失败或环境阻塞逐条记录，不用编译通过代替手机证据。
- [ ] 回归现有公网浏览、导航安全、随记共享浏览器与 Workspace Services。两宿主均构建并原生验收；保持已有工作区改动，不提交其他任务的模拟器池或 iOS 脚本修改。
- [ ] 保存所测 commit/未提交源码摘要、App 二进制、设备/OS、Backend 入口、fixture runId 和逐例证据。不得在报告中输出 token、代理密码、完整敏感 URL 或网页正文。

## 验证入口与通过条件

新增验收合同（待功能实现后执行，共 33 条 required 用例）：

- [访问与网页行为](../testing/app/ios-local-browser.testplan.yaml)：HTTP、地址族、资源、接口、表单、HMR、TLS、跨网络及兼容。
- [授权与生命周期](../testing/app/ios-local-browser-lifecycle.testplan.yaml)：鉴权、目标边界、凭据、连接隔离、竞态、断网、撤销、回收与宿主回归。

实施后执行，当前不存在的 verifier 在 P1 创建：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm architecture:check
pnpm --dir backend exec tsx ../scripts/verify/browser-local/verify.ts
pnpm backend:verify-lifecycle
pnpm workspace-services:verify
pnpm testplan:validate docs/testing/app/ios-local-browser.testplan.yaml
pnpm testplan:validate docs/testing/app/ios-local-browser-lifecycle.testplan.yaml
pnpm docs:check
```

命令均须退出 0。原生先按各包 README 与[模拟器池规则](../cli/ios-simulators.md)取得可用设备，再分别执行两个包的 `node scripts/ios.mjs build --simulator <已取得的UDID> --configuration Debug` 和 Release；构建日志需证明共享浏览器和新 Swift 源码进入编译。实际安装、交互使用 `$toolkit:agent-device`，固定 XCTest 按既有入口；网页 fixture 预检使用 `$toolkit:playwright-cli`。需要启动/检查 Dev Session 时先使用 `$toolkit:runweave-dev-session`。

全部新增 required 用例通过，才可宣称完整能力完成。至少保留一组真机“电脑仅监听 127.0.0.1”和一组关闭手机 Wi-Fi 后经 HTTPS/WSS 连接电脑的证据。没有公网入口、蜂窝网络或真机时，对应例记 blocked，不能以模拟器或同网替代。既有公网浏览计划重点回归历史、收起/恢复、表单、连接失效；导航安全回归凭据、TLS、外部打开与清数据；随记执行其 required 浏览器合同。

## 风险、兼容与回滚

- 核心风险是 WebKit 是否对 loopback、HTTP 和 WS 一致使用公开代理能力，由 P0 阻止错误路线扩大。
- 转发保留原始 HTTP origin，不替应用修复 CORS/CSP 或无效证书。跨端口示例须自行声明正确 CORS；反向断言也要证明非法跨域未被绕过。
- 原始 TCP 隧道让本地页面可访问当前电脑的 loopback 服务，因此只有用户主动开启的本地会话持有能力；Backend 限制回环目标并保持其自身 API 鉴权。不能把普通站点的请求自动升级成有宿主凭据的请求。
- 原型流量可能很大，必须验证流式传输、背压和关闭，不允许完整响应缓存在手机内存。WebKit/WebSocket 的半关闭与取消顺序要用真实 EOF 验证。
- 既有入口可能经过反向代理；公网验收检查 WSS、原生认证头透传及入口认证，不能绕过现有 tunnel-auth。
- 无数据库迁移，不改变服务进程监听地址。回滚为关闭 Backend 功能开关并重启，或回退客户端/Backend 版本；正在浏览的本地页显示断开，普通公网浏览和终端不受影响。短期本地 store 随会话释放，不迁移到默认 store。
