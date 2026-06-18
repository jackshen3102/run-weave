# App 后端连接管理评审

日期：2026-06-18

## 评审范围

- 当前工作树中 App 多后端连接管理、按连接认证存储、Login/Home/Terminal 接入、支持日志上下文变更。
- 夹带检查：`backend/src/terminal/tmux-service.ts` 的 tmux 环境透传，以及 `frontend/src/components/terminal/terminal-workspace-shell.tsx` 的终端标签状态卡。
- 已参考实施计划 `docs/plans/2026-06-17-app-backend-connection-management.md`，但评审结论以当前代码为准。

## 验证命令

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 未执行浏览器行为验证；如需要打开页面验收，必须使用 `$playwright-cli`。

## 架构 / 策略发现

### P1 - Native 凭据存储仍是阻断占位，但登录链路已经接入该阻断点

**当前决策**：新增 `AppAuthCredentialStore`，运行时通过 `Capacitor.isNativePlatform()` 选择 native/web 实现；web fallback 使用 localStorage，native 实现清理旧 WebView key 后在 `saveSession` 直接抛出“secure storage 未配置”错误。登录流程已经在拿到后端 session 后调用 `persistSession`。

**为什么这是系统层面的风险**：这避免了把多后端 refresh token 明文降级到 WebView localStorage，是正确的安全底线；但如果这批变更进入 native App，核心登录路径会稳定失败。结果不是“多后端能力未完成”，而是“用户输入正确账号密码后仍无法登录”。计划也把 native secure storage 标为上线前阻断项，但当前代码没有 build/runtime gate，只是在用户登录后暴露失败。

**证据**：

- `app/src/store/app-auth-credential-store.ts:11`-`14`：native 平台选择 `nativeAppAuthCredentialStore`。
- `app/src/store/app-auth-credential-store.native.ts:15`-`23`：native `saveSession` 清理旧 key 后直接抛错。
- `app/src/hooks/use-app-session.ts:394`-`399`：先调用后端 `login`，再保存 session。
- `docs/plans/2026-06-17-app-backend-connection-management.md:97`-`101`、`175`-`178`：计划已要求 native secure storage 作为上线门禁。

**更好的候选方案**：

1. 推荐：本轮同时接入 iOS Keychain / Android Keystore 支撑的 Capacitor secure storage bridge，并让 native 读写真实凭据。
   - 交付速度：中等。
   - 复杂度：中等，涉及 Capacitor 依赖和 native sync。
   - 运维风险：最低，功能和安全边界一致。
2. 可接受过渡：在 native build 或 App 启动阶段显式 gate 住多后端认证，提示“当前版本缺少安全存储”，避免用户完成一次真实后端登录后才失败。
   - 交付速度：最快。
   - 复杂度：低。
   - 运维风险：功能不可用但失败方式清晰。
3. 不推荐：native 直接复用 web localStorage fallback。
   - 交付速度：快。
   - 复杂度：低。
   - 运维风险：高，会把多个后端 refresh token 扩散到 WebView localStorage，违背计划中的安全边界。

**迁移/过渡风险**：接入 secure storage 后需要处理旧 `runweave-app-auth-session` 的清理和重新登录；如果选择 gate，必须避免发布说明把这描述成已完成的 native 多后端登录能力。

**修复方向**：要么在本变更中完成 secure storage native 实现，要么在 native 平台禁用登录提交并给出明确阻断信息；不要让 `saveSession` 在后端登录成功之后才失败。

### P1 - 认证作用域只绑定 connectionId，但 URL 是可编辑的

**当前决策**：App auth session 以 `connectionId` 存取；连接 URL 可以原地编辑；默认连接 ID 固定为 `runweave-default`；计划中也明确“更新连接 URL 时，保留该连接 session”。

**为什么这是系统层面可能是错的**：后端 URL/认证域才是 token 的真实安全边界。把 token 只绑到可复用、可编辑的本地 ID，会让“同一个 connectionId 指向另一个后端”时继续带着旧 token 进入 verify/overview/refresh 流程。最轻是用户被动登出；更糟的是两个环境共享 token 颁发规则或后端 host 被误改时，App 会把旧 refresh/access token 发给新的后端。

**证据**：

- `app/src/store/use-app-connection-store.ts:12`：默认连接 ID 是固定字符串。
- `app/src/store/use-app-connection-store.ts:71`-`78`：默认连接用该固定 ID 承载当前 `defaultApiBase`。
- `app/src/store/use-app-connection-store.ts:194`-`215`：编辑连接 URL 时保留原 ID，不清理凭据。
- `app/src/store/app-auth-credential-store.web.ts:60`-`61`：web 凭据 key 只由 `connectionId` 派生。
- `app/src/hooks/use-app-session.ts:116`-`121`：认证态只检查 auth store 的 `activeConnectionId` 是否等于当前 `activeConnectionId`。
- `app/src/hooks/use-app-session.ts:144`-`158`：重新加载凭据只依赖 `activeConnectionId`，同一 ID 下 URL 变化不会重新按新认证域加载。
- `docs/plans/2026-06-17-app-backend-connection-management.md:109`：计划要求 URL 更新后保留该连接 session。

**更好的候选方案**：

1. 推荐：把认证 scope 扩展为 `connectionId + canonicalOrigin`，URL origin 变化时清空该连接 session 或要求重新登录。
   - 交付速度：快到中等。
   - 复杂度：低，主要是存储 key/索引和编辑保存逻辑。
   - 运维风险：低，用户可能因改 host 被要求重新登录。
2. 推荐：把“修改 URL”建模为新连接，旧连接和旧凭据保持不动，用户确认后删除旧连接。
   - 交付速度：中等。
   - 复杂度：中等，UI 文案和迁移行为更多。
   - 运维风险：低，避免无意把 token 发给新后端。
3. 平台/现有能力方案：对齐桌面端 `useScopedAuth` 的 scoped storage 思路，但增加 URL/origin 指纹作为 auth scope 的一部分，而不是只复制 connectionId 维度。
   - 交付速度：中等。
   - 复杂度：中等，需避免过度抽象。
   - 运维风险：可控，Web/App 语义更一致。

**迁移/过渡风险**：现有本地用户编辑 URL 后可能需要重新登录；如果默认连接的 `VITE_RUNWEAVE_API_BASE` 改变，也需要显式失效旧默认连接凭据。

**修复方向**：至少在 `updateConnection` 检测 canonical origin 变化时清理该 connectionId 的 session，并触发当前 session reload；默认连接则应把当前 URL 指纹纳入凭据索引或在 URL 改变时失效旧 session。

### P3 - App 重新实现了一套连接/认证状态机，长期会和桌面端漂移

**当前决策**：App 新增 `use-app-connection-store`、`use-auth-store`、credential store；桌面端已有 `useConnections` 和 `useScopedAuth`。

**为什么这是系统层面可能是错的**：App 和桌面端都在解决“连接列表、active connection、按连接认证、切换后重载会话”的同一类问题。当前重复实现已经出现不同语义：App 有 native secure storage 占位、固定 default ID、URL 编辑保留 session；桌面端则有 packaged backend/system connection 行为和不同的 scoped auth 存储。继续分叉会让后续 bug 修复必须两边各做一遍。

**证据**：

- `frontend/src/features/connection/use-connections.ts:151`-`203`：桌面端连接新增、删除、编辑逻辑。
- `frontend/src/features/auth/use-scoped-auth.ts:133`-`226`：桌面端按 scope 管理认证 session。
- `app/src/store/use-app-connection-store.ts:176`-`215`：App 重新实现连接新增、编辑逻辑。
- `app/src/store/use-auth-store.ts:36`-`108`：App 重新实现按连接加载/保存/清理认证 session。

**更好的候选方案**：

1. 保守推荐：暂不抽 UI，抽取最小纯函数/类型约束，例如 URL normalize、auth scope key、URL 改变时凭据失效规则，并让 Web/App 两端真实调用。
2. 可选：保持实现分离，但增加一份明确的连接/认证行为矩阵，作为 E2E 和人工验收合同。
3. 不推荐：把桌面 shadcn 组件或 Electron packaged backend 细节搬进 App。

**迁移/过渡风险**：抽公共逻辑要遵守仓库边界；只有 Web 与 App 都实际复用的浏览器端 helper 才能进入 `packages/common`，协议/DTO 才进 `packages/shared`。

**修复方向**：先把“认证 scope 如何计算”和“URL/origin 变化如何处理 session”提炼成小型共享规则，避免直接抽大 store。

## 代码 / 实现发现

### P2 - 登录成功后本地持久化失败会遗留服务端 session

**为什么这是风险**：`loginWithCredentials` 先向后端创建登录 session，再调用 `persistSession`。native 当前 `saveSession` 必抛错，因此用户会看到登录失败，但后端已经签发 session；代码没有用新 token 调用 logout，也没有在持久化失败时做服务端清理。

**证据**：

- `app/src/hooks/use-app-session.ts:394`-`399`：后端登录成功后再保存本地 session。
- `app/src/hooks/use-app-session.ts:404`-`413`：catch 只记录并抛出错误。
- `app/src/store/app-auth-credential-store.native.ts:20`-`22`：native 保存 session 必抛错。

**修复方向**：在无法保证 credential store 可写时不要发起后端登录；或者在 `persistSession` 失败时用刚拿到的 `session.accessToken` 尝试 `logout(apiBase, session.accessToken)`，并把错误文案明确区分为“本地安全存储不可用”。

### P3 - 连接存储读取时单条坏数据会清空整个连接列表

**为什么这是风险**：`readStoredConnections` 在一个大 `try` 中解析、过滤并 normalize 所有连接。只要某条存储 URL 无法通过 `new URL`，就会进入 catch，删除整个 `runweave-app-connections`。这会把一个损坏连接扩大成全量连接丢失。

**证据**：

- `app/src/store/use-app-connection-store.ts:84`-`118`：读取存储和 normalize 处于同一个 try/catch。
- `app/src/store/use-app-connection-store.ts:48`-`54`：`normalizeStoredUrl` 会调用 `normalizeUserUrl`，无效 URL 会抛错。
- `app/src/store/use-app-connection-store.ts:116`-`118`：catch 中直接删除整个 storage key。

**修复方向**：逐条解析连接，跳过或标记坏记录，保留其余有效连接；只有 JSON 根结构不可解析时才删除整个 store。

### P3 - 连接删除未等待凭据清理结果

**为什么这是风险**：`removeConnection` 里用 `void getAppAuthCredentialStore().clearSession(id)` 异步清理凭据，然后立即从连接列表移除。当前 web/local native stub 大概率没问题，但一旦接入真实 Keychain/Keystore，清理失败会留下孤儿凭据，UI 仍显示连接已删除。

**证据**：

- `app/src/store/use-app-connection-store.ts:218`-`229`：删除连接时 fire-and-forget 清理 session。
- `app/src/components/AppConnectionManager.tsx:137`-`145`：UI 在调用 `removeConnection` 后立即按下一连接继续。

**修复方向**：把删除连接改为 async 流程，先清理凭据或记录清理失败，再提交 store 更新；如果为了交互速度先删 UI，也要记录待清理状态并可重试。

## 残余风险 / 测试缺口

- 没有执行 `$playwright-cli` 浏览器/App 行为验证；尚未覆盖“切换连接后所有 HTTP/WebSocket 请求都打到新 apiBase”的运行时证据。
- 未执行 native iOS/Android 路径；当前 native secure storage 占位决定了 native 登录路径不能作为可用功能发布。
- `pnpm typecheck`、`pnpm lint` 均通过，但它们无法证明 token 作用域、URL 编辑、terminal id 切换这些生命周期行为正确。
