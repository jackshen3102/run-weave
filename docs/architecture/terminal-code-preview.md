# Terminal 代码预览、Browser 与原型库

本文维护当前行为和跨运行时边界。具体类型、模块拆分与命令参数以链接源码为准；历史实施步骤和草图不作为新任务。

## 代码入口与职责

| 边界                                     | 入口                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作台与 active Project                  | [Workspace](../../frontend/src/components/terminal/workspace/workspace.tsx)                                                                                                                                           |
| Preview 数据与操作                       | [Panel](../../frontend/src/components/terminal/preview/panel/index.tsx)                                                                                                                                               |
| 项目选择、视图与宽度状态                 | [Preview store](../../frontend/src/features/terminal/preview/store.ts)                                                                                                                                                |
| 文本、Markdown、SVG、图片与 Diff 渲染    | [Renderers](../../frontend/src/components/terminal/preview/renderers/)                                                                                                                                                |
| 文件与搜索 HTTP 路由                     | [Preview routes](../../backend/src/routes/terminal/preview/)                                                                                                                                                          |
| 路径权限、文件操作、搜索与 Git           | [Preview service](../../backend/src/terminal/preview/)                                                                                                                                                                |
| 跨运行时 DTO 与链接解析                  | [Preview types](../../packages/shared/src/terminal/preview.ts)、[纯函数合同](../../packages/shared/src/terminal/preview-core.ts)                                                                                      |
| 原生 Browser、Profile、CDP 与 Automation | [Electron Browser](../../electron/src/browser/)                                                                                                                                                                       |
| Agent 会话正文阅读                       | [Web 阅读页](../../frontend/src/components/terminal/conversation/)、[Backend 归属解析](../../backend/src/terminal/application/conversation.ts)、[App Server 投影](../../app-server/src/agents/conversation-reader.ts) |

Preview 是 Terminal 的辅助上下文，提供 Files、Explorer 和 Review changes。它支持受限的文件编辑，
不承担完整 IDE、LSP、扩展宿主、批量文件管理或 Git 提交。终端输出与恢复仍由
[Terminal Surface](../../frontend/src/components/terminal/surface/) 和终端连接链路负责。

## 项目与状态归属

- 搜索、目录、Git 与相对路径以当前生效 Project 的 `path` 为根；该 Project 可以是父项目或 Worktree 子项目。
  不从 terminal 的实时 `cwd` 推断根目录。解析规则见 [Worktree Context](./terminal-worktree-context.md)。
- Project 没有路径时，搜索、目录和 Git 仍要求设置路径；绝对路径文件可只读预览。终端文件链接可使用来源 session/panel cwd 解析相对路径，但不把 cwd 当作项目根。切换同一 Project 内的 terminal 不重置预览内容；
  切换 Project 后读取目标 Project 的选择与视图状态，不能继续展示旧项目的 diff。
- store 按 Project 保存文件选择、查询、Changes 选择和 Markdown/SVG 视图，并持久化 `projects`；
  Sidecar 宽度与一级工具 Tab 布局各自持久化。当前初始化 `ui.open=true`，不能沿用旧方案的“默认关闭”假设。
- 普通 Sidecar 宽度由 store 限制在 320px 与视口 60% 之间；展开状态独立管理。关闭后释放布局空间。
- 一级工具 Tab 可在“管理标签”中显示/隐藏，也可横向拖拽排序；偏好保存在当前浏览器 origin/Electron userData 的设备存储，跨项目共用。隐藏当前项优先切换到右侧相邻可见项，最后一个可用项不可隐藏；显式导航恢复目标入口，后台状态同步不改变布局。隐藏只收起入口，各工具继续遵守原有非激活生命周期。源码入口为 [Sidecar 布局](../../frontend/src/features/terminal/preview/sidecar-layout.ts)，交互合同见 [验收计划](../testing/terminal/sidecar-tabs.testplan.yaml)。
- Preview 操作入口、可见工具及桌面/移动布局由 [Workspace Header](../../frontend/src/components/terminal/workspace/header.tsx)
  和 Panel 决定，不在文档中复制按钮位置或像素级布局。

### Sidecar 布局边界

默认保留原有非 Browser 工具，Browser 1 显示，Browser 2/3 从“管理标签”按需打开。
菜单勾选只改变显隐，“打开”同时显示并激活；恢复默认布局时尽量保留仍可见的当前项。
隐藏入口不清页面、Cookie 或代理，也不停止工具任务，因此不承诺减少浏览器进程或内存。
三个 Browser Profile 仍独立，显式导航继续沿用原有 Profile 解析优先级。

排序只重排可见项，隐藏项保留原槽位；菜单提供前移/后移作为键盘替代。
Automation 等能力暂不可用时不展示入口，但保留布局偏好。配置无效时恢复默认布局，
全部隐藏或能力变化导致无可用入口时恢复 Preview。

布局键 `runweave.terminal.sidecar.tabs.v1` 只保存版本、稳定工具 ID、顺序与隐藏项，
不保存业务状态，不做云同步，也不跨 origin 或 Stable/Beta 共享。
写入失败时本轮内存操作仍有效，界面提示重启后可能恢复，不清理其他存储。

验收使用[工具栏计划](../testing/terminal/sidecar-tabs.testplan.yaml)和
[Profile 隔离回归](../testing/terminal/browser/multi-profile-whistle.testplan.yaml)。
SIDETAB-008 必须实际检查 Electron 菜单、拖影与原生网页的显示和输入命中；
DOM 检查与静态截图不能替代该交互验收。

## Agent 会话阅读

终端头部的「阅读会话」打开当前 panel 的连续问答 Sidecar，可展开、收起和关闭。
原生 iOS 使用全屏阅读页，返回时保留原终端 controller 和草稿。两端仅在打开及手动刷新时
读取一次，不订阅进度、不轮询、不新增正文缓存或备份；历史范围取决于当前源记录。

链路为客户端 → `GET /api/terminal/session/:id/conversation` → App Server 的
`GET /threads/:threadId/conversation`。共享合同见
[Conversation DTO](../../packages/shared/src/terminal/conversation.ts)。Backend 只观察 manager
的 session/panel 归属，显式 panel 无效时返回 404，不恢复 tmux、不改焦点、不发送输入。
读取前后核对 thread/provider；刷新携带 `expectedThreadId`，目标变化返回 409，关闭重开后才能
读取新会话。两端同时隔离连接代际和迟到请求，关闭阅读页即取消并释放正文。

Codex 从受控 rollout 目录定位源文件，只投影 `response_item` 中的 user 和 assistant
可见 commentary/final 正文；明确的注入环境上下文、analysis、工具和重复事件不进入结果。
旧会话缺少 App Server 的 ThreadRef 时仍可按 thread ID 读取并核对 Codex 源身份；
读取不补写事件或登记状态，源不存在或身份不匹配时仍返回 404。
独立的 `<skill>…</skill>` 注入消息整条过滤；用户输入的 `$技能名`、普通引用与讨论保持原文。
Pi 从已注册文件核对 session header，沿当前 leaf 的祖先链只取 user/assistant text，
不拼接 sibling branch 或摘要。既有首页短摘要、detail 和终端 History 保持独立语义。

每次读取固定文件起点长度，分块扫描完整 JSONL 行；未完成末行留待下次主动读取。
损坏完整行标记 `partial`，不存在、身份不匹配或 symlink 源返回 `source_missing`。
源上限 64MiB、序列化正文上限 8MiB，超限返回 413，不冒充截断后的全文。
响应 `no-store`，不返回源路径或工具/思考 payload。

刷新成功替换整份结果，用稳定消息 ID 和消息内偏移保持长回答阅读位置；只有「回到最新」
主动到底部。同目标网络失败保留最后成功正文和时间，不自动重试；`source_missing` 清除旧正文。
正文共享单一纵向滚动区，表格/代码可横向阅读。Web 复用净化后的 Markdown/Mermaid 渲染，
无文件上下文时不提供保存、行引用或伪造文件路径；无法解析的相对资源明确不可用。
iOS 用 MarkdownUI，Mermaid 首期保留可读代码，链接仅允许 HTTP(S)。
验收合同见[会话阅读](../testing/terminal/conversation-reader.testplan.yaml)。

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

## 从终端打开文件

- Desktop 与 Web 的终端文件路径使用 xterm link provider；HTTP(S) 仍由 WebLinksAddon 处理，OSC 8 的 `file://` 链接进入同一文件入口。
- 文件入口只支持预览已识别的代码/文档扩展名、TXT/LOG/CSV/TSV/INI/CONF 和 PNG/JPEG/GIF/WebP/AVIF 图片；SVG 沿用预览定义。不自动识别目录、无扩展名文件、压缩包、PDF 或未知格式。Web 和 Backend 复用 `preview-core.ts` 的 `isSupportedTerminalFileLinkPath`，iOS 对照同一列表；后端仍需验证实际目标为普通文件，内容与大小限制由预览读取接口校验。文件树的通用文本读取不受此入口策略限制。
- 支持上述文件的绝对路径、`./`、`../`、普通相对路径，以及 `:line:column`；空格路径需引号包围，扩展名不区分大小写。渲染时按 buffer cell 映射中文与软换行；tmux 分屏只识别 pane 内当前行，不跨 pane 合并文字。
- 点击普通文件候选时，Web 重新核对命中内容，iOS 保存不可变缓冲区快照；两端携带路径起点之前的行内文字和同 pane 内最多四行上文。只有路径起点前是空白时，Backend 才逐行提取行尾路径片段并拼接，遇到空行、闭合分隔符、完整文件名、URI/提示符或超过 4096 字符时停止；提取到带说明文字或开括号的起始行后停止继续上溯。显式 OSC 8 与引号包围的路径不进行回溯。
- 原始路径和所有拼接候选一起按来源 cwd/项目根校验，并按真实文件路径去重；不能因后半截碰巧存在就提前打开。唯一有效候选自动打开，多个有效候选由用户选择。这是点击时的有界候选恢复，不改变渲染链接范围，也不保证恢复任意排版、跨行引号空格路径或超过四行上文的路径。
- 点击后通过 `POST /api/terminal/project/:id/preview/resolve-link` 在当前连接的 Backend 解析。Backend 校验 session/project/panel 归属；显式相对路径基于来源 cwd，普通相对路径检查 cwd 与项目根，多个有效候选由用户选择。
- 当前 cwd 不代表历史输出产生时的 cwd；不猜测历史目录，也不递归扫描全盘寻找同名文件。找不到时显示错误，用户可使用绝对路径。
- 配置项目根时，相对路径仍遵守 realpath 包含检查；项目外文件需显式绝对路径并保持只读。无项目根时，使用 cwd 解析的文件同样只读，文件响应的 `projectPath` 为 null。
- 解析请求随连接、项目、terminal 或新点击切换取消。打开复用 Preview 的草稿确认、文件选择和行列定位；错误或取消不会替换正在编辑的内容。
- 原生 iOS 使用 SwiftTerm 同一个单击命中与显示缓冲区快照，调用上述解析接口，复用 FilePreview 展示文本、Markdown 和图片；同名候选由用户选择，行列引用定位到原生文本选区。分屏按点击位置匹配实时 pane 几何；布局尺寸不符时提示重新点击。

## 编辑、冲突与 Git

- 项目内已有普通文本/代码文件可在 Files 或 Explorer 显式编辑；响应的 `base`、`readonly` 和 `mtimeMs` 是判断依据。
  项目外 `base=filesystem`、Changes/Diff、图片、目录和不支持的文件保持只读。
- Save 或 `Cmd/Ctrl+S` 才写盘，不自动保存。提交 `expectedMtimeMs`；磁盘已变化时返回冲突，
  Reload 重新读取，Overwrite 显式覆盖。失败保留草稿。相关实现见 [文件编辑](../../frontend/src/components/terminal/preview/files/use-editor.ts)。
- 切换文件、刷新、关闭或改变任务时，涉及丢弃未保存草稿的动作须走现有确认流程。
- 删除、重命名只针对项目内支持的普通文件；不扩展到目录、项目外路径或批量操作。
- Review changes 分 Staged / Working 两组，先读索引，再按选择懒加载单文件 diff；Diff Editor 只读。
- 变更预览由 `file-diff` 的内容能力与两侧状态决定；图片直接预览，Markdown/SVG 保留 Diff/Preview，
  普通文本默认 Diff。空文件、无文本变化、不支持格式、超限和读取失败分别展示，不用空字符串隐去错误。
- Staged 比较 HEAD → index，Working 比较 index → 工作区；重命名保留原路径。图片使用鉴权
  `preview/change-asset`，参数限于 path、kind、side、version，默认新侧，删除时展示旧侧并标注版本。
  version 为响应字节摘要，变化返回 409 供重新加载；不会用磁盘图片冒充暂存版本。旧 Backend 缺少能力字段时，
  新客户端的图片回退必须标注工作区版本，已删除图片提示服务端不支持。
- Git 图片按原始字节读取，文本限制 1 MiB，图片限制 5 MiB；不支持的二进制、冲突索引和特殊文件显式降级。
  读取期间文件变化不返回拼接内容，Git status 禁用可选索引写入。既有取消暂存、丢弃修改与删除确认语义不变。
- 单文件 Reset Changes 需要确认：staged 执行 unstage，working 丢弃该文件工作区改动，untracked 普通文件删除。
  这不授权 stage、commit、checkout 或批量 reset。语义以 [Git service](../../backend/src/terminal/preview/git.ts) 为准。

## 内容渲染

| 内容          | 当前视图与边界                                                        |
| ------------- | --------------------------------------------------------------------- |
| 普通文本/代码 | Monaco；是否可编辑由文件能力决定，Diff 始终只读                       |
| Markdown      | 默认 Preview，可切 Source/Split；沿用文件编辑权限，不创建新的顶层任务 |
| 独立 SVG      | 默认 Preview，可切 Source；XML 经净化后在无权限 sandbox iframe 中预览 |
| 本地 HTML     | 默认 Preview，可切 Source；短期票据提供同目录静态资源，隔离执行脚本   |
| 图片          | 独立 asset 读取；Web 使用公共图片预览与 lightbox，支持缩放和平移      |

Markdown 默认值以 store 为准，不能沿用旧草图中的 Split 默认值。Split 的滚动同步、行引用与选区行为见
[Markdown renderer](../../frontend/src/components/terminal/preview/renderers/markdown.tsx)。

- Markdown 使用 `markdown-it`，关闭 raw HTML，输出经 DOMPurify 净化；Mermaid 使用 strict 配置，错误局限在对应图块。
- 当前已支持通过鉴权 asset API 读取解析后的本地图片，不使用 `file://`。链接和资源解析统一使用 shared 纯函数合同，
  不能由页面内容绕过项目路径和协议检查。
- 独立 SVG 使用 [SVG renderer](../../frontend/src/components/terminal/preview/renderers/svg.tsx) 的净化与 sandbox，
  不把原始 XML 直接注入工作台 DOM。
- `.html`/`.htm` 在 Files/Explorer 中可渲染完整页面。Backend 票据绑定 Project 和 HTML 绝对路径，静态资源只读且限制在文件所在目录内；桌面端使用无 `allow-same-origin` 的 iframe，原生 iOS 使用非持久化 WKWebView。两端 Source 均可查看，桌面端继续使用现有编辑/保存能力，iOS 保持只读。
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
- iOS 使用 `GET /api/terminal/quick-inputs?kind=pinned&scope=global&order=manual&limit=100&cursor=…`；显式 `scope=global` 只返回 `projectId:null` 项，分页响应额外携带 `nextCursor/orderVersion`。省略 scope 的既有 Web 查询继续按原作用域及最近使用时间排序。
- iOS 创建项固定全局，不读取或导入旧本机归档。`PATCH` 可带正文与 `expectedUpdatedAt` 拒绝过期编辑；`POST /api/terminal/quick-inputs/:id/move` 用 `expectedOrderVersion` 只移动全局 pinned 项。

列表只返回 `hiddenAt == null` 的记录。`kind=recent` 返回未固定项，`kind=pinned` 返回固定项，`kind=all` 固定项优先；最近输入最多保留 200 条，裁剪只影响未固定的可见 recent。

Web 交互边界：

- 面板打开后可浏览固定、最近和全部记录；没有 active terminal 时仍可查看和管理，但发送和插入禁用。
- `发送` 复用当前 session 的 Terminal input API，并携带 `quickInputSource: "web_terminal_quick_input"`。
- `插入` 只对不含 CR/LF 的 `line` 和 `codex_slash_command` 可用，实际以 `raw` 写入当前终端输入上下文，不自动提交；`prompt_paste` 和多行输入只能发送或复制。
- `复制` 与 `插入` 成功后调用 `/used` 更新 `lastUsedAt/useCount`。

## Terminal Browser 与 Automation

- Desktop Sidecar 支持 `Automation` 与 `Browser 1/2/3`，默认只显示 Browser 1，其余两个从“管理标签”按需打开。三个 Browser 入口对应应用进程全局的三个 Profile；入口显隐不删除网页或更改登录态、代理与 CDP 身份。Worktree 只提供默认选择和 Dev Server 端口，不拥有或复制 Profile。
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
- Browser workspace 会以 schema v3 按 Profile 持久化到 Electron `userData` 下的 `terminal-browser-tabs.json`，包含 group 名称、顺序、成员顺序和 active Tab；favicon、导航错误、Whistle PID、runtime route、prompt override 和连接/活动状态不落盘。v1/v2 内容全部迁入 Profile 1，Profile 2/3 初始为空；每个 Profile 最多恢复 5 个合法 URL 的元数据。UI resolve 只准备路由与元数据，选中标签时才创建该标签的 `WebContentsView` 并导航；Agent resolve 只唤醒所请求 Group 的当前或首个标签，不加载整个 Profile。
- Tab strip 提供“休眠闲置标签”。用户确认重新加载与未保存内容风险后，主进程按最近使用顺序释放该 Profile 中通过保护检查的后台页面，保留 tabId、Group、标题、URL、favicon 和进程内导航历史。返回标签或显式唤醒会创建新的 CDP target；休眠只销毁页面资源，不记录用户关闭标签。
- 当前标签、整个存活自动化连接的 Profile/Group 范围、CDP/DevTools、截图借用、注释、下载、授权弹窗、媒体/iframe、编辑区域与非空输入等可检测活动不参与休眠；含 `sessionStorage` 会话数据或无法读取其状态的页面保留，避免销毁 WebContents 后丢失标签会话。下拉框通过浏览器重置克隆控件的结果判断默认选择，未修改的隐式首项不阻止休眠。Device、非默认 Zoom/Minimum Width 的标签同样保留。第一阶段不自动回收，也不承诺任意第三方网页的未保存状态完整恢复。
- CDP Proxy 的 `GET /runweave/browser-tabs?profileId=...&groupId=...` 返回所属范围的标签元数据（含 `suspended`、`targetId`，休眠时 targetId 为 null），读取不会加载页面。`POST /runweave/browser-tabs/wake?profileId=...&groupId=...` 接收 `{ "tabId": "..." }`，校验范围和路由后仅唤醒指定标签，返回真实 targetId 和 cdpEndpoint；重复唤醒同一存活标签复用当前 target。普通 CDP target 清单只包含存活页面；已有订阅收到唤醒后的 targetCreated 与休眠时的 targetDestroyed。
- Browser tab strip 只让 tab viewport 横向滚动，总览与 New Tab 固定在 viewport 外。单 tab preferred width 为 180px；空间不足时 active 最小 80px、inactive 最小 44px；组内间距 4px、组间间距 12px，达到 minimum 后才产生横向 overflow。Tab 使用主进程净化后的 favicon 与页面标题作为主要身份，无 favicon 时回退 hostname 首字符或通用页面图标。
- Tab 内容按宽度分为 comfortable（`>95px`）、compact（`64～95px`）和 icon-only（`44～63px`）三档。active close 始终保留；inactive close 在非 icon-only 档通过 hover / focus 显示。总览按 group 分段，可按 title、URL、group name/id 搜索，并提供新建、重命名和关闭工作组；关闭多页面工作组需要一次批量确认。
- active tab 会在初始化、选择、新建、关闭、排序和 sidecar resize 后进入 tab viewport。Left / Right 循环切换相邻 tab，Home / End 切换首尾，并使用 active tab `tabIndex=0` 的 roving focus。
- 鼠标从 tab strip 连续关闭时，剩余 tab 按 tab id 保留关闭前像素宽度，pointer 离开整个 tab bar 后重新分配；touch / pen 在最后一次关闭 1.8 秒后解除。resize、拖拽、Overview 选择或外部 tab replace 会丢弃过期冻结宽度。
- Browser tab 只支持所属 group 内拖拽排序；Renderer 可先乐观更新，再通过 `terminal-browser:reorder-group-tabs` 提交 group id 与该组完整成员全排列。主进程拒绝缺失、重复或跨组 tab id，失败时 Renderer 强制读取同 revision workspace 回滚。工作组按创建顺序稳定，不提供跨组拖拽或整体排序。
- Electron workspace 是 group 名称、顺序、成员、active Tab 和结构 revision 的唯一事实源。Renderer 先订阅统一 `terminal-browser:state-changed` 事件再读取初始 workspace，只应用更新 revision，并从成员 Tab 推导 group 的连接与错误状态；不从颜色、相邻位置或本地临时 Tab 推断 CDP 权限。
- 主进程 main-frame 导航失败（排除 `ERR_ABORTED/-3`）会写入 Tab live `navigationError`；后台 Tab 和所属 group 显示弱错误点，激活后沿用错误横幅展示详情，下一次成功 main-frame 导航自动清除。favicon 下载或解码失败只回退图标，不进入导航错误。
- Browser 工具切到后台时只隐藏当前 WebContentsView，不清除该窗口的 selected tab；关闭 selected tab 或关闭窗口时才删除对应 active 映射，因此隐藏、重启和恢复不会把 active 身份回退到数组首项。
- 三个 Profile 进入 Whistle 模式时分别懒启动内置 `whistle@2.10.9`，固定监听 `127.0.0.1:8081/8082/8083`，使用 `profile-1/2/3` 独立 storage 和同一 certDir。Runweave 只维护保留 Value `runweave-dev-server`，不会创建、选择或改写用户 Rules 和其它 Values；`deploy/whistle/proxy.md` 是独立人工部署示例，不属于 Terminal Browser 默认规则。
- Profile runtime route 只有 `unassigned` 或 `dev-server:<port>`，表示当前 Profile 保存的开发目标，并非业务请求已命中该目标的证据。Whistle 模式下同路由可以跨 Worktree/Agent 共享，不同路由在仍有可见 view 或 CDP 连接时返回冲突。Profile 空闲后切换只更新/删除保留 Value，不自动刷新页面；用户需刷新受影响的页面，且实际转发仍取决于 Whistle 用户 Rules。不清浏览数据或页面身份。旧 `desktop.browser.businessOrigin` 只在读取已有 YAML 时被容忍，不再作为可编辑字段展示，Browser 不再读取或应用它。
- 每个 Profile 的连接模式独立保存到 Electron `userData` 下的 `terminal-browser-profiles.json`，应用或电脑重启后优先恢复已保存的 Direct/Whistle 选择。旧配置缺少该 Profile 的 `proxyModes` 记录时才使用默认值：普通安装态使用所属 Whistle 代理，带独立 userData 的受管 Dev Session 默认直连，避免不使用业务代理的开发与端到端验收依赖固定 `8081/8082/8083`。显式切换通过网络配置后写盘，保存失败向调用方报错；恢复选择不恢复 Whistle PID 或 runtime route，也不提前启动 Whistle。Workspace Service 的 `*.localhost` 在两种模式下都保持 DIRECT，稳定 URL 与本地服务生命周期见 [Terminal Workspace Services](./terminal-workspace-services.md)。切换会关闭该 Profile 的既有网络连接并刷新其页面，但不停止 Whistle 或清理其 Rules、Values 与 storage。应用不修改系统代理。三个 Profile 只在自己的 `setCertificateVerifyProc` 中接受共享 Whistle Root CA 链，其它证书继续采用 Chromium 校验结果；主窗口和其它 Session 不继承该信任。
- `Headers` 面板只影响当前 Profile 的网页请求，不影响其它 Profile、Runweave 主窗口、登录/API 请求或 Electron 更新请求。
- Header 规则保存在 `settings.yaml` 的 Profile-scoped `desktop.browser.headerRules.<profileId>` 配置中；旧 localStorage 规则只在对应 Profile 尚未配置时提示迁移，Profile 1 还会读取更早的 `terminal.browser.headerRules` 全局键，用户检查后保存。每个 Profile 分别同步到其 Electron Session dispatcher，保存失败会展示错误且不更新面板中的已保存规则。
- Header 规则通过 `terminal-browser:get-header-rules` / `terminal-browser:set-header-rules` IPC 进入主进程。主进程做最终校验，最多 20 条，字段为 `enabled`、固定操作 `set`、`name`、`value` 和 `urlPattern`。面板顶部的 Domain 设置对该 Profile 的全部规则统一生效：留空为 `*://*/*`，填写普通域名时仅匹配该完整主机名，填写 `*.example.com` 时匹配 `www.example.com`、`a.b.example.com` 等子域名但不匹配裸域 `example.com`；两者均只匹配 HTTP/HTTPS 请求的主机名，不受路径文本影响。前端不暴露单条规则的 URL pattern 编辑。
- Header 名必须符合 HTTP token 形态，禁止控制字符、冒号以及 `host`、`content-length`、`connection`、`upgrade`、`proxy-authorization`、`set-cookie`。Header 值不能为空且不能包含控制字符。
- Electron 主进程为三个 Profile Session 各注册一个 `webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] })` dispatcher。dispatcher 只处理 `http:` / `https:` 请求，按所属 Profile 的规则列表顺序匹配各规则的 URL 模式；同名 Header 后命中的规则覆盖前面的规则。
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

Automation 的关键桌面路径已有实现与阶段性验证，全量
[观察用例](../testing/terminal/browser/automation-observability.testplan.yaml)、当前 `capturePage`
产品路径的独立进程性能对照和 macOS 打包复验仍需完成，不能用旧 screencast 实验替代发布验收。
性能取证应保持十 Tab 元数据、单 selected 画面、640px/5 FPS 与 renderer ACK 的实际资源模型。
具体阈值、三轮性能与三组独立进程 RSS 配对合同以该测试计划为准；同进程前后 RSS 增长相减
不能代替独立进程对照。性能驱动使用正式 snapshot/view/frame/ACK 接口，不增加专用生产捕获 API。

- 文件、目录、搜索和项目隔离：[Project Context](../testing/terminal/workspace/project-context.testplan.yaml)、
  [Explorer Quick Search](../testing/runbooks/explorer-quick-search.testplan.yaml)。
- 原型发现与预览：[Prototype Gallery](../testing/browser/prototype-gallery-preview.testplan.yaml)。
- Browser 基础与专题：[Browser 用例目录](../testing/terminal/browser/)、[Browser Profile CLI](../cli/browser-profile.md)。
- 验证方式按 [命令矩阵](../testing/command-matrix.md) 选择；静态文档或类型检查不代表真实页面验收。
- [历史交互草图](./assets/) 仅保留设计参考；布局与行为判断回到上面的源码和当前验收合同。

本文不保留“v1 待确认”“建议新增 DTO”或分阶段编码清单。新需求应在当前代码上确定差异，不能把旧提案重新执行。
