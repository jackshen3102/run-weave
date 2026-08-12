# Terminal Browser Agent 工作组体验收口实施计划

> 状态：需求已完成 grilling，待实现
> 粒度：L3（跨 shared、Electron、renderer 与本地持久化，包含 schema 迁移和真实桌面验收）
> 代码基线：`feat/evolution-reflection-workflow@0063a3e`
> 配套测试计划：`docs/testing/terminal/terminal-browser-agent-work-groups.testplan.yaml`

## 结论

本轮把 Terminal Browser 明确收口为 **Agent 工作浏览器**：用户需要同时看懂页面是什么、页面属于哪个
Agent 控制边界、自动化是否已连接或正在操作；不把它扩展成通用 Chrome、独立浏览器 Profile 或 Agent
调度控制面。

主界面仍是一行平铺 Tab，不增加第二行、工作组标题胶囊、展开/折叠或新的常驻工具按钮。同一
`browserGroupId` 的 Tab 保持相邻，通过连续同色细线、组间距和少量状态点表达工作组；完整组名只在悬停
和现有 Tab 总览中出现。Tab 的主要身份改为真实 favicon 与页面标题。

`browserGroupId` 继续是 scoped CDP endpoint 的权限边界。工作组名称、顺序和成员关系由 Electron 主进程
持有并持久化；renderer 不再凭颜色、Tab 相邻位置或本地临时状态推断控制边界。

## 当前代码事实

| 领域            | 当前实现                                                                                                                    | 本计划判断                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Group 语义      | `browserGroupId` 过滤 `/json/list`、target discovery 和 attach；page-open 与 scoped `Target.createTarget` 继承 opener/group | 保留为 Agent/自动化可见性边界，不映射成 Agent 身份                          |
| Tab 创建        | renderer 先生成本地 Tab；Electron 在 `navigate/show` 时按需创建 `WebContentsView`；手动新 Tab 默认产生新 group              | 改为 Electron 主进程权威创建，显式区分“当前组新页面”和“新工作组”            |
| Tab 排序        | renderer 发送整个窗口的 Tab 全排列，主进程只校验是否为 live tab 全排列                                                      | 改为 group-scoped 排序，主进程拒绝跨组移动                                  |
| Group 展示      | 每个 Tab 左侧重复一条随机色竖线，tooltip 只显示 group id 后六位                                                             | 改成同组连续细线；完整可读组名只在悬停和总览显示                            |
| 页面身份        | 所有页面固定使用 `Globe2`，状态中没有 favicon                                                                               | 增加主进程采集和净化后的 favicon data URL，失败时 renderer 用域名首字母兜底 |
| 自动化状态      | `cdpProxyAttached` 表示已附着；用户可感知命令将 `mcpActivityUntil` 延长 4.5 秒；当前整个 Tab 变绿并显示 MCP                 | 保留状态语义和 4.5 秒窗口，改成“组级弱连接点 + Tab 级短暂操作点”            |
| 导航错误        | renderer 的主动导航错误可写入 `tab.error`；主进程 `did-fail-load` 只记 Activity，不通知后台 Tab                             | 主进程补齐 main-frame 导航失败状态，后台 Tab 和所属组显示弱错误点           |
| 持久化          | `terminal-browser-tabs.json` schema v1 平铺保存 Tab、active id 和 `browserGroupId`，最多恢复 5 个 Tab                       | 升级 v2，增加 group 元数据并保留兼容 flat tabs，旧版可回滚读取              |
| Browser Profile | 所有 WebContentsView 使用 `persist:runweave-terminal-browser`；Cookie、缓存、代理和 Headers 全局共享                        | 保持，不把工作组误作账号/Profile 隔离                                       |
| 作用域          | live Tab 按 `BrowserWindow.id` 管理；Browser 工具不随 project/terminal session 切换                                         | 保持桌面窗口级；`terminalSessionId` 仍只服务批注等既有链路                  |

关键代码入口：

- `electron/src/terminal-browser-runtime.ts`
- `electron/src/terminal-browser-view-lifecycle.ts`
- `electron/src/terminal-browser-tabs.ts`
- `electron/src/terminal-browser-tabs-state.ts`
- `electron/src/terminal-browser-handlers.ts`
- `electron/src/terminal-browser-cdp-proxy-messages.ts`
- `packages/shared/src/desktop-bridge.ts`
- `frontend/src/features/terminal/preview-browser-slice.ts`
- `frontend/src/components/terminal/use-terminal-browser-controller.ts`
- `frontend/src/components/terminal/terminal-browser-tabs.tsx`
- `frontend/src/components/terminal/terminal-browser-tab-overview.tsx`

## 目标

1. 用户在有限宽度内优先通过 favicon 与标题识别页面，通过轻量分组线识别控制边界。
2. 同一工作组的页面始终相邻，Group 与 Tab 排序不会产生 UI 归属和 CDP 权限不一致。
3. `+` 在当前工作组新增页面；低频“新建工作组”进入 Tab 总览，不弹命名框。
4. 工作组自动获得稳定名称，允许在总览重命名；名称、组序和成员关系可恢复。
5. 自动化“已连接”和“近期正在操作”分别表达，选中态、页面身份与错误态不再被大面积绿色覆盖。
6. 后台页面导航失败可被发现；切入页面后继续使用现有错误横幅展示详情，成功导航后自动清除。
7. 用户始终可以直接操作或关闭页面；本轮不增加虚假的“暂停 Agent”或“人工接管”。

## 非目标

- 不制作通用 Chrome 替代品，不增加书签、历史中心、下载中心、扩展或完整浏览器设置。
- 不增加工作组展开/折叠、第二行标题、大卡片、常驻组名或工作组排序。
- 不增加 Agent 身份、任务/run/thread/session 绑定；一个 group 仍可能被多个 CDP client 连接。
- 不增加跨组拖拽；不通过任何隐式 UI 操作改变 scoped CDP 权限边界。
- 不拆分 Cookie、缓存、登录态、代理或 Header 配置；工作组不是 Profile 或无痕窗口。
- 不改变工具栏功能、按钮位置、状态显隐和原生 More 菜单。
- 不增加或接管浏览器快捷键。
- 不改变人和 Agent 并发操作语义，不增加 pause、takeover、lock 或 ownership 协议。
- 不改变 `shouldMarkTerminalBrowserMcpActivity` 的命令集合和 4.5 秒活动窗口。
- 不新增或修改单元测试代码；使用 YAML 测试合同、静态门禁和真实 Electron/Playwright 验收。
- 不解决多窗口布局恢复；运行时保持每个 `BrowserWindow` 独立，重启仍由首个主窗口承接当前 profile 的恢复集合。

## 用户可见规则

### 1. 工作组与页面

1. 所有页面 Tab 保持在同一行，所有工作组默认可见，不提供展开或折叠。
2. 同一工作组的 Tab 必须连续；组内间距沿用紧凑 Tab 间距，组间使用更大的固定间距。
3. 每组顶部绘制一条连续的稳定色细线，颜色继续由 `browserGroupId` 确定；不常驻显示组名。
4. 分组线或其无占位锚点提供完整组名 tooltip 和可访问名称。
5. 空间不足时继续使用现有宽度密度、横向滚动和 Tab 总览；分组不能增加第二行或挤占地址栏。

### 2. Tab 身份

1. 页面加载完成后显示真实 favicon 和页面标题。
2. 加载期间可用 spinner 暂时代替 favicon；完成后恢复 favicon。
3. favicon 不可用、下载失败或不安全时，使用 hostname 的首个可读字符；空白页使用通用页面图标。
4. favicon 只作视觉身份，`aria-label` 仍使用完整页面标题/URL；不能把图标当成唯一可访问名称。
5. favicon 不持久化，重启后由真实页面重新获取；恢复期间先显示 fallback，不能保留旧域名图标。

### 3. 工作组命名

1. 新组立即创建，不弹命名框，初始名称为“新工作组”。
2. 第一个页面首次取得非空、非 URL 占位的标题后，生成一次自动名称；无有效标题时使用 hostname。
3. 自动名称生成后保持稳定，组内后续打开、关闭或切换页面不能让名称跳变。
4. 总览允许重命名；输入按 Unicode 字符计数，trim 后必须为 1～40 个字符。
5. 用户名称保存后不再被页面标题覆盖；取消或保存失败保留旧名称。
6. v1 数据迁移时，以该 group 恢复顺序中的首个合法 Tab 标题/hostname 生成自动名称。

### 4. 创建规则

| 来源                                           | 归属与位置                                               |
| ---------------------------------------------- | -------------------------------------------------------- |
| Tab 行 `+`                                     | 在当前 active group 内创建空白页面，插入 active Tab 右侧 |
| Terminal 中人工打开链接                        | 在当前 active group 内创建页面，插入 active Tab 右侧     |
| 总览“新建工作组”                               | 新建 group 和空白页面，group 追加在末尾并激活            |
| 页面 `target=_blank` / tab-style `window.open` | 继承 opener group，插入 opener 右侧                      |
| scoped CDP `Target.createTarget`               | 继承 endpoint group，按现有 opener/末尾规则插入          |
| unscoped CDP `Target.createTarget`             | 创建新 group，追加在末尾                                 |
| 所有组均为空后的 fallback                      | 创建一个新 group 和空白页面并激活                        |

弹窗式 OAuth `new-window` 继续走真实 popup，不进入工作组，保持现有行为。

### 5. 排序规则

1. Tab 只能在所属工作组内拖拽排序。
2. 工作组按创建顺序排列，不提供整体拖拽或总览排序。
3. renderer 的排序请求必须携带 `browserGroupId` 和该组完整 tab id 排列。
4. Electron 主进程校验 group 存在、Tab 集合完全相等、无重复、无跨组 id；任一不满足即 fail closed。
5. renderer 可先做组内乐观排序；IPC 失败后必须重新读取主进程 workspace，不能保留假顺序。

### 6. 连接、活动与错误状态

1. group 内任一 Tab 的 `cdpProxyAttached=true` 时，分组线上显示安静的连接点；不改变 Tab 选中背景。
2. 某 Tab 的 `mcpActivityUntil > now` 时，仅该 Tab 的 favicon 附近显示短暂动态操作点；不再显示常驻 `MCP` 文本或整块绿色背景。
3. 连接点表示“Agent/自动化已连接”，不表示 Agent 身份、所有权或持续执行。
4. 操作点仍只代表现有 CDP 命令分类命中的 4.5 秒活动窗口。
5. main-frame 导航失败且错误不是 `ERR_ABORTED/-3` 时，该 Tab 显示小红点，所属 group 显示弱错误端点。
6. 激活失败 Tab 后，现有 `TerminalBrowserErrorBanners` 展示错误文本；下一次成功主 frame 导航清除错误点和横幅。
7. favicon 获取失败不属于导航失败，不显示错误点或全局 Toast。

### 7. 关闭规则

1. 单个 Tab 始终直接关闭；Agent 已连接或正在操作也不增加确认。
2. 关闭组内最后一个 Tab 时同步删除空工作组。
3. 总览关闭只有一个页面的工作组时直接关闭；关闭多页面工作组时显示一次批量确认。
4. 取消确认不改变任何 target、active Tab 或顺序。
5. 批量确认后，主进程关闭该组所有 Tab，并为每个 target 发送现有 destroyed/detached 事件。
6. 若关闭后没有任何页面，主进程只创建一个 fallback 空白组，不能在批量循环中创建多个空白组。
7. 用户关闭行为不因 CDP client 状态被禁止；Agent 侧按既有 target 销毁协议自行收敛。

### 8. 作用域与共享环境

1. 工作组属于当前 Electron `BrowserWindow`，不随 project 或 terminal session 切换。
2. 不把 group 名称、endpoint 或 Agent 运行态写入项目、Terminal 或后端数据。
3. 所有组继续使用 `persist:runweave-terminal-browser`，共享 Cookie、缓存和登录态。
4. 代理和 Header 继续是 Terminal Browser session 全局设置，对所有组生效。
5. 工作组 UI 必须避免“独立账号”“隔离环境”等会暗示 Profile 隔离的文案。

## 共享合同与状态所有权

### Shared 类型

新增 `packages/shared/src/terminal-browser-workspace.ts`，并从 package exports 与 `src/index.ts` 导出：

```ts
export type TerminalBrowserGroupNameOrigin =
  | "placeholder"
  | "automatic"
  | "user";

export interface TerminalBrowserGroupSnapshot {
  id: string;
  name: string;
  nameOrigin: TerminalBrowserGroupNameOrigin;
  tabIds: string[];
}

export interface TerminalBrowserWorkspaceSnapshot {
  revision: number;
  activeTabId: string;
  groups: TerminalBrowserGroupSnapshot[];
  tabs: TerminalBrowserTabSnapshot[];
}

export type TerminalBrowserCreateTabRequest =
  | {
      placement: "current-group";
      groupId: string;
      openerTabId: string;
      url?: string;
    }
  | { placement: "new-group"; url?: string };
```

`TerminalBrowserUpdate` / `TerminalBrowserTabSnapshot` 增加：

```ts
faviconDataUrl: string | null;
navigationError: string | null;
```

约束：

- `browserGroupId` 仍是 CDP 权限事实；`TerminalBrowserGroupSnapshot.id` 必须与它完全相同。
- group 的 connected/error 状态不进入 shared group record，由 renderer 从成员 Tab 的 live 字段推导。
- `revision` 是窗口级单调递增结构/状态序号，不持久化；renderer 只应用比已知 revision 更新的事件或初始快照。
- 不在 Tab 上复制 group name/order，避免双重事实源。

### Bridge 与 IPC

把结构性操作收口为窄 bridge：

```ts
terminalBrowserGetWorkspace(): Promise<TerminalBrowserWorkspaceSnapshot>
terminalBrowserCreateTab(request): Promise<void>
terminalBrowserRenameGroup(groupId: string, name: string): Promise<void>
terminalBrowserCloseGroup(groupId: string): Promise<void>
terminalBrowserReorderGroupTabs(groupId: string, orderedTabIds: string[]): Promise<void>
onTerminalBrowserStateChanged(listener): () => void
```

`onTerminalBrowserStateChanged` 使用一个有序 union event channel，携带 `revision`：

- `kind: "workspace"`：创建、关闭、重命名、fallback 和排序等结构变化，携带完整 workspace。
- `kind: "tab"`：标题、URL、favicon、loading、navigationError、attached/activity、设备与缩放变化，携带单 Tab update。

renderer 必须先订阅再读取初始 workspace，并按 revision 丢弃过期响应，避免“事件先到、list 后到”回滚状态。
完成迁移后移除旧的全窗口 `list-tabs/reorder-tabs` 双写路径和 renderer 本地结构事实；不要长期保留两个权威 API。

### Electron runtime

`electron/src/terminal-browser-runtime.ts` 增加每窗口 workspace 元数据：

```ts
interface TerminalBrowserGroupRecord {
  id: string;
  name: string;
  nameOrigin: TerminalBrowserGroupNameOrigin;
  tabIds: string[];
}
```

建议新建 `electron/src/terminal-browser-workspace.ts`，集中负责：

- 创建/删除 group 和 tab membership；
- group 内插入、排序与完整性校验；
- active Tab fallback；
- 生成 workspace snapshot 与 revision event；
- 从 live entries 协调 group registry，清除空组；
- 批量关闭结束后只创建一个 fallback；
- 为 page-open、CDP create、restore 和 user create 提供同一入口。

`terminalBrowserEntry.browserGroupId` 继续保留，workspace helper 每次结构变更都断言 entry group 与 group
membership 一致。`tabOrderByWindowId` 在迁移完成后删除或改为由 group records 单向派生，不能与
`groups[].tabIds` 并列成为第二份可写顺序。

### Renderer store

`browser` 状态改为：

```ts
browser: {
  revision: number;
  groups: TerminalBrowserGroupSnapshot[];
  tabs: TerminalBrowserTabState[];
  activeTabId: string;
}
```

renderer 只负责：

- 应用 revision 有序的 workspace/tab event；
- 派生 `tabsByGroup`、connected、active、error 与 activity 展示状态；
- 组内乐观排序失败后的 workspace resync；
- 地址输入编辑期间继续保留现有“不被后台 URL update 覆盖”的规则。

renderer 不生成最终 group id、不修改 Tab 的 `browserGroupId`、不在关闭最后一页时本地猜测 fallback。

## 持久化、迁移与回滚

### Schema v2

`terminal-browser-tabs.json` 写入：

```ts
interface TerminalBrowserPersistedStateV2 {
  version: 2;
  activeTabId: string | null;
  groups: Array<{
    id: string;
    name: string;
    nameOrigin: TerminalBrowserGroupNameOrigin;
    tabIds: string[];
  }>;
  tabs: TerminalBrowserPersistedTabRecord[];
}
```

`tabs` 继续包含 v1 已有的 `id/url/title/lastActiveAt/browserGroupId`，作为回滚兼容 flat view；v2 的 group
数组是新版本的成员、组序和名称事实源。写入前必须从同一 live workspace 一次性生成两者，并检查：

- group id 唯一；
- tab id 全局唯一；
- 每个 tab 只出现于一个 group，且 `tab.browserGroupId === group.id`；
- group `tabIds` 并集与 flat tabs 完全相等；
- 无空 group；active id 必须属于 tabs。

不持久化：favicon、navigation error、`cdpProxyAttached`、`mcpActivityUntil`、DevTools、设备模式、缩放、
annotation 和任何 Agent 身份/endpoint。

### v1 → v2

1. 读取 v1 flat tabs，按首次出现的 `browserGroupId` 建立 group 顺序并保持组内原 Tab 顺序。
2. 用每组首个合法 Tab 的 title/hostname 生成自动名；无合法页面时使用“新工作组”。
3. 继续应用最多恢复 5 个 Tab 的现有策略；裁剪后移除空组并修正 active id。
4. 首次结构或 Tab 更新后写回 v2；不要在纯读取时无条件覆盖原文件。
5. v2 字段局部损坏时，以合法 flat tabs 重建 group；整文件不可解析时继续使用现有 `.bad-<timestamp>` 备份。

### 回滚

- v2 保留 v1 flat `tabs`，旧客户端忽略 `groups` 后仍可恢复页面和 `browserGroupId`。
- 若旧客户端运行后重新写为 v1，新客户端再次按上述规则迁移；自定义组名可能丢失，但 URL、Tab 和权限分组不丢失。
- favicon 和运行时状态不写盘，因此回滚不需要清理图片、连接或错误字段。

## favicon 与导航错误安全边界

### favicon

建议新增 `electron/src/terminal-browser-favicon.ts`：

1. 监听目标 WebContents 的 `page-favicon-updated`。
2. 只处理 `http:`、`https:` 和受限 `data:image` 候选；拒绝 `file:`、`javascript:`、任意 `blob:` 和未知协议。
3. HTTP favicon 使用 Terminal Browser 自己的 persistent session 获取，不能让 Runweave 主 renderer 直接请求远端 URL。
4. 对响应字节和解码尺寸设置上限，通过 Electron `nativeImage` 解码并重新编码成小尺寸 PNG data URL；不把任意 SVG/HTML 原文送入 renderer。
5. 导航到新 main-frame origin 时先清空旧 favicon；最新异步 favicon 结果必须核对 tab 与导航 generation，防止旧请求覆盖新页面。
6. 获取或解码失败静默回退，不影响页面导航，不写全局错误横幅。

### 导航错误

`TerminalBrowserEntry` 增加 `navigationError: string | null`：

- main-frame `did-start-navigation` 清除旧错误；
- main-frame `did-fail-load` 在非 `ERR_ABORTED/-3` 时保存经过长度限制的安全描述并发送 update；
- `did-navigate` / `did-navigate-in-page` 成功时确认清除；
- subframe 失败、favicon 失败和被取消导航不设置 Tab 错误；
- renderer 主动 `loadURL` reject 与主进程事件最终收敛到同一字段，不维持两套错误事实。

## 文件范围与实施任务

### 任务 1：建立共享 workspace 合同

修改/新增：

- `packages/shared/src/terminal-browser-workspace.ts`（新增）
- `packages/shared/src/desktop-bridge.ts`
- `packages/shared/src/index.ts`
- `packages/shared/package.json`
- `electron/src/preload.ts`
- `frontend/src/types/desktop-bridge.d.ts`（若仍有显式声明需同步）

工作：

- 定义 workspace/group/create/event 类型、favicon/error 字段和窄 IPC。
- 用单一 ordered state event 替代多个可能竞态的结构事件。
- 保持 CDP endpoint、proxy/header/device/display scale/annotation bridge 不变。

验证：

- shared、Electron、frontend typecheck 均通过。
- bridge 请求/响应只引用 shared 类型，没有 frontend/electron 复制 DTO。

### 任务 2：主进程建立工作组权威状态

修改/新增：

- `electron/src/terminal-browser-workspace.ts`（新增）
- `electron/src/terminal-browser-runtime.ts`
- `electron/src/terminal-browser-tabs.ts`
- `electron/src/terminal-browser-view-lifecycle.ts`
- `electron/src/terminal-browser-proxy-api.ts`
- `electron/src/terminal-browser-handlers.ts`
- `electron/src/terminal-browser-cdp-proxy-messages.ts`

工作：

- 所有 user/page/CDP/restore 创建入口统一登记 group 与 membership。
- `+`/Terminal link 走 current group；总览显式创建新 group；page/scoped CDP 继承；unscoped CDP 新建。
- group 内插入与排序由主进程校验，跨组请求 fail closed。
- 单页、批量组关闭和 WebContents 意外销毁共用清理；仅在全部为空时创建一个 fallback。
- 结构变化一次递增 revision 并发送完整 workspace；不在批量循环中发多个中间假状态。
- 保持现有 `Target.targetDestroyed`、detach、connection ref-count 和安全过滤。

验证：

- TBWG-001、TBWG-002、TBWG-005、TBWG-006。
- `pnpm architecture:check` 不出现 frontend → Electron 或重复协议违规。

### 任务 3：完成 v2 持久化和双向兼容

修改：

- `electron/src/terminal-browser-tabs-state.ts`
- `electron/src/terminal-browser-tabs-persistence.ts`
- `electron/src/terminal-browser-tabs.ts`
- `electron/src/terminal-browser-view-lifecycle.ts`

工作：

- 增加严格 v1/v2 normalizer、v1 迁移、v2 group/flat 一致性校验和安全降级。
- 保留最多恢复 5 个 Tab、active Tab、URL 协议过滤和坏文件备份。
- 持久化组名、组序和成员顺序；不持久化 favicon/error/Agent 状态。
- 恢复后重新加载页面并重新获取 favicon，运行态连接统一从 disconnected 开始。

验证：

- TBWG-009、TBWG-010。
- 使用隔离 Dev Session 的 owned user-data，不读写 Stable 用户真实文件。

### 任务 4：补齐 favicon 与后台导航错误链路

修改/新增：

- `electron/src/terminal-browser-favicon.ts`（新增）
- `electron/src/terminal-browser-runtime.ts`
- `electron/src/terminal-browser-view-lifecycle.ts`
- `electron/src/terminal-browser-view-updates.ts`
- `packages/shared/src/desktop-bridge.ts`
- `frontend/src/components/terminal/terminal-browser-model.ts`
- `frontend/src/features/terminal/preview-store-types.ts`

工作：

- 安全获取、generation 校验、净化和 IPC 传递 favicon data URL。
- 将 main-frame navigation error 变成主进程 live 状态，并与现有 renderer 错误展示收敛。
- 更新 tab update key，确保 favicon/error 变化会发送但不产生无限 update。

验证：

- TBWG-003、TBWG-008。
- 手工检查 IPC/log 不包含 Cookie、Header 或任意 favicon 响应正文。

### 任务 5：renderer store 与 controller 迁移

修改：

- `frontend/src/features/terminal/preview-store-types.ts`
- `frontend/src/features/terminal/preview-browser-slice.ts`
- `frontend/src/components/terminal/terminal-browser-model.ts`
- `frontend/src/components/terminal/use-terminal-browser-controller.ts`
- `frontend/src/components/terminal/terminal-browser-tool.tsx`
- `frontend/src/components/terminal/terminal-surface.tsx`

工作：

- store 保存 revision/groups/tabs/activeTabId，结构由主进程 workspace 驱动。
- 先订阅后 get，按 revision 应用事件；编辑地址时继续保护用户输入。
- 暴露 current-group create、new-group create、rename、close-group 和 group reorder handlers。
- Terminal 链接使用当前 active group；bridge 失败保留当前 workspace 并显示可恢复错误。
- handler 使用 `useMemoizedFn`，除非有明确第三方 identity 约束，不引入 `useCallback`。

验证：

- 快速连续创建、关闭、page-open 和 Agent create 后 renderer 与 `terminalBrowserGetWorkspace` 完全一致。
- IPC reject 后重新同步，不出现幽灵 Tab、空 group 或重复 fallback。

### 任务 6：一行 Tab 与总览 UI 收口

修改：

- `frontend/src/components/terminal/terminal-browser-tabs.tsx`
- `frontend/src/components/terminal/terminal-browser-tab-utils.ts`
- `frontend/src/components/terminal/terminal-browser-tab-overview.tsx`
- `frontend/src/components/ui/sortable-tabs.tsx`（仅当 group-scoped context 需要通用能力时修改）

工作：

- 按 group 渲染相邻 Tab wrapper、连续细线、组间距和无占位状态点。
- 宽度计算纳入组间额外 gap，保留 active 最小 80、inactive 最小 44、关闭冻结和自动滚动。
- 使用 favicon/spinner/fallback 字符；移除整 Tab MCP 绿色和 `MCP` 文本 badge。
- Tab error 红点、group connected/error 状态不改变选中态。
- 总览按 group 分段搜索 title、URL、group name/id；支持新建组、重命名和批量关闭。
- 只有多页面整组关闭显示确认；主 Tab 行单页关闭始终直接执行。
- toolbar 与 `terminal-browser-navigation-bar.tsx` 不改行为和布局。

验证：

- TBWG-003 至 TBWG-008。
- 使用 desktop surface 的 `$toolkit:playwright-cli` 检查真实 renderer DOM、焦点、滚动与可访问名称；Terminal Browser surface 只操作真实页面。

### 任务 7：同步架构文档与测试合同

修改：

- `docs/architecture/terminal-code-preview.md`
- `docs/testing/terminal/terminal-browser-agent-work-groups.testplan.yaml`

工作：

- 将手动新建默认新 group、flat v1 持久化和重复竖线等旧描述更新为最终合同。
- 保持现有 CDP 权限、安全命令和 Browser Profile 说明不变。
- 不把测试计划写成 Markdown，不增加 selector/assertion/evidence 等 schema 外字段。

## 错误处理与失败边界

| 场景                                | 必须行为                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| 新建页面/工作组 IPC 失败            | 不插入本地幽灵 Tab；保留原 active，展示可恢复错误                              |
| 重命名校验失败                      | 保留原名和原 `nameOrigin`，输入框可继续修改                                    |
| 组内排序 IPC 拒绝                   | 立即从主进程重新获取 workspace，回滚乐观顺序                                   |
| 批量关闭中 target 已被 Agent 先关闭 | 以 live workspace 为准幂等清理，其余成员继续关闭，结束后只发一个最终 workspace |
| favicon fetch/decode 超时或失败     | 静默使用 fallback，不污染 navigation error                                     |
| 导航被新导航取消                    | `ERR_ABORTED/-3` 不显示错误点；较新的导航 generation 获胜                      |
| v2 group 元数据损坏                 | 从合法 flat tabs 重建；URL 和控制分组优先于自定义组名                          |
| 整个持久化文件不可解析              | 备份 `.bad-<timestamp>`，创建单一空白工作组                                    |
| 过期 IPC/event 到达                 | revision 门禁丢弃，不覆盖更新状态                                              |

## 验证与验收

### 测试计划格式

```bash
pnpm testplan:validate docs/testing/terminal/terminal-browser-agent-work-groups.testplan.yaml
pnpm testplan:verify
```

### 静态门禁

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/electron lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
git diff --check
```

静态门禁只证明类型、lint、架构和文档格式，不是 UI、BrowserView、CDP 或恢复行为通过。

### 真实桌面验收

1. 使用 `$toolkit:runweave-dev-session` 从当前 patch 边界启动隔离 Dev Session。
2. 使用 `$computer-use` 打开该 Session 对应的真实 Electron 窗口和 Terminal Browser sidecar。
3. 从同一 manifest 取得 desktop 和每个目标 group 的 terminal-browser scoped endpoint；不得使用 ambient/global endpoint 猜目标。
4. 使用 desktop surface 的 `$toolkit:playwright-cli` 验证 Tab strip、总览、确认框、错误横幅和可访问属性。
5. 使用 terminal-browser surface 的 `$toolkit:playwright-cli` 导航、打开页面、触发 favicon、页面派生 Tab 和真实操作。
6. 独立 raw CDP connection 只用于验证 scoped/unscoped `Target.createTarget` 与 target destroyed；记录 groupId/targetId 对应关系。
7. 使用 `$toolkit:run-test-cases` 执行配套 YAML；任一 required case 失败即停止并保留现场。
8. 完成后关闭 owned Tab、断开 CDP、停止 Dev Session，并确认 manifest cleanup 完成且没有 owned fixture 残留。

## 完成标准

- TBWG-001 至 TBWG-012 全部 required case 通过。
- 主界面没有新增第二行、展开折叠、常驻组名、工具按钮或快捷键。
- favicon + 标题成为 Tab 主身份；同组连续、跨组不可拖拽，UI membership 与 scoped CDP target 完全一致。
- Agent 连接、操作、后台错误三类状态可区分，且不覆盖 active Tab 选中态。
- v1/v2 双向回滚路径验证通过；最多恢复 5 个 Tab，组名/组序/成员和 active Tab 按合同恢复。
- 真实 Electron、desktop renderer 和 terminal-browser CDP 证据来自同一 Dev Session；静态检查没有被当作行为证据。
- 工作区仅包含本计划范围内的实现/文档改动，用户原有改动未被覆盖或重排。
