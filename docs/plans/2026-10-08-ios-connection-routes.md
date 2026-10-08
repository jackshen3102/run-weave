# iPhone 同一电脑多线路连接实施计划

状态：核心实现已落地；按用户最新要求取消旧配置迁移，Stable Backend 和保存的 iPhone 已更新，真机重新录入配置与冷启动保存已验证；完整验收矩阵和真机跨网络验证仍待执行，结果见 [iOS 验收状态](../../packages/app-ios/docs/validation-status.md)。粒度：L3，涉及凭据保护、并发请求与连接恢复。

## 1. 目标与边界

iPhone 中的一台 Runweave 电脑可以保存家里 Wi-Fi、公司 Wi-Fi、已有 Devbox SSH 隧道等多条访问地址，按优先级自动连接或固定一条线路。换线路不改变当前电脑、当前终端与未发送草稿。

本轮只覆盖原生 iOS 的 Runweave Backend 连接及其必要 Backend 协议。不同电脑继续手动选择，不自动跨电脑切换。不修改 RemoteDesk、桌面/Web 的连接管理，不创建 SSH 隧道，不实现地址自动发现、线路测速竞赛或跨电脑数据合并，不调整监听地址、TLS、ATS 或隧道认证策略。

产品界面采用 [多线路原型](../prototypes/ios-connection-routes/README.md) 的信息层级与行为：连接管理 → 电脑 → 连接线路。原型截图是浏览器模拟界面；真实实现使用 SwiftUI，不复制 HTML/JS，不引入场景参数、虚构数据和手机外框。

用户已要求按该原型编写计划；以当前原型作为本计划的交互基准。后续若调整核心行为，应同步更新原型与本计划。原型没有覆盖的凭据与并发行为以本文为准。

## 2. 已核实的代码现状

| 代码                                                                                                 | 当前事实                                                                                  | 本次差异                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/app-ios/Sources/RunweaveIOS/State/ConnectionStore.swift`                                   | `BackendConnection` 只有一个 `url`，`scope = id + NUL + url`；选择保存 `activeID`         | 稳定电脑身份与可变线路分离                             |
| `State/DevicePreferences.swift`（下文 Swift 相对路径均相对 `packages/app-ios/Sources/RunweaveIOS/`） | 配置保存在 `native.connections.v1`                                                        | 保留旧数据，使用版本化新存储                           |
| `Services/APIClient.swift`、`State/CredentialStore.swift`                                            | Keychain account 为连接 ID 与 URL 摘要；APIClient 固定 URL，并各自持有 token、refreshTask | 共享同一电脑的认证所有者，线路更换不复制 refresh token |
| `App/RootView.swift`                                                                                 | `.id(active.scope)` 和 `.task(id: active.scope)` 会在地址变化后重建页面并 activate        | 电脑切换与线路替换使用不同 revision                    |
| `State/AppSession.swift`                                                                             | activate 清理请求、事件与终端资源，重新加载 scope 对应草稿                                | 同电脑换线路不走整套电脑切换逻辑                       |
| `State/AppSession+Network.swift`、`Services/DeviceHealthService.swift`                               | 只检测当前 URL；探测超时 2.5 秒；离线间隔 5/15/30 秒                                      | 一个按顺序选择线路的协调器接管恢复                     |
| `Features/Terminal/SessionController.swift`                                                          | `private let api` 固定；包含 SwiftTerm surface、resume cursor 与输入任务                  | 保留终端显示对象，替换其传输并隔离迟到结果             |
| `State/ConnectionDraftArchive.swift`                                                                 | 文本、图片按 scope 摘要落盘                                                               | 按电脑稳定 scope 读写；旧归档不导入                    |
| `Services/NotificationCoordinator.swift`                                                             | scope 下保存订阅，多个路径自行创建 APIClient                                              | 按电脑去重，统一经过线路解析与认证所有者               |
| `backend/src/server/health.ts`                                                                       | health 的 serviceInstanceId 表示 Backend 运行实例，不是可信持久身份                       | 不能把 health 200 或该字段用作多线路身份认证           |
| `backend/src/device-monitor/store.ts`                                                                | 已有持久 hostId，但属于可选设备监控能力                                                   | 不把电量/推送 UUID 当作可验证的 Backend 身份           |

现有认证、事件、终端恢复能力可以复用；多线路模型、可信目标检查与保持页面的线路替换是新增能力。

## 3. 产品行为合同

### 3.1 线路与输入

- 电脑保留稳定本地 ID、用户名称与创建时间。线路保存独立 ID、名称、完整 HTTP(S) URL；数组顺序就是优先级，不再保存第二份 priority 数字。
- 新线路追加末尾；拖动排序立即持久化，不改变当前已建立连接。编辑名称不重连。
- URL 规范化复用现有 scheme/host 小写、移除末尾斜杠、保留路径前缀的行为；新编辑拒绝非 HTTP(S)、userinfo、query、fragment。旧记录不导入，由用户重新录入。
- 同一电脑内规范化 URL 不得重复。允许两台电脑记录相同文本地址，因为它们可能在不同网络；不能据此合并电脑、凭据或草稿。
- 允许保存暂时不可达的地址，标为“尚未验证”；首次连接必须通过目标检查后才携带认证。保存成功不等于线路可用。
- 删除非当前线路不影响连接。删除当前线路前提示将断开：自动模式立即尝试余下线路；手动模式清空固定项并显示“请选择线路”，不隐式固定另一条。删光线路保留电脑、登录与草稿，显示添加入口。删除整台电脑沿用现有明确确认流程。
- 修改当前线路 URL 视为替换地址：取消旧传输并重新验证新地址，保持电脑和草稿；自动模式立即重新选路，手动模式重新尝试该线路。配置保存失败不采用新地址。

### 3.2 自动与手动

| 触发                          | 自动模式                                         | 手动模式                 |
| ----------------------------- | ------------------------------------------------ | ------------------------ |
| 冷启动或切入电脑              | 从第一条开始尝试，不优先上次成功线路             | 只尝试固定线路           |
| 已连接，排序变化/其他线路恢复 | 保持当前线路                                     | 保持固定线路             |
| 当前线路网络失败              | 从第一条重新选择                                 | 只重试固定线路           |
| 用户点击重新选择/重新连接     | 从第一条开始                                     | 只尝试固定线路           |
| 自动切为手动                  | 固定当前成功线路，不中断；无成功线路则等用户选择 | —                        |
| 手动切回自动                  | 立即按顺序重新选择                               | —                        |
| 所有候选失败                  | 保留页面、登录和草稿；显示各线路原因             | 显示固定线路原因，不回退 |

显示“正在尝试 名称 · i/n”，顺序串行，遇到第一个通过身份与认证检查的线路就停止；不用并行竞速改变优先级。

每条线路无凭据目标探测总预算 2.5 秒；已验证目标的认证确认最多另用 5 秒。三条线路前两条不可达时，第三条应在约 5 秒加调度开销内开始，不能叠加 health 和身份两套独立 2.5 秒等待。超过预算取消本次请求；即使取消回调较晚，revision 也必须拒绝结果。

一次全部失败后沿用 5、15、30 秒，之后每 30 秒重试；网络路径变化与用户主动操作可提前触发。前台同一电脑最多一轮选路，后台不新建探测，不重放离线输入。回前台先验证当前线路；仍可用则保持，否则按模式恢复。NWPathMonitor 只触发验证，不直接决定在线状态。

网络/超时/5xx、目标身份不符、旧协议分别显示不同线路原因。单个业务资源的 403/404 不触发全局选路。通过身份校验后确认 refresh 已撤销是电脑级登录失效：停止轮询换路、要求重新登录，不能把认证错误隐藏成网络失败。

## 4. 数据、身份与认证设计

### 4.1 iOS 本地对象

```text
StoredConnectionsV2 { schemaVersion: 2, computers: [Computer], activeComputerID? }
Computer {
  id, name, createdAt,
  routes: [ConnectionRoute],
  selection: automatic | fixed(routeID?),
  trust: { identityId, publicKey }?,
  credentialAccount
}
ConnectionRoute { id, name, url }
RouteRuntime {
  activeRouteID?, statusByRouteID,
  selectionRevision, transportGeneration
}
```

`trust` 的持久版本存于 Keychain 的电脑认证记录，配置可保留非秘密标识，但不得只相信 UserDefaults 中可被替换的公钥。`credentialAccount` 使用电脑稳定 ID；由用户重新登录，新电脑使用新稳定 account，不引用旧连接的 token。诊断仍区分电脑 ID、线路 ID 与 attemptId，不再让诊断 ID 同时充当凭据键。

运行状态与延迟不作为配置持久化来源。`activeRouteID` 仅为显示/恢复提示，不改变冷启动的优先级规则。

新增 `ComputerCredentialSession` actor：每台电脑只创建一个、集中持有 token、authEpoch 和单个 refreshTask。APIClient 只负责绑定已验证 URL 的 HTTP 传输，获取 token、更新 token、清理 token 全部走该 actor。通知、额度、电量和主界面不能各自创建独立 refresh owner。

同电脑线路切换只增加 transportGeneration，登录/退出增加 authEpoch，切换电脑增加 session generation。旧线路请求与刷新成功结果的处理分开：旧业务响应不能更新新页面；已经被服务端接受的 refresh 成功结果仍须由认证 actor 持久化，不能因线路切换丢弃已轮换 token。

### 4.2 最小 Backend 身份协议

仅比较 UUID 或 serviceInstanceId 不足以判断响应者持有同一电脑身份。计划新增独立 Ed25519 身份密钥，每个 Backend 配置实例持久保存一份；不复用 JWT secret，也不依赖设备监控开启。物理上同一 Mac 的 Stable/Beta/Dev 属于不同 Backend 身份。

存储位置使用 `resolveStoragePaths().browserProfileDir` 下 `connection-identity.json`，包含 schemaVersion、私钥和对应公钥。目录 0700、文件 0600；启动时利用既有 profile 单实例约束，原子首次创建，不在每次重启时重新生成。文件损坏或不匹配时让身份能力返回不可用，保留原文件和旧单线路服务，不静默重置可信身份。复制整个 profile 也会复制身份，属于同一受信任实例副本，不能宣称硬件唯一性。

新合同放在 `packages/shared/src/auth/connection-identity.ts`，经 `./connection-identity` 子路径导出；Swift 在 `Contracts/ConnectionIdentity.swift` 手动对照：

| 请求                           | 权限与输入                                                                                                                                 | 输出与规则                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `GET /api/connection/identity` | 现有 requireTunnelAuth + app/web Bearer 鉴权；仅从用户已经登录并选定的原线路读取                                                           | `{ version:1, identityId, publicKey }`；用于第一次建立信任                       |
| `POST /api/connection/probe`   | requireTunnelAuth 保持原策略；不携带 app Bearer、refresh token 或 Cookie；JSON `{version:1,nonce}`，nonce 为随机 32 字节的无填充 base64url | `{version:1,identityId,publicKey,nonce,signature}`；无状态签名证明服务拥有该私钥 |

`publicKey` 为 Ed25519 原始 32 字节，无填充 base64url；`identityId` 为公钥 SHA-256 的小写 hex。签名字节固定为 UTF-8 `runweave-connection-probe-v1\n<identityId>\n<nonce>`，signature 为 64 字节 Ed25519 签名的无填充 base64url。客户端生成新 nonce，严格比较 version、identityId、公钥与 nonce，并用固定公钥验签；每次重连重新验证。随机数不得来自日期或递增计数。请求体上限 1 KiB、响应上限 4 KiB；返回 no-store；按现有客户端 IP 口径限制每分钟 120 次，超限返回 429，不信任任意转发头绕过限流。

接口错误使用稳定 code：400 `CONNECTION_PROBE_INVALID_REQUEST`、401 `CONNECTION_IDENTITY_AUTH_REQUIRED`（仅 bootstrap）、429 `CONNECTION_PROBE_RATE_LIMITED`、503 `CONNECTION_IDENTITY_UNAVAILABLE`。客户端另外区分 `unsupported`、`timeout`、`identityMismatch`、`invalidProof`、`redirectRejected` 与 `loginRequired`；不得将不同原因全部折叠为离线。未通过证明的 401 属于隧道/目标访问问题，不用于清理电脑认证。

身份 bootstrap 只来自原来明确登录过的线路；未登录电脑先沿用原登录/扫码流程。旧 Backend 返回 404/不支持时，保留单线路模式，提示需升级电脑端才能启用多线路，不能伪造 trust。新增候选返回另一个公钥时禁止覆盖 trust，必须提示目标身份不符。身份重置后不能点一次重试自动信任新目标；需要用户重新登录/扫码确认电脑并重新建立绑定。

通过无凭据证明后才允许给候选地址发送现有 `/api/auth/verify`，必要时由共享 actor 执行 refresh。原有 URL 上的已登录单线路兼容路径继续可用。首次给旧电脑启用多线路前，必须完成身份绑定；增加线路时不能从新增地址反向覆盖电脑身份。

**安全边界**：这解决误指向其他 Backend、IP 被重新分配及伪造明文身份字段；签名不代替 TLS，也不提供对明文 HTTP 中主动转发攻击的完整防护。沿用现有显式局域网 HTTP 信任边界；公网应使用有效 HTTPS 或既有受信任隧道，不放开 ATS、不绕过证书验证。任何探测、认证或业务请求禁止跨 origin/路径根的自动重定向，避免在目标验证之后再转发凭据。

### 4.3 认证与刷新结果不确定

- 换线路前阻止旧传输发起新的 refresh；若已有 refresh 在途，由电脑认证 actor 等待其已发请求收敛，不创建第二个 refresh，也不复制 token 给另一 actor。
- refresh 明确成功则写入 Keychain 后恢复新线路。明确 401 才执行该电脑的认证失效清理。
- refresh 请求已发出但响应丢失时，不向新线路自动重放同一个 refresh：现有服务会轮换 refresh session，无法把“没有收到响应”视为“没有执行”。保留草稿与旧凭据记录，提示重新登录恢复；不自动撤销其他电脑或排队业务写入。本期不扩展 Backend refresh 幂等协议。
- 待发送文本/图片草稿保留；已发但未确认的业务写入保持“结果未知/需用户确认”，不在切路时自动重试。只读刷新和重新建立事件/socket 可以重试。

## 5. 重新录入与兼容

用户已确认不需要旧数据迁移，由用户自行重新录入；这取代原计划的全部迁移要求。

1. 只读取和保存 `native.connections.v2`；不存在时显示空电脑列表。旧 v1、Keychain 和草稿不导入、不删除。v2 损坏时显示错误，不静默回退。
2. 用户重新添加电脑、线路并登录。每台新电脑使用稳定 ID、独立凭据和草稿 scope，不按名字或地址自动合并旧记录。
3. 旧通知归档保留解码兼容以免阻断新的提醒设置，但不重写绑定或把旧电脑发布为新配置。新电脑提醒由用户重新开启。
4. 扫码沿用现有批准和凭据补偿合同，不自动合并电脑；新增线路仍需身份一致。
5. 先更新具备身份协议的 Backend，再更新 iOS。旧 Backend 仅支持用户明确登录地址的单线路，不跨地址发送 token。
6. Backend 回退保留身份文件；旧版 iOS 仅看到其原有数据，新版新增配置不倒灌。

## 6. 同电脑切路的运行时边界

新增 `ConnectionRouteResolver` 负责选路、探测、取消和原因，不接管终端业务状态。输入为电脑配置快照、模式、foreground 与 trigger；输出为经身份校验的 endpoint 或分线路失败列表。UI、网络恢复与旁路读请求复用同一电脑 resolver，不互相启动独立的切路循环。

`AppSession.activateComputer` 保留跨电脑清理语义；新增 `replaceTransport` 执行同电脑换路：

1. 冻结写入，保存未发送草稿；递增 transportGeneration，取消旧只读任务和事件/终端连接；不关闭 terminal route、不清空 overview、不更换 SwiftTerm surface。
2. 选出可信线路，并完成共享认证 actor 的在途 refresh 收敛。已打开的详情、预览、上传任务持有的旧 APIClient 全部失效，不能继续向旧 URL 写入。
3. 创建新 URL 传输，替换 Home 事件流和终端 controller 的 transport；保留 terminal ID、resumeClientID、有效输出游标和显示内容。新 streamId/失效游标依现有协议请求权威快照，不能简单拼接重复输出。
4. 对当前电脑重读 overview、权限及当前终端；取得认证与有效终端快照后才恢复写入。终端 404 展示资源已删除，不创建替代终端。旧 generation 的错误、认证回调和事件不能覆盖新状态。
5. 若全部不可达，保留只读内容、导航与草稿并显示离线；后台停止恢复，前台按退避继续。换电脑则仍彻底隔离内容，不把同电脑保留逻辑推广到跨电脑。

后台通知任务不主动启动选路，沿用现有 iOS 生命周期限制；用户点击通知回前台后，按电脑绑定解析线路。通知、电量、额度等请求必须使用共享认证 provider 和已验证 endpoint，不能直接从第一条 URL 构造旁路 APIClient。

## 7. 分阶段任务与文件范围

所有路径在实施前重新核对工作区差异；保留本次原型及其他用户改动。不新增单元测试，不顺手重构无关业务。

### A. Backend 身份能力与共享合同

- [x] 新增 `packages/shared/src/auth/connection-identity.ts`、修改其 `package.json` 子路径 exports；冻结序列化、签名字节、失败码与大小限制。
- [x] 新增 `backend/src/auth/connection-identity.ts`：密钥加载/原子创建、签名和异常分类；实例路径来自现有 storage profile，不引入另一份全局配置。
- [x] 新增 `backend/src/routes/connection-identity.ts`：输入校验、限流、Cache-Control、权限映射。修改 `backend/src/bootstrap/runtime-services.ts` 组合服务、`backend/src/index.ts` 挂载路由；损坏时身份能力 fail closed，旧单线路不被错误替换。
- [ ] 验证：独占测试 Backend 的重启、公钥稳定性、坏文件保留、不同 profile 身份隔离、正确与错误 nonce/签名；详见身份用例。不得拿正常 health 响应代替通过。

### B. iOS 模型、认证所有者与重新录入

- [x] 修改 `State/ConnectionStore.swift`、`State/DevicePreferences.swift`，增加版本化电脑/线路模型与一致保存；只读取 v2，不导入旧配置。
- [x] 新增 `State/ComputerCredentialSession.swift`；调整 `State/CredentialStore.swift` 和 `Services/APIClient.swift` 的认证所有权。保留现有 Keychain service 与原账户读取，不因切路轮换本地电脑 ID。
- [x] 修改 `State/ConnectionDraftArchive.swift`、`State/AppSession+DraftArchive.swift`：稳定 scope 与受保护归档，读取失败不覆盖旧文件。
- [x] 修改 `Features/Connections/MobileLoginController.swift`、`Services/MobileLoginClient.swift` 与 `Contracts/MobileLogin.swift` 的消费流程；优先复用现有 QR v1 与已认证 identity 读取，不扩大桌面二维码 UI 范围。
- [ ] 验证：重新录入与冷启动保持、未登录记录、多电脑隔离、并发 refresh 与响应未知分支；详见身份用例。

### C. 选路与传输替换

- [x] 新增 `Contracts/ConnectionIdentity.swift`、`Services/ConnectionIdentityClient.swift` 与 `State/ConnectionRouteResolver.swift`，实现无凭据证明、预算、顺序、取消、reason 与旧协议降级。
- [x] 修改 `State/AppSession.swift`、`State/AppSession+Network.swift`、`Services/DeviceHealthService.swift` 与 `App/RootView.swift`：区分电脑身份、配置 revision、传输 generation；移除随 URL 重建整棵页面的绑定。
- [x] 修改 `Features/Terminal/SessionController.swift`、`Features/Terminal/EventStream.swift`、`State/TerminalOverviewEvents.swift`，保留 surface/路由并恢复 socket；跨 stream 重新同步，不补发输入。
- [x] 搜索并接入所有 `APIClient(base:)` 和 `connection.scope/url` 消费者，重点核对 `Services/NotificationCoordinator.swift`、`Features/Connections/DeviceBatteryView.swift`、`State/CodexQuotaStore.swift`、`State/BackendQuickInputModel.swift` 以及 AppSession 的输入、浏览器、计划任务扩展。只改连接依赖，不改各业务规则。
- [ ] 验证：在真实 iOS 上做同电脑 Wi-Fi/转发线路切换，保存 terminal ID、草稿与服务端 marker 证据；排序不抢切，手动不回退，后台无探测；详见连接行为用例。

### D. SwiftUI 界面

- [x] `Features/Connections/ConnectionManager.swift` 保留现有扫码、快捷指令、配置、额度、外观入口；电脑条目进入线路页，不把整套设置全部重新设计。
- [x] 新增 `Features/Connections/ConnectionRoutesView.swift`、`ConnectionRouteEditor.swift`，实现原型中的当前连接卡片、模式选择、排序、行菜单、添加/编辑表单及删除确认。
- [x] 补原型未体现的真实状态：无线路、未验证、等待手动选择、Backend 需升级、登录失效、存储错误；不显示签名、generation 等实现细节。
- [x] 使用原生可访问性标识与 VoiceOver 标签；拖动排序保留可访问的上移/下移操作。只在重连中的受影响操作上禁用，不阻止用户切换模式或离开页面。
- [ ] 验证：真机/共享模拟器 UI 操作与原型对照；键盘不遮挡保存，长域名可读，小屏无横向溢出；浏览器原型通过不算原生验收。

### E. 文档、验收与交付

- [ ] 更新 `packages/app-ios/docs/architecture.md`、`docs/architecture/app-mobile.md`、`packages/app-ios/docs/validation-status.md`，记录最终实现和真实验收边界；本计划完成后按文档治理迁移长期事实并删除过程计划。
- [ ] 以本轮新增 YAML 为行为门禁，并选择复用现有会话、草稿、终端、图片、推送及扫码合同。通过完整静态检查后执行原生行为验收，不新增单元测试文件。
- [ ] 独立报告代码、构建、安装、启动、模拟器 UI、真机网络切换各层结果。未获得真机网络条件时保留该项未验收，不能用代理 fixture 替代实网结论。
- [ ] 用户已授权实现及本地构建验证；尚未授权正式 iPhone 更新、提交或合并。随记只追加最终成功成果，未经确认不标记完成。

## 8. 验收入口与执行命令

新增两份验收计划：

- [线路选择与会话恢复](../testing/app/ios-connection-routes.testplan.yaml)：顺序、手动、编辑、持续会话、网络路径、请求竞态及 UI。
- [目标身份与重新录入](../testing/app/ios-connection-identity.testplan.yaml)：身份协议、凭据保护、旧协议、重新录入、refresh 与重启边界。

既有回归按受影响行为执行：`ios-native-session.testplan.yaml` 的 001–012、014–015，`ios-native-draft-privacy.testplan.yaml`、`ios-native-image-attachments.testplan.yaml`、`mobile-qr-login-protocol.testplan.yaml`、`mobile-qr-login.testplan.yaml`、`push-notifications.testplan.yaml`。其中 IOSSESSION-014 新增 URL 的 query/hash 预期须在实施时同步改为新编辑拒绝；旧数据不导入，归重新录入用例，不能留下互相冲突的门禁。

实施后的静态命令（本次计划阶段不执行产品构建）：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm architecture:check
pnpm backend:verify-lifecycle
pnpm docs:check
pnpm testplan:validate docs/testing/app/ios-connection-routes.testplan.yaml
pnpm testplan:validate docs/testing/app/ios-connection-identity.testplan.yaml
git diff --check
```

预期全部退出 0；不可将 lint/typecheck 成功报告为联网或原生 UI 成功。模拟器从 [共享池](../cli/ios-simulators.md) 获取当前可用 UDID 与独立 task-dir，再按 `packages/app-ios/README.md` 执行：

```bash
node scripts/ios-simulators/cli.mjs status --json
node scripts/ios-simulators/cli.mjs start --app runweave --task-dir "$PWD/.runweave/mobile-qa/ios-connection-routes-<本次唯一标识>"
```

在 `packages/app-ios` 内：`node scripts/ios.mjs doctor`、`node scripts/ios.mjs build --simulator <本次UDID> --configuration Debug`，随后按共享池文档用同一 task-dir 执行 run、agent-device 和 finish。不创建/克隆设备，不操作他人 lease。真实 Backend 环境使用授权的独占 fixture；实际启动 Dev Session 时加载对应技能。正式执行 YAML 使用 `toolkit:run-test-cases`，原生交互使用 `toolkit:agent-device`。

每个验收 case 独立建立 fixture，保留源码版本、安装版本、电脑/线路匿名 ID、结果时间、脱敏请求计数与 UI 截图。不得记录完整 token、refresh token、私钥、用户输入正文；无凭据请求可记录是否带认证头的布尔值。任何出现错误目标收到凭据、用户草稿丢失、跨电脑串数据、输入重放或手动静默回退，立即判定失败并停止该批。

## 9. 本计划的完成标准

计划中的行为、协议与存储规则有明确落点；两个 YAML 通过格式校验。此标准仅说明计划可交给实现者执行。功能完成必须另外满足 A–E 与真实验收，不以原型的 16 项浏览器检查代替。
