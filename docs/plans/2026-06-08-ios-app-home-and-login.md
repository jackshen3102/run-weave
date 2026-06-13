# iOS App 首页与登录一期实施计划

## 背景

当前 `app/` 是独立的 Ionic React + Capacitor 应用，入口 `app/src/App.tsx` 仍是 Hello World 占位页，状态管理仅有主题与示例计数 store。本计划以 App 自身需求和后端现有接口能力为依据：认证走 `backend/src/routes/auth.ts`，项目与终端移动概览复用 `backend/src/routes/terminal.ts` 已挂载的 `GET /api/terminal/mobile/overview`。Web H5 移动页相关页面和前端能力不作为 App 首页方案依据；后端移动概览接口是共享后端能力，应由 H5 和 App 共同复用。

本计划只描述实现方案，不进入代码实现。

## 目标

在 iOS App 第一期实现两个用户可见页面：

1. 登录页：基于后端认证接口实现 App 独立登录 UI、状态与服务代码，不抽公共组件。
2. 首页：登录后展示 Runweave 项目列表，每个项目下展示该项目的终端列表，视觉参考用户提供的两张移动端首页截图，同时贴合当前 Runweave 深色主题、Ionic 组件体系和现有终端数据模型。

## 非目标

- 不支持新增项目。
- 不在本计划中承诺新增终端能力；如一期需要入口，只保留为可隐藏或待确认项，不默认调用 `POST /api/terminal/session`。
- 不复用或抽象 Web 端 React/Tailwind 组件。
- 不新增前端单测、Vitest 测试或 UI hooks 单测；App 变更以类型检查、构建和手工回归为主。
- 不新增第二套 App 首页 overview 接口；在现有 `GET /api/terminal/mobile/overview` 上扩展 App 需要的字段和轻量模式，避免 H5 与 App 维护两套移动概览语义。

## 代码事实

- App 技术栈：`@runweave/app` 依赖 Ionic React、React 19、Zustand、Capacitor，入口为 `app/src/main.tsx` 与 `app/src/App.tsx`。
- App 当前主题：`app/src/theme/variables.css` 只定义了 Ionic primary 色与字体，`app/src/store/use-theme-store.ts` 通过 `ion-palette-dark` 管理深浅色。
- 后端认证接口：`POST /api/auth/login`、`POST /api/auth/refresh`、`GET /api/auth/verify`、`POST /api/auth/logout`。当前后端只把 `x-auth-client: electron` 识别为 body refresh-token 分支；本计划必须扩展认证 client type，新增 `app`，让 App 通过 `X-Auth-Client: app` 获取和刷新本地 refresh token。
- 后端 CORS：`backend/src/server/cors.ts` 只自动允许 `http://localhost:*` 与 `http://127.0.0.1:*` 这类本地 HTTP origin；Capacitor iOS WebView 的 `capacitor://localhost` 或远程 Web origin 必须通过 `FRONTEND_ORIGIN` 显式放行，否则真机登录会被浏览器层 CORS preflight 拦截。
- 后端项目读接口：`GET /api/terminal/project`，返回项目列表。项目字段包括 `projectId`、`name`、`path`、`createdAt`、`isDefault`。
- 后端终端读接口：`GET /api/terminal/session`，返回终端列表。终端字段包括 `terminalSessionId`、`projectId`、`command`、`args`、`cwd`、`activeCommand`、`status`、`createdAt`、`exitCode`、可选 tmux 信息。
- 后端终端详情接口：`GET /api/terminal/session/:id` 与 `GET /api/terminal/session/:id/history` 可以读取单个终端状态或历史 scrollback，但不适合首页对所有终端逐个请求。
- 后端写接口：`POST /api/terminal/project`、`PATCH /api/terminal/project/:id`、`DELETE /api/terminal/project/:id`、`POST /api/terminal/session` 等已存在，但本期首页不调用项目新增/编辑/删除接口；新增终端入口未定，不默认调用终端创建接口。

## 推荐方案

采用 App 独立页面 + App 独立服务层 + 后端通用接口优先的方式实现：

- `app/src/App.tsx` 从占位页改为轻量路由状态机：启动检查登录态，未登录显示登录页，已登录显示首页。
- `app/src/services/http.ts`、`app/src/services/auth.ts`、`app/src/services/terminal.ts` 放在 App 内部，服务层只按后端接口合约实现，不从 `frontend/src` import。
- `app/src/store/use-auth-store.ts` 负责保存 `apiBase`、access token、可选 refresh token、登录状态与退出登录。
- 首页一期请求现有 `GET /api/terminal/mobile/overview`。该接口继续底层复用 `TerminalSessionManager.listProjects()` 与 `TerminalSessionManager.listSessions()`，并补齐首页 item 需要的 `title`、`displayStatus`、`lastActivityAt`。
- H5 继续使用该接口默认返回受限 live tail；App 不展示最近输出 preview，调用同一路由的轻量模式，例如 `GET /api/terminal/mobile/overview?includeTail=false`，避免为 App 读取所有终端 scrollback。
- UI 使用 Ionic 组件与 App 自有 CSS，主视觉采用深色、黑底、白字、圆角搜索框、项目分组、终端行列表，保持与参考截图的结构接近，但信息内容使用 Runweave 的项目/终端事实。

## 接口策略

### 本期直接复用的后端能力

- 登录：`POST /api/auth/login`。App 请求必须发送 `X-Auth-Client: app`，后端必须在该分支返回 `accessToken`、`refreshToken`、`expiresIn`、`sessionId`。
- 启动校验：`GET /api/auth/verify`。access token 有效则进入首页，无效则尝试 refresh 或回登录页。
- 刷新会话：`POST /api/auth/refresh`。App 请求必须发送 `X-Auth-Client: app`，并在 JSON body 内提交 `{ "refreshToken": string }`，不依赖 cookie。
- 退出：`POST /api/auth/logout`。失败时仍清理本地登录态。
- 项目列表能力：`GET /api/terminal/mobile/overview` 内部复用 `TerminalSessionManager.listProjects()`。
- 终端列表能力：`GET /api/terminal/mobile/overview` 内部复用 `TerminalSessionManager.listSessions()`。

### 认证 client type 扩展

本期不能让 App 使用含糊的“非 Web 客户端”标识，也不让 App 伪装成 Electron。必须把认证协议扩展为显式的 App client：

```ts
type AuthClientType = "web" | "electron" | "app";
```

后端修改要求：

- `backend/src/routes/auth.ts`：`resolveClientType()` 必须识别 `x-auth-client: app`，否则返回 `web`。
- `backend/src/routes/auth.ts`：`POST /login` 中 `clientType === "web"` 继续走 cookie refresh token；`clientType === "electron" || clientType === "app"` 返回 body refresh token。
- `backend/src/routes/auth.ts`：`POST /refresh` 中 `clientType === "electron" || clientType === "app"` 从 JSON body 读取 `refreshToken`；只有 `web` 从 cookie 读取。
- `packages/shared/src/protocol.ts`：新增共享类型 `AuthClientType`，并让 App 服务层和后端 route 使用同一枚举或联合类型，避免字符串漂移。
- 后端测试必须覆盖 `x-auth-client: app` 登录返回 `refreshToken`，以及 `x-auth-client: app` 刷新可从 body refresh token 成功换取新 token。

App 请求要求：

- 登录、刷新接口统一发送 `X-Auth-Client: app`。
- App 本地只持久化 `apiBase`、`accessToken`、`refreshToken`、`sessionId` 和 token 到期信息。
- 如果登录响应缺少 `refreshToken`，App 必须视为协议错误，清理本地登录态并显示登录失败，而不是进入首页。

### App API base 与 CORS 策略

`apiBase` 是 App 请求的后端地址；`Origin` 是 WebView 发出的来源。两者要分别处理。

App 侧地址策略：

- 本地开发：使用本地后端 localhost 端口，例如 `http://localhost:<backend-port>`。具体端口从 App 构建环境读取，缺省使用当前本地开发后端端口。
- 非本地开发、真机和远程环境：固定使用 `https://runweave.jackshen310.cn`，一期不让用户在登录页自由输入其他远程地址。
- 登录页可以显示当前连接地址，但非本地构建不提供任意地址编辑入口，避免用户填入未配置 CORS 的后端后卡在浏览器层错误。

后端 CORS 策略：

- 本地 `http://localhost:*` 与 `http://127.0.0.1:*` 仍由现有 `isAllowedLocalOrigin()` 自动放行。
- 真机 iOS App 的后端环境必须配置 `FRONTEND_ORIGIN=capacitor://localhost`；如 Capacitor/iOS 实际 origin 为 `ionic://localhost`，也必须加入同一个逗号分隔白名单。
- 如果同一后端也服务远程 Web 入口，则 `FRONTEND_ORIGIN` 同时包含 `https://runweave.jackshen310.cn`。
- 推荐部署值：

```bash
FRONTEND_ORIGIN=capacitor://localhost,ionic://localhost,https://runweave.jackshen310.cn
```

验证要求：

- 后端 CORS 测试新增 `Origin: capacitor://localhost` 的 `OPTIONS /api/auth/login` preflight，预期返回 `204` 且 `Access-Control-Allow-Origin: capacitor://localhost`。
- 真机或模拟器调试时，先用登录请求验证不会出现浏览器 CORS 拦截；如果失败，优先检查响应头而不是认证业务逻辑。

### 本期不调用的后端能力

- 项目新增、编辑、删除、排序接口。
- 终端新增、删除、输入、WebSocket ticket、clipboard、preview、completion events 接口。
- 新增的第二套 App 首页 overview 接口，例如 `/api/app/home/overview`。

### 首页 item 数据合同

首页终端 item 必须只展示以下有来源的字段：

| UI 字段  | 来源                                           | 实现方式                                                                                                                                              |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标题     | `TerminalMobileOverviewSession.title`          | 后端用 `activeCommand ?? basename(command)` 加 `basename(cwd)` 生成，例如 `codex · browser-viewer`；不展示 git branch，除非后端显式提供 branch 字段。 |
| 副标题   | `TerminalSessionListItem.cwd`                  | 展示当前 cwd，过长时中间或尾部截断。                                                                                                                  |
| 状态     | `TerminalMobileOverviewSession.displayStatus`  | 后端根据 `status` 与 `activeCommand` 生成：`running + activeCommand` 为 `Running`，`running + activeCommand null` 为 `Idle`，`exited` 为 `Exited`。   |
| 时间     | `TerminalMobileOverviewSession.lastActivityAt` | 后端新增终端活动时间字段，创建、输出追加、cwd/activeCommand 更新、退出时更新；App 展示相对时间。                                                      |
| 项目归属 | `projectId`                                    | App 按 `projectId` 归组到项目下。                                                                                                                     |

`lastActivityAt` 写入与排序规则：

- 内存即时更新：`createSession()` 初始化为 `createdAt`；`appendOutput()` 收到非空输出、`updateSessionMetadata()` 发生 cwd/activeCommand 变化、`markExited()` 标记退出时，立即更新内存 session 的 `lastActivityAt`。
- 持久化节流合并：不要在每个 output chunk 上同步写 lowdb metadata。为 `lastActivityAt` 增加按 `terminalSessionId` 合并的延迟持久化队列，建议 5-15 秒节流窗口；退出、销毁、dispose 时 flush pending activity metadata。允许 App 展示时间有秒级到十几秒误差。
- 存储队列隔离：继续保持 scrollback append 使用现有 scrollback write queue；`lastActivityAt` metadata 写入使用现有 metadata enqueue/write 或专门的 coalesced metadata flush，不能把每个输出 chunk 都变成整库 metadata write。
- 排序只在概览响应层生效：`GET /api/terminal/mobile/overview` 返回 sessions 时按 `lastActivityAt desc`、再按现有 order/createdAt fallback 排序；不要改变 `TerminalSessionManager.listSessions()` 的既有排序语义，避免影响 Web 终端 workspace。

首页终端 item 一期不展示以下字段：

- git branch，例如 `main`。当前终端模型没有 branch 字段；如果需要，必须新增后端 git context 采集字段。
- 最近输出 preview。除非产品确认 item 必须展示最近输出，否则不读取 scrollback，不在草图和实现中展示。
- AI 待处理、未读、卡住等推断状态。当前后端没有稳定字段；如需展示，必须作为 `TerminalMobileOverviewSession` 的显式字段实现。

### 移动概览接口复用边界

本计划不新增 `/api/app/home/overview`。已有 `GET /api/terminal/mobile/overview` 已经承担“项目 + 终端 + 受限 live tail”的移动概览职责，并有共享类型和测试。App 首页需要的是同一概览语义上的更明确 item 字段，而不是第二个 endpoint。

扩展策略：

- 保持路由：`GET /api/terminal/mobile/overview`。
- 保持 H5 兼容：默认行为继续返回 `tailScrollback`，现有 H5 调用不需要改。
- 增加轻量模式：支持 `includeTail=false`，App 首页调用该模式，后端不读取所有终端 scrollback。
- 扩展共享类型：在 `TerminalMobileOverviewSession` 上新增 `title`、`subtitle`、`displayStatus`、`displayStatusLabel`、`lastActivityAt`。
- 新字段由后端统一生成，H5 和 App 都可复用；H5 可继续忽略这些字段，App 不消费 tail 字段。

```http
GET /api/terminal/mobile/overview?includeTail=false
Authorization: Bearer <accessToken>
```

共享类型扩展示意：

```ts
interface TerminalMobileOverviewSession extends TerminalSessionListItem {
  title: string;
  subtitle: string;
  displayStatus: "running" | "idle" | "exited";
  displayStatusLabel: "Running" | "Idle" | "Exited";
  lastActivityAt: string;
  tailScrollback?: string;
  tailScrollbackSourceCols?: number;
  tailError?: string;
}
```

`includeTail=true` 或缺省时保留现有 tail 字段；`includeTail=false` 时 tail 字段可省略，读取失败不会影响 App 首页。

## 页面行为

### 登录页

- 首屏展示 Runweave 品牌、服务地址输入、用户名输入、密码输入、登录按钮。
- 默认用户名可设置为后端默认账号 `admin`，但登录流程以 `/api/auth/login` 的真实响应为准。
- `apiBase` 本地开发使用 localhost 后端端口；非本地开发、真机和远程环境固定为 `https://runweave.jackshen310.cn`。
- 登录成功后保存 access token 与必要的会话信息，进入首页。
- 401 显示明确错误；其他失败显示网络或服务错误。
- 登录页不出现 Web 端连接切换器，因为 App 现阶段没有 Electron 多连接管理上下文。

### 首页

- 顶部区域：iOS 安全区内显示 Runweave 标识、当前连接地址或短标签、刷新与设置/退出入口。
- 搜索框：本期只做本地过滤项目名、项目路径、终端命令、cwd，不请求后端搜索；只有后续扩展 `TerminalMobileOverviewSession` 并返回 preview 后，才把最近输出纳入搜索。
- 项目分组：按后端返回的项目顺序展示；每个项目行显示文件夹图标、项目名、展开/收起状态、终端数量。
- 终端列表：展示在所属项目下，单行显示终端标题、状态、cwd 与最近活动时间。标题、状态和最近活动时间都来自 `GET /api/terminal/mobile/overview`，不在 App 侧猜测 git branch 或 AI 状态。
- 空状态：无项目时显示“暂无项目”，但不提供新增项目按钮；某项目无终端时显示“暂无终端”。
- 刷新：下拉刷新或右上角按钮重新请求 `GET /api/terminal/mobile/overview?includeTail=false`。
- 登录失效：收到 401 后清理 token 并回到登录页。

## 文件范围

预计新增：

- `app/src/config/api-base.ts`：集中解析 App API base，本地开发走 localhost 后端端口，非本地开发固定 `https://runweave.jackshen310.cn`。
- `app/src/services/http.ts`：App 内 fetch 包装与错误类型。
- `app/src/services/auth.ts`：App 内登录、校验 token、可选刷新会话。
- `app/src/services/terminal.ts`：App 内 `getTerminalMobileOverview()`，请求 `GET /api/terminal/mobile/overview?includeTail=false`。
- `app/src/store/use-auth-store.ts`：登录态、apiBase、token 持久化。
- `app/src/pages/LoginPage.tsx`：Ionic 登录页。
- `app/src/pages/HomePage.tsx`：Ionic 首页容器。
- `app/src/components/ProjectGroup.tsx`：项目分组展示。
- `app/src/components/TerminalRow.tsx`：终端行展示。
- `app/src/lib/terminal-home-view-model.ts`：处理搜索、展开状态和分组展示；不在这里推断后端未提供的业务字段。

预计修改：

- `app/package.json`：添加 `@runweave/shared: workspace:*`，App 必须使用共享协议类型，避免 `AuthClientType`、`TerminalMobileOverviewResponse` 等字段漂移。
- `app/tsconfig.json`：如果引入 workspace 类型后构建需要 project reference 或路径调整，再做最小修改。
- `app/src/App.tsx`：替换占位页为登录态与首页状态机。
- `app/src/main.css`：移除 Hello World 样式，新增登录页与首页样式。
- `app/src/theme/variables.css`：补齐 Runweave App 深色主题变量，但不改 Web 主题。
- `backend/src/server/cors.test.ts`：补充 `capacitor://localhost` preflight 用例，确保部署白名单能覆盖真机 App origin。
- `backend/src/routes/terminal-mobile-overview.ts`：扩展现有移动概览 payload，并支持 `includeTail=false`。
- `backend/src/routes/terminal.ts`：把 `includeTail` query 传给移动概览构造函数。
- `packages/shared/src/terminal-protocol.ts`：扩展 `TerminalMobileOverviewSession` / `TerminalMobileOverviewResponse`。
- `backend/src/terminal/store.ts`、`backend/src/terminal/manager.ts`、`backend/src/terminal/lowdb-store.ts`：新增并维护 `lastActivityAt`。

## 设计约束

- 首页不是营销落地页，第一屏就是项目与终端列表。
- 不使用大面积插画、渐变球、装饰性卡片堆叠；列表要密集、可扫读。
- 不把卡片套卡片；项目分组是列表分段，终端是单行或紧凑行。
- 使用熟悉图标表达操作：刷新、设置、退出、展开/收起、搜索。
- 文案不解释功能用法，只呈现对象与状态。
- 保留 iOS 安全区：顶部和底部使用 `env(safe-area-inset-*)`。
- 文本必须单行截断或明确换行，不能遮挡右侧状态或时间。

## 任务拆分

### 1. 认证协议扩展

先扩展后端认证 client type，确保 App 能稳定拿到 body refresh token。

修改：

- `packages/shared/src/protocol.ts`：新增 `AuthClientType = "web" | "electron" | "app"`。
- `backend/src/routes/auth.ts`：识别 `x-auth-client: app`，并让 app/electron 共用 body refresh token 分支。
- `backend/src/routes/auth.test.ts`：新增 App client 登录和刷新用例。

验证：

- `pnpm --filter ./backend test -- auth`
- `pnpm --filter ./packages/shared typecheck`

### 2. API base 与 CORS 配置

实现 App API base 解析，并补齐后端 CORS 验证。

修改：

- `app/src/config/api-base.ts`：本地开发从构建环境读取 localhost 后端地址；非本地开发、真机和远程构建返回 `https://runweave.jackshen310.cn`。
- `app/src/services/http.ts`：统一从 API base 配置发起请求，不在页面组件里拼接后端地址。
- `backend/src/server/cors.test.ts`：新增 `Origin: capacitor://localhost` 的 preflight 用例；如果需要覆盖 iOS 实际 origin，再新增 `ionic://localhost` 用例。
- 部署配置：非本地后端必须设置 `FRONTEND_ORIGIN=capacitor://localhost,ionic://localhost,https://runweave.jackshen310.cn`。

验证：

- `pnpm --filter ./backend test -- cors`
- `pnpm --filter @runweave/app typecheck`
- 真机或模拟器登录前先确认 `OPTIONS /api/auth/login` 返回 `Access-Control-Allow-Origin: capacitor://localhost`。

### 3. App 服务与登录态

实现 App 内服务层与认证 store。

验证：

- `pnpm --filter @runweave/app typecheck`
- 手工确认本地开发使用 localhost 后端端口，非本地构建使用 `https://runweave.jackshen310.cn`。
- 手工确认登录失败时停留登录页，登录成功后进入首页。

### 4. 登录页 UI

用 Ionic 组件实现独立登录页，字段来自后端认证接口需要的 `username`、`password` 与 App 需要保存的 `apiBase`，不复用 Web 组件。

验证：

- `pnpm --filter @runweave/app build`
- iPhone 尺寸手工检查：输入框、按钮、错误提示不溢出，不被键盘前的初始布局遮挡。

### 5. 首页数据 view model

基于 `TerminalMobileOverviewResponse` 生成：

- 项目分组。
- 每个项目的终端列表。
- 项目终端数量。
- 终端显示标题、状态、cwd、最近活动时间。
- 本地搜索过滤结果。

验证：

- `pnpm --filter @runweave/app typecheck`
- 使用 mock 数据或本地后端手工确认：项目为空、项目无终端、终端命令为空、cwd 很长时页面稳定。

### 6. 复用并扩展移动概览接口

扩展现有 `GET /api/terminal/mobile/overview`，让 H5 和 App 复用同一套移动概览语义。

后端修改：

- `backend/src/routes/terminal-mobile-overview.ts`：在现有 payload 中增加 `title`、`subtitle`、`displayStatus`、`displayStatusLabel`、`lastActivityAt`；支持 `includeTail=false` 时跳过 live tail 读取。
- `backend/src/routes/terminal.ts`：读取 `includeTail` query，传给 `buildTerminalMobileOverviewPayload()`；默认保持现有 include tail 行为，兼容 H5。
- `packages/shared/src/terminal-protocol.ts`：扩展 `TerminalMobileOverviewSession`，不要新增 `AppHomeOverviewResponse`。
- `backend/src/terminal/store.ts`、`backend/src/terminal/manager.ts`、`backend/src/terminal/lowdb-store.ts`：为终端 session 增加 `lastActivityAt`；内存即时维护，持久化按 terminalSessionId 节流/合并，避免 output chunk 放大 metadata 写入。

验证：

- `pnpm --filter ./backend typecheck`
- 扩展现有 terminal mobile overview 后端测试，覆盖有项目无终端、running+activeCommand、running+activeCommand null、exited、`lastActivityAt desc` 响应层排序、`includeTail=false` 不读取/不返回 tail、默认请求继续返回 tail。
- 针对终端 session manager/store 增加后端测试，确认 `appendOutput()`、`updateSessionMetadata()`、`markExited()` 会即时更新内存 `lastActivityAt`，并确认持久化写入被节流/合并，不会每个 output chunk 写一次 metadata。
- App 侧不逐个请求所有终端 history，不新增第二套 overview endpoint。

### 7. 首页 UI

实现移动首页：

- 顶部品牌与操作区。
- 搜索框。
- 项目分组列表。
- 项目展开/收起。
- 终端行。
- 加载、错误、空状态。
- 刷新。
- 退出登录。

验证：

- `pnpm --filter @runweave/app build`
- `pnpm app:dev` 后在移动视口手工检查深色主题、滚动、截断、展开收起、搜索过滤。

### 8. iOS 壳体验检查

同步并打开 iOS 项目，做首轮真机或模拟器检查。

验证：

- `pnpm --filter @runweave/app ios:sync`
- `pnpm --filter @runweave/app cap open ios`
- Xcode 中确认启动页后进入登录页，登录后首页安全区、状态栏颜色、滚动边界正常。

## 验收标准

- 未登录用户打开 App 看到登录页，登录成功后进入首页。
- 已登录用户重新打开 App 可以直接进入首页；token 无效时回到登录页。
- App 登录与刷新请求使用 `X-Auth-Client: app`；后端登录响应返回 body refresh token，刷新接口从 body refresh token 成功刷新。
- 非本地开发、真机和远程环境的 App API base 为 `https://runweave.jackshen310.cn`。
- 后端部署 `FRONTEND_ORIGIN` 放行 `capacitor://localhost`，真机登录不会被 CORS preflight 拦截。
- 首页能展示 `GET /api/terminal/mobile/overview?includeTail=false` 返回的所有项目。
- 每个项目下只展示该项目的终端。
- 每个终端 item 的标题、状态、cwd、最近活动时间都有后端字段来源。
- 项目不可新增；页面上没有“新增项目”入口。
- 新增终端入口默认不出现，除非后续明确确认。
- 搜索能在本地过滤项目和终端。
- 下拉刷新或刷新按钮能重新加载数据。
- 深色主题下视觉接近参考图的移动列表密度，同时保留 Runweave/Ionic 当前主题。
- App 构建通过：`pnpm --filter @runweave/app build`。

## 风险与处理

- `@runweave/app` 当前未依赖 `@runweave/shared`：实现时必须添加 workspace 依赖并修通 TypeScript/Vite 解析，不能在 App 内复制协议类型。
- App 登录 token 存储与 Web cookie 模式不同：不要照搬 Web cookie 逻辑，必须通过 `X-Auth-Client: app` 走 body refresh token 分支；如果后端还只识别 `electron`，先扩展认证协议再实现 App 登录。
- `lastActivityAt` 是新增字段，需要迁移历史 session：读取旧记录时用 `createdAt` 作为默认值，避免老数据缺字段；活动时间持久化允许秒级到十几秒误差，换取低写放大。
- 最近输出不是本期 App item 字段；如果后续确认要展示，继续扩展 `TerminalMobileOverviewSession`，不要新增第二套 overview endpoint。
- iOS WebView CORS 与请求目标地址是两个问题：非本地请求目标固定为 `https://runweave.jackshen310.cn`，同时后端必须通过 `FRONTEND_ORIGIN` 放行 `capacitor://localhost`。

## 草图说明

本计划对应的 image2 草图已保存到 `docs/plans/assets/2026-06-08-ios-app-home-meaningful-item-image2.png`。草图包含一张 iPhone 深色首页：

- 顶部 Runweave 标识。
- 搜索框。
- 项目分组列表。
- 每个项目下展示终端行，呈现 `TerminalMobileOverviewSession` 提供的标题、cwd、状态和最近活动时间；标题示例为 `activeCommand · cwd basename`，不展示 git branch 或最近输出 preview。
- 无新增项目按钮。
- 底部只保留轻量导航或当前页状态，不强行设计新增终端入口。
