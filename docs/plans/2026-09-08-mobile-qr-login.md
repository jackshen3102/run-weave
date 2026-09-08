# iOS 扫码登录当前电脑：实施计划

状态：实现已落地，跨端验收未全量完成。粒度：L3（跨端认证、并发与凭据持久化）。

已完成 shared/backend/frontend 类型与 lint、架构检查、Simulator/真机 Debug 构建、真实桌面确认状态、
真机扫码入口与权限/取消检查，以及 MQP-001～009。MQP-010 已验证外部限流与容量行为，内部表观测待补。
真实相机扫码主链和其余故障/生命周期用例仍待验收；本机证据见 `.runweave/mobile-qr-login-evidence/REPORT.md`。

## 1. 已确认的产品合同

在手机已能访问目标 Backend 的网络条件下，提供以下闭环：

1. 用户在 Electron 桌面登录现有账号，在“当前连接”菜单点击“连接手机”。
2. 弹窗固定展示打开时所选电脑的名称和二维码。
3. iOS App 内点击“扫码连接电脑”，扫码后显示“等待电脑确认”。
4. 桌面展示该手机的登录请求，用户点击“允许登录”。
5. Backend 为手机建立同一账号下的独立登录会话；手机保存连接与凭据，进入该电脑首页。
6. 桌面收到手机完成回执后显示“手机已登录”。

继续使用现有账号、权限、access token、refresh token 和鉴权机制。扫码是新增登录方式；
不是账号密码转发、桌面 Token 复制，也不是新的设备权限系统。

现有“手动地址 + 账号密码登录”作为备用入口保留。当前阶段不做公网中继、P2P、设备发现服务、
手输短码、系统相机唤起 App、跨电脑任务汇总、细粒度授权和设备管理页。

## 2. 当前代码事实与复用边界

| 能力                           | 当前入口                                                                                                                                                                    | 本次改动                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 单一配置账号校验与登录会话签发 | [AuthService](../../backend/src/auth/service.ts)、[auth router](../../backend/src/routes/auth.ts)                                                                           | 提取共享会话签发方法；账号密码登录继续先校验密码；扫码通过发起者有效登录态授权 |
| 会话持久化、刷新、注销         | [AuthStore](../../backend/src/auth/store.ts)、[LowDbAuthStore](../../backend/src/auth/lowdb-store.ts)                                                                       | 复用现有记录结构及 sessionId；不新增设备账户表                                 |
| 当前连接与登录态作用域         | [App.tsx](../../frontend/src/App.tsx)、[use-scoped-auth](../../frontend/src/features/auth/use-scoped-auth.ts)                                                               | 装配扫码登录控制器，固定 connection ID、完整 apiBase、发起者 sessionId         |
| 电脑端菜单                     | [ConnectionSwitcher](../../frontend/src/components/connection-switcher.tsx)                                                                                                 | 已登录 Electron 上增加“连接手机”；Home 与 Terminal 共用                        |
| 本机可分享地址                 | [connection-address](../../electron/src/desktop/connection-address.ts)、[runtime report](../../electron/src/monitoring/runtime-status.ts)                                   | 复用现有局域网地址探测与 bridge；不要把 renderer 的 localhost 当手机地址       |
| iOS 连接配置                   | [ConnectionStore](../../packages/app-ios/Sources/RunweaveIOS/State/ConnectionStore.swift)                                                                                   | 增加准备与提交连接的路径，成功前不切换当前连接                                 |
| iOS 登录态                     | [APIClient](../../packages/app-ios/Sources/RunweaveIOS/Services/APIClient.swift)、[CredentialStore](../../packages/app-ios/Sources/RunweaveIOS/State/CredentialStore.swift) | 增加导入后端签发登录结果的入口，沿用 Keychain account 计算与刷新逻辑           |
| iOS 登录和首页路由             | [RootView](../../packages/app-ios/Sources/RunweaveIOS/App/RootView.swift)、[AppSession](../../packages/app-ios/Sources/RunweaveIOS/State/AppSession.swift)                  | 成功后关闭连接管理并激活已保存连接                                             |

当前没有扫码接口、相机扫码 UI 或相机权限声明。Swift package 最低 iOS 15；
`AuthTokens` 目前是 APIClient.swift 内部私有类型，不能直接跨文件使用。

现有 AuthService/LowDbAuthStore 在登录写入中先变更内存再等待磁盘写入。
本次抽取签发逻辑必须处理这条路径的持久化失败，不能在失败后留下仍可通过鉴权的“成功会话”。
只修整新旧登录共用的创建会话路径，不扩展为整个认证存储重构。

## 3. 地址与二维码合同

### 地址来源

- 当前连接为内置本地后端时，通过已有 `getRuntimeStatusReport` bridge 获取 fresh 的本机局域网地址；
  只读取该连接对应的本机地址事实，不从聚合后的 `currentAddress` 猜测。
- 多网卡默认使用现有探测的 primary；弹窗提供“连接地址”下的候选切换，切换时注销旧请求并生成新码。
  探测到地址不等于手机实测可达。
- 当前连接是远程后端时，保留配置的完整 HTTP/HTTPS base URL，包括代理路径前缀，不能只保留 origin。
- 只有明确识别为内置本机后端，才允许用本机局域网地址替换 loopback。
  自定义 SSH 本地转发、远程代理等 loopback 连接不能猜成内置后端；提示配置手机可访问的连接地址。
- 无有效地址、未登录、后端不可用或不支持扫码接口时不生成二维码，显示原因并保留手动登录说明。
- 不修改 Backend 监听地址、系统防火墙或代理配置，不关闭 TLS 验证，不扩大 iOS ATS 例外。
  HTTP/HTTPS 支持范围沿用当前部署合同；不宣称本功能提供 Pairfob 的端到端加密。

### 载荷

二维码直接编码 UTF-8 JSON，不使用能被系统注册处理的 URL scheme。第一版形状：

```ts
interface MobileLoginQrV1 {
  kind: "runweave.mobile-login";
  version: 1;
  baseUrl: string;
  connectionName: string;
  requestId: string;
  qrSecret: string;
  expiresAt: string; // UTC ISO 8601，服务端权威期限
}
```

服务端生成 requestId 和 32 字节安全随机 qrSecret，二维码只可授权一个手机登录会话。
有效期默认 180 秒；二维码总载荷最多 4096 UTF-8 字节、baseUrl 最多 2048 字节、显示名最多 128 字符。
禁止嵌入账号密码、已有 access/refresh token。二维码内容不上传第三方编码服务。

iOS 在联网前校验 kind/version、字段类型、长度、日期和 URL。URL 禁止 userinfo/query/fragment、
loopback、unspecified 与非 HTTP(S) 协议；保留合法代理路径。无法解析时提示重新扫码，未知版本提示升级；不因手机本地时钟判断过期而直接阻断请求。
POST 不跟随跨 origin 或 HTTPS 降级重定向；不能把扫码秘密或手机凭据转发给新地址。
不同设备时钟可能不同，手机预检查只用于提示，最终仍由服务端判定有效期。

## 4. 后端接口和状态机

在 `packages/shared/src/auth/mobile-login.ts` 定义 DTO、状态和错误码，通过
`@runweave/shared/mobile-login` 子路径导出；Swift DTO 对照同一 JSON 合同。
所有接口响应携带 `Cache-Control: no-store`。秘密只在请求正文或认证头中传输，不放 URL 查询参数。

接口相对于 base URL；手机端的短期请求不携带它原来连接的 Bearer token。

| 接口                             | 身份与输入                                                                                      | 成功输出/效果                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /api/auth/mobile-login`    | 有效桌面 Bearer；`{baseUrl, connectionName}`                                                    | 201：`MobileLoginQrV1`；绑定服务端解析出的 ownerSessionId/username                     |
| `GET /api/auth/mobile-login/:id` | 同一 ownerSessionId 的 Bearer                                                                   | 200：`{requestId,state,expiresAt,claimId?,deviceName?}`；不包含手机 Token 或秘密       |
| `POST .../:id/claim`             | `{qrSecret, claimantToken, deviceName, connectionId}`；claimantToken 由手机安全随机生成 32 字节 | 200：绑定唯一 claimant，返回 `{claimId,state,expiresAt}`；同一请求重试返回同一 claimId |
| `POST .../:id/decision`          | 同一 ownerSessionId 的 Bearer；`{claimId, decision:"approve"\|"reject"}`                        | 200：当前状态；批准必须对应屏幕展示的 claimId                                          |
| `POST .../:id/exchange`          | `{claimantToken}`                                                                               | 未批准时 202 状态；批准后 200 手机登录结果：现有 LoginResponse，refreshToken 必填      |
| `POST .../:id/complete`          | `{claimantToken}` + 本次签发的手机 Bearer                                                       | 200：`{state:"completed"}`；同一手机重复回执幂等成功                                   |
| `POST .../:id/cancel`            | owner Bearer 或已绑定 claimantToken，按明确分支校验                                             | 200：取消尚未签发的请求；已签发则 409 `already_issued`，不能伪称撤销了手机登录         |

claimantToken 只属于一次扫码尝试，不是长期设备 ID；iOS 发送的 connectionId 使用最终 Keychain
作用域计算结果，与现有登录请求头含义一致。deviceName 仅展示，使用 iPhone/iPad 等通用设备描述，
不读取联系人或设备唯一标识；它不是权限依据。

状态迁移：

```text
waiting_scan → pending_approval → approved → issuing → issued → completed
       \              \              \
        └──────────────┴──────────────┴──→ cancelled / rejected / expired
```

- `issuing` 是内部串行化状态，对外显示“正在登录”；不得在异步持久化间隙重复进入签发。
- waiting_scan/pending_approval/approved 超过 180 秒或 owner 登录失效即停止；在 decision 和首次 exchange
  内重新检查 ownerSessionId 有效性，不能只依赖创建时检查。签发持久化返回后、响应凭据前再检查 owner；
  若期间已失效，撤销本次新建会话并返回失效，不能暴露登录结果。
- 每个请求只有一个 claimant。另一个手机不能覆盖设备信息、读取状态或取走结果；返回 409 conflict。
- 相同 claimant 的网络重试可复用 claimId；不同 owner 的请求统一 404，失效秘密返回 404，
  已知终态请求先验证持有证明再返回 410。重启后不存在的 requestId 统一返回 410，
  不声称还能验证已丢失的秘密，也不返回此前状态或手机名称。
- 只有 approved 后 exchange 才创建 `clientType:"app"` 登录会话；用户名来自 owner，客户端不能指定。
  新 sessionId 与桌面不同，权限继续由现有账户鉴权决定。
- 一次性指“最多签发一个手机会话”，不是遇到回包丢失就再次创建。按 requestId 串行化，重复 exchange
  在 issued 状态只能返回原结果。原结果最多在内存保留 120 秒，且只交给同一 claimantToken。
- issued 后普通登录会话已经独立成立。owner 后续退出不会使已签发手机会话退出；沿用现有多端登录语义。
  不能因为旧配对请求失效、页面关闭、回执丢失而删除手机已保存的有效登录态。
- complete 必须验证手机 Bearer 的 sessionId 就是该请求签发的 sessionId。
  完成后立即清除原始 Token 缓存与 qrSecret 摘要，保留 claimant 摘要及短期终态信息供幂等回执/桌面查询，最多 120 秒。
- issued 的领取窗口超时且没有 complete：清理短期结果，桌面显示“未收到手机完成确认”；
  不能显示“登录失败”或擅自重签。若手机已保存 Token，可通过正常启动/verify 恢复；
  若未收到结果，则重新扫码。未领取会话的记录按现有 refresh session 生命周期处理。
- Backend 重启丢弃扫码临时状态；正常手机登录会话仍由现有持久化恢复。
  重启后迟到 exchange 返回失效，不创建新会话；已落盘手机凭据按普通登录方式继续工作。
- 每个 owner 同时最多 1 个未签发请求，主动换码原子替换旧请求；全服务最多 64 个活跃请求。
  创建限制每 owner 每分钟 10 次；claim/exchange/cancel 限制每来源 IP 每分钟 240 次、每 requestId 每分钟 180 次，
  超量或活跃容量耗尽返回 429 和 Retry-After。正常 1 秒轮询不会单独触发这些阈值。
  总请求表含终态最多 256 条，容量不足先淘汰最旧终态，仍不足则拒绝创建；限流计数器也必须有容量上限和期限清理。

临时请求仅保存 qrSecret 和 claimantToken 的 SHA-256 摘要，使用现有平台密码库作恒定时间比较；
原始二维码只在创建响应返回，刷新状态不再返回。为恢复丢包保留的登录结果是明确的短期内存例外，不写入磁盘或日志。
内部可以选择同等语义的细分类型，但不可改变上述授权、签发与回执边界。
敏感字段统一以 Secret/Token 命名并通过现有脱敏链处理；错误、控制台、诊断导出不得包含完整 QR 内容。
二维码也是短期凭据，验收截图在生成请求失效后才可保留或分享。

## 5. 桌面与手机 UI 生命周期

### Electron renderer

- 在 App 的当前连接/鉴权作用域中装配 `MobileLoginProvider`，由 ConnectionSwitcher 消费窄的打开动作；
  不将手机登录逻辑塞入 RuntimeStatusProvider，不为 Home/Terminal 各建一套状态机。
- 入口只在已登录的 Electron 当前连接上显示；已有登录页菜单与普通 Web 不增加不可用入口。
- 弹窗显示电脑名、连接地址、剩余有效时间、二维码。扫码后用请求信息替换二维码主区域，显示
  “某台 iPhone 请求登录”、允许登录和拒绝。没有手机请求时不可预批准。
- QR 使用本地 `qrcode` 生成器的浏览器构建；作为 frontend 直接依赖加入并锁定实际解析版本。
  保留白底、足够留白与固定最小展示尺寸，不自行实现编码算法。
- 1 秒刷新状态，无重叠请求；后台暂停，恢复时先读取服务端当前状态。generation 隔离换码/关窗/切连接的迟到响应。
- 切换当前连接或退出登录会关闭弹窗并取消未签发请求，旧请求不跟随新连接。
  新旧 access token 刷新不应误当作退出；身份依据 ownerSessionId 与连接作用域。
- “允许登录”重复点击只决定一次。decision 网络结果不明时查询当前状态，不直接重复产生新请求。
- approved/issued 阶段显示“正在完成手机登录”；只有 completed 才显示“手机已登录”。
  Home 数据加载失败不撤销已成功保存的登录，手机另行显示加载失败与刷新入口。

### iOS

- ConnectionManager 增加醒目的“扫码连接电脑”；现有手动连接保留。
- 使用 AVFoundation 原生扫码并保持 iOS 15 最低版本；在 Info.plist 增加 NSCameraUsageDescription。
  只在点击扫码时申请相机权限；拒绝时提供系统设置说明和手动连接返回路径。
- 扫到第一个合法码立即停止相机采集，后续重复帧不能创建重复 claim。
  扫码取消、页面关闭、后台暂停均释放捕获会话；前台恢复时先核对请求期限。
- 扫码阶段使用独立 `MobileLoginClient`，不激活或覆盖 AppSession 当前连接，也不借用其 Authorization header。
- 以规范化 base URL 查找已有本地连接：完全匹配则复用 ID 和用户命名；否则预分配新连接 ID。
  不根据显示名或 IP 相似性合并不同地址，也不在第一版发明跨地址的稳定设备识别。
- 领取结果后按“校验结果 → 写 Keychain → 保存连接记录 → 切换 activeID”的顺序提交。
  扩展 ConnectionStore 的准备/提交接口，避免使用当前新增即切换的 save 路径提前激活。
- 失败前保留原连接和 Keychain 数据；后续写入失败时补偿恢复此前修改的凭据。
  若补偿也失败，明确显示保存异常，不能宣称保存成功。不要承诺两个存储介质具有原子事务。
- 保存成功后发送 complete 回执，再激活/显示首页。回执丢失可以用同一手机会话重试；
  不能因此清空已保存的有效 Token。手机取消、切换连接或 generation 变化后，迟到结果不可改变当前选择。
- 网络异常只提示当前阶段并允许重试；过期/拒绝返回扫码入口。旧 Backend 404 显示“电脑端暂不支持扫码登录”，
  可继续使用现有手动登录。

## 6. 按依赖顺序实施

### A. 合同与会话签发

- [x] 新建 `packages/shared/src/auth/mobile-login.ts` 并修改 `packages/shared/package.json` 子路径导出。
- [x] 在 `backend/src/auth/service.ts` 抽取密码登录/扫码共用的内部签发方法，新增基于有效 ownerSessionId 的签发入口。
      同步完善 `backend/src/auth/lowdb-store.ts` 创建记录失败时的内存恢复；不改变密码验证、刷新和注销合同。
- [x] 对齐 Swift `Contracts/MobileLogin.swift`。现有 AuthTokens 仍可保持私有，APIClient 通过窄方法接收共享字段，
      不暴露可随意替换当前客户端凭据的全局 setter。
- [x] 验证 shared/backend 类型与 lint；对同一真实隔离 Backend 执行密码登录、刷新、注销，确认旧协议不变。

### B. 后端扫码服务

- [x] 新建 `backend/src/auth/mobile-login.ts`：请求表、owner/claimant 绑定、限流、串行化签发、结果短期缓存、清理。
- [x] 新建 `backend/src/routes/mobile-login.ts`：DTO 校验、所有者鉴权、临时证明鉴权、HTTP 状态映射。
- [x] 修改 `backend/src/bootstrap/runtime-services.ts` 和 `backend/src/index.ts`：装配唯一服务、路由与 dispose，
      在现有 auth router 旁挂载，不给未登录请求开放普通业务 API。
- [x] 核对 `backend/src/logging/redaction.ts`、`backend/src/diagnostic-logs/recorder.ts` 的字段和字符串路径，
      仅补充新载荷所需脱敏；不记录请求/响应完整正文。
- [x] 通过临时 HTTP 驱动访问真实服务，完成鉴权、并发领取、回包丢失、过期与重启用例；不新增测试代码文件。

### C. 桌面入口和弹窗

- [x] 新建 `frontend/src/services/mobile-login.ts`，服务层只处理协议、请求和错误转换。
- [x] 新建 `frontend/src/features/mobile-login/{provider.tsx,use-mobile-login.ts,mobile-login-dialog.tsx,address.ts}`，
      provider 绑定当前连接与登录 sessionId；address 解析现有 Electron 报告，不导入 Electron/Node 实现。
- [x] 修改 `frontend/src/App.tsx`、`frontend/src/components/connection-switcher.tsx` 接入；
      必要时在 `frontend/src/features/auth/use-scoped-auth.ts` 窄暴露当前 sessionId，而非解析 JWT 冒充鉴权。
- [x] 更新 `frontend/package.json` 与 lockfile 的二维码直接依赖；稳定函数优先 useMemoizedFn。
- [x] typecheck/lint 通过后，使用 playwright-cli 在当前候选 Desktop renderer 验证入口、换码与确认状态。

### D. iOS 扫码、结果领取与连接提交

- [x] 新建 `Features/Connections/{MobileLoginView.swift,MobileLoginController.swift,QrScannerView.swift}`，
      用独立任务持有扫码尝试和 generation；扫码采集与网络状态职责分开。
- [x] 新建 `Services/MobileLoginClient.swift` 和 `Contracts/MobileLogin.swift`。
- [x] 修改 `Services/APIClient.swift`、`State/ConnectionStore.swift`，实现登录结果校验/Keychain 导入和延后切换。
- [x] 修改 `Features/Connections/ConnectionManager.swift` 与 `App/RootView.swift`，衔接取消、手动备用与完成后关闭弹窗。
- [x] 修改 `ios/RunweaveNative/Info.plist` 的相机说明；保留 Bundle ID、Keychain service、UserDefaults key 和 ATS 配置。
- [ ] 完成当前可用 Simulator 的 Debug 构建；用真实 iPhone 扫桌面屏幕上的码走完主链。

### E. 跨端验收与交付

- [ ] 按配套 YAML 完成 required 用例，分别记录桌面/原生/后端的真实证据。
- [x] 实现后更新 `docs/architecture/app-mobile.md`、`packages/app-ios/README.md`、
      `packages/app-ios/docs/validation-status.md` 的当前合同与本次证据边界。
- [ ] 仅在用户要求提交时进行 commit/PR；不得把历史截图、临时 HTTP 驱动或敏感凭据入库。
      任务完成后按文档治理移除本过程计划，保留有效架构合同与 YAML 验收入口。

## 7. 验证合同与命令

配套用例按取证对象拆分，共 25 条 required：

- [跨端交互用例](../testing/app/mobile-qr-login.testplan.yaml)：13 条，覆盖扫码、连接提交与客户端生命周期。
- [协议与凭据用例](../testing/app/mobile-qr-login-protocol.testplan.yaml)：12 条，覆盖鉴权、签发、恢复和秘密处理。

这些 YAML 是计划实现后的验收合同，当前不存在“功能通过”的结论。

文档阶段执行：

```bash
pnpm testplan:validate docs/testing/app/mobile-qr-login.testplan.yaml
pnpm testplan:validate docs/testing/app/mobile-qr-login-protocol.testplan.yaml
pnpm docs:check
git diff --check
```

实现阶段先做与改动相关的静态验证，预期均以 0 退出且无新增错误：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
```

本计划不要求修改 Electron 源码；若实现因既有 bridge 不足实际修改 Electron，再补其 typecheck/lint。
不是每次计划或类型检查都启动完整 Dev Session。

iOS 在 `packages/app-ios` 内使用现有入口：

```bash
node scripts/ios.mjs doctor
node scripts/ios.mjs build --simulator <doctor 列出的实际 UDID> --configuration Debug
```

UDID 必须从本轮 doctor 解析，不把文档占位字面值交给命令执行；真机签名与安装按包 README 的现行脚本。
真实 Desktop 附着必须使用 playwright-cli 技能；如果需要启动候选 Dev Session，先使用 runweave-dev-session
解析目标 worktree、端口和 renderer endpoint。原生页面使用既有 Xcode/devicectl/XCUITest 执行器。
本机没有真机、签名、相机扫码条件或历史执行器时，报告该用例 blocked，不能用 API 导入 QR 或 Simulator 注入代替扫码验收。

测试账号、端口和存储目录使用本轮隔离环境；错误注入只对该环境进行。验证脚本临时存放在
`.runweave/mobile-qr-login-evidence/` 或临时目录，不新增单测、live-test 框架或 CI。
通过条件是 HTTP/持久化行为符合合同，且真实手机扫码、桌面确认、手机落盘与首页成功连成同一条链路。
类型检查、二维码可解码或单张截图均不能独立宣称完整功能通过。

## 8. 兼容、回滚与风险边界

- 旧客户端继续账号密码登录，不感知新路由；旧 Backend 不支持扫码时新客户端明确降级到手动登录。
- 无登录数据 schema 强制迁移。新扫码生成的手机登录会话使用现有记录结构，回滚后仍可按现有协议刷新/退出。
- 回滚 UI 和新接口会中止进行中的扫码请求，但不删除现有账户、连接、正常登录会话或终端。
- requestId/ownerSessionId/claimId 绑定与 generation 隔离防止确认错电脑、错手机或迟到响应污染当前连接。
- 持久化失败、并发 exchange、完成回执丢失分别处理；不得用“重复请求直接重签”掩盖不确定结果。
- 本功能承袭现有 HTTP/HTTPS 通道安全边界；扫码秘密和登录 Token 不自动获得端到端加密。
  不为了通过本轮验收放宽 TLS、ATS 或登录限制。

## 9. 外部实现参考

- [node-qrcode 官方仓库](https://github.com/soldair/node-qrcode)：支持浏览器构建与本地 Canvas 编码；仅用于生成二维码。
- [Apple 相机授权文档](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media)：
  使用 AVFoundation 的系统权限与生命周期，新增相机用途说明。实施时核对所用 API 的 iOS 15 可用性。

参考访问日期：2026-09-08。以上是实现选型依据，不是已完成集成或安全审计的证明。
