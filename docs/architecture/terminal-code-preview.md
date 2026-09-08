# Terminal 代码预览、Browser 与原型库

本文维护当前行为和跨运行时边界。具体类型、模块拆分与命令参数以链接源码为准；历史实施步骤和草图不作为新任务。

## 代码入口与职责

| 边界                                     | 入口                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 工作台与 active Project                  | [Workspace](../../frontend/src/components/terminal/workspace/workspace.tsx)                                                      |
| Preview 数据与操作                       | [Panel](../../frontend/src/components/terminal/preview/panel/index.tsx)                                                          |
| 项目选择、视图与宽度状态                 | [Preview store](../../frontend/src/features/terminal/preview/store.ts)                                                           |
| 文本、Markdown、SVG、图片与 Diff 渲染    | [Renderers](../../frontend/src/components/terminal/preview/renderers/)                                                           |
| 文件与搜索 HTTP 路由                     | [Preview routes](../../backend/src/routes/terminal/preview/)                                                                     |
| 路径权限、文件操作、搜索与 Git           | [Preview service](../../backend/src/terminal/preview/)                                                                           |
| 跨运行时 DTO 与链接解析                  | [Preview types](../../packages/shared/src/terminal/preview.ts)、[纯函数合同](../../packages/shared/src/terminal/preview-core.ts) |
| 原生 Browser、Profile、CDP 与 Automation | [Electron Browser](../../electron/src/browser/)                                                                                  |

Preview 是 Terminal 的辅助上下文，提供 Files、Explorer 和 Review changes。它支持受限的文件编辑，
不承担完整 IDE、LSP、扩展宿主、批量文件管理或 Git 提交。终端输出与恢复仍由
[Terminal Surface](../../frontend/src/components/terminal/surface/) 和终端连接链路负责。

## 项目与状态归属

- 搜索、目录、Git 与相对路径以当前生效 Project 的 `path` 为根；该 Project 可以是父项目或 Worktree 子项目。
  不从 terminal 的实时 `cwd` 推断根目录。解析规则见 [Worktree Context](./terminal-worktree-context.md)。
- Project 没有有效路径时显示设置路径的错误，不退回 session cwd。切换同一 Project 内的 terminal 不重置预览内容；
  切换 Project 后读取目标 Project 的选择与视图状态，不能继续展示旧项目的 diff。
- store 按 Project 保存文件选择、查询、Changes 选择和 Markdown/SVG 视图，并持久化 `projects`；
  Sidecar 宽度单独持久化。当前初始化 `ui.open=true`，不能沿用旧方案的“默认关闭”假设。
- 普通 Sidecar 宽度由 store 限制在 320px 与视口 60% 之间；展开状态独立管理。关闭后释放布局空间。
- Preview 操作入口、可见工具及桌面/移动布局由 [Workspace Header](../../frontend/src/components/terminal/workspace/header.tsx)
  和 Panel 决定，不在文档中复制按钮位置或像素级布局。

## 文件查找与读取

- Files 文件名搜索、Explorer 懒加载目录以及快速搜索共用后端的项目路径与过滤边界。快速搜索另有内容和目录模式；
  前端按返回顺序显示结果，不复制后端排序。入口见 [Quick Search](../../frontend/src/components/terminal/preview/search/use-quick-search.ts)。
- 搜索只返回项目内候选；扫描上限、忽略规则、缓存与排序以
  [候选枚举](../../backend/src/terminal/preview/search-candidates.ts)、[搜索](../../backend/src/terminal/preview/search.ts)
  和 [内容搜索](../../backend/src/terminal/preview/content-search.ts) 为准。
- Explorer 每次只取一层 children，按需展开，超限返回 `truncated`；刷新重新读取所需目录，不依赖文件系统监听。
- 显式输入绝对路径可以只读打开项目外文件；它不进入搜索候选。相对路径和 symlink 经 realpath 校验不能逃逸项目根。
  `~` 不展开。规则见 [路径解析](../../backend/src/terminal/preview/paths.ts)。
- 文本读取只接受普通文件，当前上限 1 MiB，二进制、目录和特殊文件拒绝。
  图片走独立 asset 响应，当前上限 5 MiB，检查内容与 MIME，并使用 `no-store`。
  限制与支持格式以 [文件服务](../../backend/src/terminal/preview/preview.ts) 为准。
- 读取失败保留可恢复的选择与输入，不能把失败响应当作空文件。Refresh 重读当前对象；Copy path 复制可定位路径，
  优先使用后端绝对路径，缺失时由 Project path 补齐；行引用通过渲染器选择范围产生，不复制整份正文作为路径。

## 编辑、冲突与 Git

- 项目内已有普通文本/代码文件可在 Files 或 Explorer 显式编辑；响应的 `base`、`readonly` 和 `mtimeMs` 是判断依据。
  项目外 `base=filesystem`、Changes/Diff、图片、目录和不支持的文件保持只读。
- Save 或 `Cmd/Ctrl+S` 才写盘，不自动保存。提交 `expectedMtimeMs`；磁盘已变化时返回冲突，
  Reload 重新读取，Overwrite 显式覆盖。失败保留草稿。相关实现见 [文件编辑](../../frontend/src/components/terminal/preview/files/use-editor.ts)。
- 切换文件、刷新、关闭或改变任务时，涉及丢弃未保存草稿的动作须走现有确认流程。
- 删除、重命名只针对项目内支持的普通文件；不扩展到目录、项目外路径或批量操作。
- Review changes 分 Staged / Working 两组，先读索引，再按选择懒加载单文件 diff；Diff Editor 只读。
- 单文件 Reset Changes 需要确认：staged 执行 unstage，working 丢弃该文件工作区改动，untracked 普通文件删除。
  这不授权 stage、commit、checkout 或批量 reset。语义以 [Git service](../../backend/src/terminal/preview/git.ts) 为准。

## 内容渲染

| 内容          | 当前视图与边界                                                        |
| ------------- | --------------------------------------------------------------------- |
| 普通文本/代码 | Monaco；是否可编辑由文件能力决定，Diff 始终只读                       |
| Markdown      | 默认 Preview，可切 Source/Split；沿用文件编辑权限，不创建新的顶层任务 |
| 独立 SVG      | 默认 Preview，可切 Source；XML 经净化后在无权限 sandbox iframe 中预览 |
| 图片          | 独立 asset 读取；Web 使用公共图片预览与 lightbox，支持缩放和平移      |

Markdown 默认值以 store 为准，不能沿用旧草图中的 Split 默认值。Split 的滚动同步、行引用与选区行为见
[Markdown renderer](../../frontend/src/components/terminal/preview/renderers/markdown.tsx)。

- Markdown 使用 `markdown-it`，关闭 raw HTML，输出经 DOMPurify 净化；Mermaid 使用 strict 配置，错误局限在对应图块。
- 当前已支持通过鉴权 asset API 读取解析后的本地图片，不使用 `file://`。链接和资源解析统一使用 shared 纯函数合同，
  不能由页面内容绕过项目路径和协议检查。
- 独立 SVG 使用 [SVG renderer](../../frontend/src/components/terminal/preview/renderers/svg.tsx) 的净化与 sandbox，
  不把原始 XML 直接注入工作台 DOM。
- Monaco 与富内容渲染按需加载；只读能力不能仅靠隐藏按钮，后端写接口仍执行路径和文件类型校验。
- Web 图片基础能力属于 `packages/common`；原生 Swift 实现独立维护，不能由 Web 实现推断 iOS 已具备相同行为。

## 多项目原型轮巡库

`Prototypes` 是与代码 `Preview`、真实网页 `Browser` 并列的 Sidecar 工具。它解决的是多个项目中可运行 HTML 原型的统一发现和快速轮巡，不把 HTML 执行塞进 Monaco 文件预览，也不要求每个仓库单独启动端口。

项目来源只有一份 registry：Prototype Gallery 使用 `TerminalSessionManager.listAllProjectContexts()` 枚举父节点与 available Worktree 子 Project。对每个 context，后端只扫描 `<project.path>/docs/prototypes` 的一级真实目录，并返回以下状态：

- `available`：原型根目录可读，返回全部一级原型。
- `project-path-missing`：项目未设置本地 path。
- `prototype-root-missing`：项目存在，但没有 `docs/prototypes`。
- `prototype-root-unavailable`：项目路径或原型目录不可访问、不是目录或逃逸出项目根。

左侧按项目分组，每个原型以 `projectId + slug` 唯一定位，因此多个仓库使用相同 slug 不会互相覆盖。标题优先取 `index.html` 的 `<title>`，其次取 README H1，最后使用 slug。缺少 `index.html` 的目录仍展示，右侧给出缺入口与一级文件摘要。

有入口的原型不使用 `file://`。前端通过鉴权 API 申请 15 分钟的 `prototype-preview` ticket，再把 `/prototype-preview/:ticket/:projectId/:prototypeSlug/` 放入 `sandbox="allow-scripts"`、`referrerPolicy="no-referrer"` 的 iframe。ticket 同时绑定 project id 和 slug；URL path 保留这两个资源字段，使相对 JS、CSS、JSON 和图片请求继续落在同一原型范围内。

静态路由只接受 GET/HEAD，并对 project root、prototype root、prototype dir 和最终文件执行 realpath containment。响应禁用缓存，允许 opaque-origin iframe 读取本地资源，但不授予 iframe `allow-same-origin`。选择状态按 `{projectId, slug}` 保存到当前 `apiBase` 对应的 localStorage key；切换工具或重开 Sidecar 后恢复，列表刷新时再对磁盘事实做校验。

## 快捷指令

Terminal 顶栏右侧外露 `快捷指令` 入口，用户可通过固定快捷指令或最近输入复用提交类提示。前端不读取 Git 状态、不提交、不 push、不处理 rebase 冲突；这些仍由当前 terminal 中运行的 Codex、Coco 或其他 AI agent 完成。

快捷指令是 Web Terminal 的输入复用能力，不是 shell history。后端只持久化通过 Terminal HTTP input API 表达出的完整输入意图：`line`、`codex_slash_command` 和 `prompt_paste`。`raw`、tmux 控制输入、空文本、超过 64 KiB 的文本，以及明显包含 `password=`、`token=`、`api_key=`、`secret=`、`Authorization:` 的内容不会进入快捷指令记录。

稳定接口挂在 Terminal API 下：

- `GET /api/terminal/quick-inputs?projectId=<id>&q=<query>&kind=recent|pinned|all&limit=50`：查询当前用户可见的最近输入与固定项。
- `POST /api/terminal/quick-inputs`：保存固定快捷指令；同一 `data + mode + projectId` 命中已有项时更新并重新显示，不新增重复记录。
- `PATCH /api/terminal/quick-inputs/:id`：修改标题或固定状态。
- `DELETE /api/terminal/quick-inputs/:id`：软隐藏该项并取消固定；后续同内容再次成功发送会恢复为最近输入。
- `POST /api/terminal/quick-inputs/:id/used`：只用于复制或插入成功后的使用统计；快捷指令发送成功由 Terminal input 成功路径记录，避免双重计数。

列表只返回 `hiddenAt == null` 的记录。`kind=recent` 返回未固定项，`kind=pinned` 返回固定项，`kind=all` 固定项优先；最近输入最多保留 200 条，裁剪只影响未固定的可见 recent。

Web 交互边界：

- 面板打开后可浏览固定、最近和全部记录；没有 active terminal 时仍可查看和管理，但发送和插入禁用。
- `发送` 复用当前 session 的 Terminal input API，并携带 `quickInputSource: "web_terminal_quick_input"`。
- `插入` 只对不含 CR/LF 的 `line` 和 `codex_slash_command` 可用，实际以 `raw` 写入当前终端输入上下文，不自动提交；`prompt_paste` 和多行输入只能发送或复制。
- `复制` 与 `插入` 成功后调用 `/used` 更新 `lastUsedAt/useCount`。

## Terminal Browser 与 Automation

- Desktop Sidecar 一级工具包含 `Automation`、`Browser 1`、`Browser 2`、`Browser 3`。三个 Browser 入口对应应用进程全局的三个 Profile；Worktree 只提供默认选择和 Dev Server 端口，不拥有或复制 Profile。
- Electron 桌面端用 `WebContentsView` 承载 Browser tab，tab 生命周期和可见区域由主进程管理，前端只同步 tab 状态、地址栏、工具栏和面板布局。Profile 1 沿用 `persist:runweave-terminal-browser`，Profile 2/3 使用独立 partition，因此 Cookie、LocalStorage、IndexedDB、Cache Storage 和登录态天然隔离。
- Web/PWA 模式不提供本地 Electron Browser、Automation 或 CDP endpoint。
- Browser tab 只允许 `http:`、`https:` 和 `about:blank` 导航；页面发起的新窗口会被收口成 Browser 工具内的新 tab 或被拒绝。
- CDP Proxy 只监听 `127.0.0.1`，默认从 `9224` 开始找可用端口，并通过 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 传给 Runweave terminal 里的子进程。
- 如果显式设置 `RUNWEAVE_TERMINAL_BROWSER_CDP_PROXY_PORT`，端口必须是合法端口且不自动漂移；非法值会让 Electron 启动失败并给出明确错误。
- CDP Proxy 暴露的是自研 browser-level endpoint，不开启 Electron 全局 `remote-debugging-port`，也不暴露 Runweave 主窗口 renderer 或 DevTools target。
- Playwright MCP / Playwright CLI 通过 `rw browser profile resolve` 先按“本次显式指定 > 当前 Worktree 首选 > 全局默认”解析 Profile 和路由，再以 `chromium.connectOverCDP(...)` 连接返回的 scoped endpoint。显式覆盖不写回 Worktree 偏好。
- Terminal 中的 resolver 默认携带 `RUNWEAVE_TERMINAL_SESSION_ID`。未显式指定 Group 时，Electron 为该 Terminal 派生不含原始 ID 的稳定 Group，并用一次性内存 token 把 WebSocket connection 投影到 Automation；token 只用于 UI attribution，不扩大 `profileId + groupId` 的 CDP 权限。同一 Terminal 有活跃连接时只能绑定一个 Profile。
- CDP 仍只有一个 loopback 物理端口，逻辑 scope 为 `profileId + 可选 groupId`。无 `profileId` 的旧 endpoint 只映射全局默认 Profile，不汇总暴露三个 Profile。当前 tab 的 CDP/AI 按钮返回 Profile + Agent Control Group scoped WebSocket endpoint；`Target.getTargets`、discovery、auto-attach 和 target 操作都先过滤 Profile，再过滤可选 Group。
- Tab 行 `+` 和 Terminal 人工链接在当前 Profile 的当前 group 新建页面；页面或 scoped Agent 派生的新 tab 继承 opener 的 Profile/group；只有总览“新建工作组”和 profile-scoped、group-unscoped `Target.createTarget` 创建新 group。Group 是 Profile 内自动化可见性边界，不是 Agent 身份、Worktree 或 Profile。
- `Target.createTarget` 创建的是 Browser 工具内 AI tab，当前上限为 10；CDP 连接上限为 8。
- Proxy 负责 target/session 仿真、frame id 重写、导航参数校验、危险命令拦截和 DevTools 状态隔离。`Browser.close`、`Browser.crash`、清 cookie/cache/origin storage、忽略 HTTPS 错误等命令不能影响用户主窗口或真实 profile。
- 多个 CDP 客户端可以同时连接并操作不同 Browser tab。Proxy 对同一 target 复用同一个 Electron `webContents.debugger` attachment，但每个客户端仍使用自己的 proxy session id；任一客户端断开不应清理其他 target 的有效 session。
- CDP resolver、无 target 连接和 `Target.createTarget` 的窗口 fallback 只使用 `desktopRuntime.mainWindow`；Desktop Companion、临时捕获宿主和其它辅助窗口不能拥有 Browser workspace、Automation registry 或 target。
- Automation 按 Terminal/unattributed connection 聚合当前窗口内的受控 Group，所有 Tab 只展示元数据，始终最多一个 selected target 生产实时画面。默认跟随最近的点击、输入、滚动、导航或刷新；手动选择后固定，显式恢复后才继续跟随。观察面只读，“在 Browser 中打开”只 reveal 同一 tab。
- Automation 画面使用目标 `webContents.capturePage()`，最长边 640px、目标 5 FPS、单 in-flight，并由 renderer `<img>` load/error ACK 控制下一帧。fresh 未挂载或 0×0 的嵌套 View 只在 Automation 可见时进入临时 `BaseWindow` 合成宿主；必须先挂载后设置 bounds。产品 producer 不向外部 CDP 连接发送 screenshot/screencast 命令。
- 切出 Automation、收起 Sidecar、窗口隐藏/销毁、target 销毁或 connection 断开都会停止 producer、释放临时宿主和 frame bytes。连接、actor、动作、选择、指针和画面都不持久化。
- Group 细线上的连接点表示组内至少一个 target 已有 CDP client 附着；Tab favicon 附近的短暂操作点表示近期有 MCP/CDP session 命中该 target 的用户可感知操作。两者都不表示 Agent 身份、所有权或永久接管，也不改变 active Tab 选中背景。
- `Page.enable`、`Runtime.enable`、`Target.setAutoAttach`、`Target.getTargetInfo`、`Page.getFrameTree`、`Network.enable` 等初始化、发现或静默同步命令不触发操作点；导航、点击、输入、evaluate、截图等真实操作才让对应 Tab 短暂显示 4.5 秒活动状态。
- Browser 工具的 CDP 能力是桌面端本机自动化边界，不是远端协作协议；不要把 endpoint 持久化到项目数据或对公网暴露。
- Browser workspace 会以 schema v3 按 Profile 持久化到 Electron `userData` 下的 `terminal-browser-tabs.json`，包含 group 名称、顺序、成员顺序和 active Tab；favicon、导航错误、Whistle PID、runtime route、prompt override 和连接/活动状态不落盘。v1/v2 内容全部迁入 Profile 1，Profile 2/3 初始为空；每个 Profile 最多恢复 5 个合法 URL 的元数据，首次显式 resolve 且路由 ready 后才创建 `WebContentsView` 并导航。
- Browser tab strip 只让 tab viewport 横向滚动，总览与 New Tab 固定在 viewport 外。单 tab preferred width 为 180px；空间不足时 active 最小 80px、inactive 最小 44px；组内间距 4px、组间间距 12px，达到 minimum 后才产生横向 overflow。Tab 使用主进程净化后的 favicon 与页面标题作为主要身份，无 favicon 时回退 hostname 首字符或通用页面图标。
- Tab 内容按宽度分为 comfortable（`>95px`）、compact（`64～95px`）和 icon-only（`44～63px`）三档。active close 始终保留；inactive close 在非 icon-only 档通过 hover / focus 显示。总览按 group 分段，可按 title、URL、group name/id 搜索，并提供新建、重命名和关闭工作组；关闭多页面工作组需要一次批量确认。
- active tab 会在初始化、选择、新建、关闭、排序和 sidecar resize 后进入 tab viewport。Left / Right 循环切换相邻 tab，Home / End 切换首尾，并使用 active tab `tabIndex=0` 的 roving focus。
- 鼠标从 tab strip 连续关闭时，剩余 tab 按 tab id 保留关闭前像素宽度，pointer 离开整个 tab bar 后重新分配；touch / pen 在最后一次关闭 1.8 秒后解除。resize、拖拽、Overview 选择或外部 tab replace 会丢弃过期冻结宽度。
- Browser tab 只支持所属 group 内拖拽排序；Renderer 可先乐观更新，再通过 `terminal-browser:reorder-group-tabs` 提交 group id 与该组完整成员全排列。主进程拒绝缺失、重复或跨组 tab id，失败时 Renderer 强制读取同 revision workspace 回滚。工作组按创建顺序稳定，不提供跨组拖拽或整体排序。
- Electron workspace 是 group 名称、顺序、成员、active Tab 和结构 revision 的唯一事实源。Renderer 先订阅统一 `terminal-browser:state-changed` 事件再读取初始 workspace，只应用更新 revision，并从成员 Tab 推导 group 的连接与错误状态；不从颜色、相邻位置或本地临时 Tab 推断 CDP 权限。
- 主进程 main-frame 导航失败（排除 `ERR_ABORTED/-3`）会写入 Tab live `navigationError`；后台 Tab 和所属 group 显示弱错误点，激活后沿用错误横幅展示详情，下一次成功 main-frame 导航自动清除。favicon 下载或解码失败只回退图标，不进入导航错误。
- Browser 工具切到后台时只隐藏当前 WebContentsView，不清除该窗口的 selected tab；关闭 selected tab 或关闭窗口时才删除对应 active 映射，因此隐藏、重启和恢复不会把 active 身份回退到数组首项。
- 三个 Profile 进入 Whistle 模式时分别懒启动内置 `whistle@2.10.9`，固定监听 `127.0.0.1:8081/8082/8083`，使用 `profile-1/2/3` 独立 storage 和同一 certDir。Runweave 只维护保留 Value `runweave-dev-server`，不会创建、选择或改写用户 Rules 和其它 Values；`deploy/whistle/proxy.md` 是独立人工部署示例，不属于 Terminal Browser 默认规则。
- Profile runtime route 只有 `unassigned` 或 `dev-server:<port>`。Direct 模式恒为 `unassigned`，不参与 Worktree 端口冲突；Whistle 模式下同路由可以跨 Worktree/Agent 共享，不同路由在仍有可见 view 或 CDP 连接时返回冲突。Profile 空闲后切换只更新/删除保留 Value，并仅刷新配置的 business origin 页面，不清浏览数据或页面身份。
- 普通安装态的每个 Profile Session 默认使用所属 Whistle 代理；带独立 userData 的受管 Dev Session 默认直连，避免不使用业务代理的开发与端到端验收依赖固定 `8081/8082/8083`。两种运行态都可在 Profile 设置中临时切换模式；开关不持久化，应用重启后恢复该运行态的默认模式。Workspace Service 的 `*.localhost` 在两种模式下都保持 DIRECT，稳定 URL 与本地服务生命周期见 [Terminal Workspace Services](./terminal-workspace-services.md)。切换会关闭该 Profile 的既有网络连接并刷新其页面，但不停止 Whistle 或清理其 Rules、Values 与 storage。应用不修改系统代理。三个 Profile 只在自己的 `setCertificateVerifyProc` 中接受共享 Whistle Root CA 链，其它证书继续采用 Chromium 校验结果；主窗口和其它 Session 不继承该信任。
- `Headers` 面板只影响当前 Profile 的网页请求，不影响其它 Profile、Runweave 主窗口、登录/API 请求或 Electron 更新请求。
- Header 规则保存在 Profile-scoped `localStorage` key；旧 `terminal.browser.headerRules` 只在 Profile 1 首次成功同步时迁移一次。每个 Profile 分别同步到其 Electron Session dispatcher，保存失败会回滚本地存储并展示错误。
- Header 规则通过 `terminal-browser:get-header-rules` / `terminal-browser:set-header-rules` IPC 进入主进程。主进程做最终校验，最多 20 条，字段为 `enabled`、固定操作 `set`、`name`、`value`，URL 模式固定为 `*://*/*`，当前前端不暴露单条规则的 URL pattern 编辑。
- Header 名必须符合 HTTP token 形态，禁止控制字符、冒号以及 `host`、`content-length`、`connection`、`upgrade`、`proxy-authorization`、`set-cookie`。Header 值不能为空且不能包含控制字符。
- Electron 主进程为三个 Profile Session 各注册一个 `webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] })` dispatcher。dispatcher 只处理 `http:` / `https:` 请求，按所属 Profile 的规则列表顺序匹配固定全局 URL 模式；同名 Header 后命中的规则覆盖前面的规则。
- Header 规则变更只影响后续新请求。面板保存成功后会关闭面板；如需让当前页面主文档请求携带新规则，用户需要通过工具栏刷新当前 Browser tab。
- Browser 工具栏的地址输入框旁提供复制当前地址按钮，只复制当前 tab 的地址文本，不触发导航、分享或外部打开；复制成功后短暂显示完成状态。
- Browser 工具提供当前 tab 级别的设备模式。`Desktop` 是默认状态；切到移动设备时，当前支持 `iPhone SE`、`iPhone 14` 和 `Pixel 7` 三个预设，分别应用移动端 viewport、device scale factor、移动端 user agent 和 touch emulation。
- 设备预设定义在 `packages/shared/src/browser/device.ts`，由前端设备面板和 Electron 主进程共享。新建、恢复和 proxy-created tab 仍从 `Desktop` 开始，不继承其他 tab 的移动设备状态。
- 移动设备模式只作用于 Terminal Browser 的 Electron `WebContentsView`。前端负责设备入口、预设选择、手机画布布局和 bounds 同步；真实 emulation 在 Electron 主进程里通过目标 tab 的 `webContents.debugger` 落地。
- 移动设备画布使用显式缩放模型：前端计算设备逻辑 viewport、面板内展示 bounds 和 `emulationScale`，Electron `setBounds()` 使用展示 bounds，CDP emulation 使用逻辑 viewport 与 scale。不能用 CSS transform 代替 native view 缩放。
- 设备模式可与 CDP Proxy 共存：如果当前 tab 已附着 CDP Proxy，设备切换复用同一个 `webContents.debugger` 发送 emulation 命令；如果先进入移动设备再被 CDP attach，CDP Proxy 复用设备模式已有的 debugger attach。detached DevTools 仍与设备模式和 CDP Proxy 互斥。
- 设备状态切换失败必须从 IPC 返回错误，前端不能显示假成功。设备按钮禁用只作为用户体验提示，主进程校验才是安全边界。
- More 菜单在 Zoom 相邻位置提供当前 tab 的 `Minimum Width`，固定为 `Auto`、`768 px`、`1024 px`、`1440 px` 四档。它与 Zoom 一样只属于存活的 Electron tab：导航、刷新和 tab 切换保留，关闭 tab 或完整重启后恢复 `Auto`，且不写入 `terminal-browser-tabs.json`。
- Desktop 下最小宽度以 CSS 逻辑像素计；Electron 用普通 `View` 裁剪容器承载更宽的 `WebContentsView`，子 View 宽度为 `max(可见宽度, minimum × displayScale)`。Renderer 底部滚动轨道只提交受 clamp 的宿主横向偏移，地址栏、tab strip、Comments、Headers 和 Device 面板保持固定，页面自身的 `window.scrollX` 不变。
- 宿主横向偏移按 renderer 中的存活 tab 保存：切换 tab 和同 URL Reload 保留，切换 minimum、主 frame URL 变化或 Device 状态切换归零；resize 与工具面板开关会重新 clamp，页面不再 overflow 时轨道消失并归零。该偏移不进入 workspace snapshot 或磁盘。
- iPhone SE、iPhone 14 和 Pixel 7 模式暂不应用最小宽度，也不显示宿主横向轨道；切回 Desktop 后恢复此前选择并从最左侧开始。外部 CDP metrics 在 Desktop 下同样遵守 minimum floor，截图、layout metrics 和 Agent 输入仍使用完整逻辑视口坐标，不叠加人类横向偏移。
- 最小宽度、Zoom、Device 和 automation metrics 共用同一条主进程 mutation queue。主进程只接受封闭档位并根据 live entry 计算原生子 View 尺寸；Renderer 不能通过 bounds IPC 请求任意内容宽度。

### Terminal Browser 注释模式

Electron 桌面端的 Browser 工具支持 Browser comments 注释模式。它用于让用户在右侧真实网页内容上选择目标、写评论，并把结构化页面证据发送给当前 terminal 中的 agent。

稳定边界：

- 入口在 Browser 工具栏中，Web/PWA 形态只展示禁用态；真实注释能力依赖 Electron BrowserView。
- 注释 runtime 注入到目标 BrowserView 页面内，负责 hover 高亮、点击锁定元素、多行评论输入、编号 marker、编辑和删除；React 外层承载模式状态条、评论审阅面板和批量提交动作。两侧复用同一份 `TerminalBrowserAnnotationState`，不维护重复草稿。
- `active` 表示当前 tab 仍保留评论 runtime 和草稿，`selecting` 表示页面点击是否用于选择目标；完成选择只关闭 `selecting`，不会清理 marker 和草稿。
- 新建评论输入框按用户点击坐标定位，而不是按目标元素矩形定位；靠近视口边缘时会水平 clamp，并在下方空间不足时上翻，避免输入框溢出 BrowserView。
- 提交时 Electron 捕获带 marker 的 BrowserView 截图但不立即清理草稿；前端通过 terminal clipboard image route 保存截图并把 prompt 成功发送到 terminal 后，才停止 runtime。终端发送失败时必须保留原评论供重试。
- prompt 使用 `# Browser comments` 结构，包含 URL、frame、target 文本、selector、path、viewport 坐标、untrusted page evidence 说明和用户评论。
- prompt 通过 terminal input 的 `prompt_paste` 模式一次性发送，避免多行评论被拆成多条终端输入。
- 导航、关闭 tab、切换 annotation tab 或显式停止时，应清理 BrowserView 内 annotation overlay 和 toolbar 计数。

限制：

- 第一版只承诺 top document 内普通 DOM 目标；跨 origin iframe/OOPIF、shadow DOM、canvas 精细选择和跨 tab 草稿持久化不是稳定能力。
- 截图以本地文件路径进入 prompt，不等同于把图片作为模型附件发送。
- 页面证据必须被标记为不可信内容，网页文本不能被当作用户指令。

## 验证与维护

- 文件、目录、搜索和项目隔离：[Project Context](../testing/terminal/workspace/project-context.testplan.yaml)、
  [Explorer Quick Search](../testing/runbooks/explorer-quick-search.testplan.yaml)。
- 原型发现与预览：[Prototype Gallery](../testing/browser/prototype-gallery-preview.testplan.yaml)。
- Browser 基础与专题：[Browser 用例目录](../testing/terminal/browser/)、[Browser Profile CLI](../cli/browser-profile.md)。
- 验证方式按 [命令矩阵](../testing/command-matrix.md) 选择；静态文档或类型检查不代表真实页面验收。
- [历史交互草图](./assets/) 仅保留设计参考；布局与行为判断回到上面的源码和当前验收合同。

本文不保留“v1 待确认”“建议新增 DTO”或分阶段编码清单。新需求应在当前代码上确定差异，不能把旧提案重新执行。
