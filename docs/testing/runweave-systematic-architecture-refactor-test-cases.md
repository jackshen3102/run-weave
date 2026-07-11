# Runweave 系统性架构重构测试案例

> 状态：执行中；SAR-001 至 SAR-027 的自动化与真实环境部分均已完成，SAR-012 中 IME-009 等待物理键盘提交。
> 对应结构门禁：`scripts/architecture/` 与 `pnpm architecture:check`

## 范围

验证系统性重构完成后：

- 产品源码、脚本、Hook 和集成验证代码全部满足 600 物理行硬限制；
- 依赖方向、运行时 cycle、共享合约和质量命令符合计划；
- Web、App、Backend、Electron、App Server、CLI、更新脚本和 Toolkit Hook 的既有行为保持不变；
- 多连接、异步竞态、重启恢复、幂等、安全和资源释放没有因结构迁移回退。

不覆盖新产品功能、视觉改版、Windows 打包、外部网站全部兼容性、单元测试和 coverage。

## 前提事实

- Web 与 App 使用 React 19、Zustand 5；实施后 HTTP 服务端状态由 TanStack Query 管理，客户端状态仍由 scoped Zustand/local state 管理。
- 终端输出保持 xterm imperative 写入，不进入 Query/Zustand 高频更新。
- Backend 的权威终端状态仍为 `TerminalState`；App Server ThreadRef 不替代它。
- Agent Team 真相仍在 `.runweave/agent-team/<runId>.json`，worker 结果仍为 pane-scoped outbox。
- LowDB、scrollback、App Server JSONL/state、App auth storage key 和现有 HTTP/WS/IPC/CLI 合约在本重构中冻结。
- 浏览器行为必须由 `$playwright-cli` 在真实浏览器取证；桌面应用启动、重启、菜单、窗口和系统弹窗由 `$computer-use` 操作；静态检查不能替代行为验收。
- 阶段 0 完成后必须存在 `pnpm architecture:check` 和 `pnpm test:e2e`。若命令缺失，判定阶段未完成，不允许跳过。

## 环境与证据

为每个 PR 建立独立证据目录：

```text
artifacts/architecture-refactor/<pr-or-phase>/
  architecture-report.json
  command-results.json
  browser/
  desktop/
  api/
  cli/
  persistence/
  logs/
```

每次行为验收至少记录：Git SHA、分支、端口、backend/profile、Electron channel、connectionId/apiBase、测试账号类型、开始/结束时间和失败命令的完整退出码。Agent Team 额外记录 projectId、terminalSessionId、runId、panelId/tmuxPaneId 和 pane-scoped outbox 路径。

## 本轮执行记录（2026-07-11）

环境：PR 分支（Electron 0.128.0 自动版本提交后），backend A/B/iOS 分别为 `5620/5623/5624`，Web/App 为 `5621/5622`，开发 Electron CDP 为 `9345`；测试账号均为隔离 profile 的本地账号，证据中不记录凭据或 token。

| 用例    | 状态       | 关键证据                                                                                                                                                        |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAR-001 | 通过       | `artifacts/architecture-report.json`：619 文件、104,852 行、`over600=0`，模块与逐文件清单齐全。                                                                 |
| SAR-002 | 通过       | `pnpm architecture:verify` 对 ts/tsx/css/mjs/cjs/sh 的 599/600/601 行和末尾换行边界逐类断言。                                                                   |
| SAR-003 | 通过       | verify 覆盖新增/增长/减少 ratchet；最终 `scripts/architecture/legacy-baseline.json` 不存在且零债务通过。                                                        |
| SAR-004 | 通过       | runtime/type cycle 与反向依赖 fixture 均被拒；最终三项均为 0。                                                                                                  |
| SAR-005 | 通过       | 全运行时 typecheck/build 通过，产品源码 shared root import=0，旧 payload/HTTP/WS/IPC 真实消费者兼容。                                                           |
| SAR-006 | 通过       | `test:e2e` 真实运行 1/1；`quality:gate` 选择 architecture/static/E2E 且四步全通过；三份质量文档已对齐。                                                         |
| SAR-007 | 通过       | Playwright 在 backend A/B 间无刷新切换，QueryClient/cache/auth 以 connection 隔离，迟到响应未覆盖当前连接。                                                     |
| SAR-008 | 通过       | 项目/session 选择、排序、marker、panel split、刷新与事件重连真实页面通过。                                                                                      |
| SAR-009 | 通过       | tmux session 普通输入、控制键、resize、WS 恢复与 scrollback 顺序真实验证，无重复帧。                                                                            |
| SAR-010 | 通过       | Preview 文件/目录/内容搜索、Changes/diff、文本/SVG/图片、保存/冲突/重命名/删除与错误态通过。                                                                    |
| SAR-011 | 通过       | 快速 A/B 响应竞态只呈现最后 scope；原 52/37/35 props 热点消失，最终业务组件 props 上限 12。                                                                     |
| SAR-012 | 待物理键盘 | IME-001 至 IME-008 的真实页面 composition/WS 帧均精确通过；search/scroll/floating composer/Stop 状态通过。IME-009 捕获器已就绪，等待物理键盘 `jianyi + Space`。 |
| SAR-013 | 通过       | 普通 Web Browser tabs 可创建/关闭/排序；Electron-only bridge 缺失时为明确降级态，无 undefined 调用。                                                            |
| SAR-014 | 通过       | 真实 Electron BrowserView 覆盖 tab/group、popup、reorder、proxy/header/device、DevTools、annotation 与重启顺序恢复。                                            |
| SAR-015 | 通过       | App A/B 切换无数据串扰；offline 保留；签名 iOS App Keychain 登录后强制终止/重开自动恢复，WebView 数据容器敏感键扫描 0 命中。                                    |
| SAR-016 | 通过       | App 输入、快捷键、Stop、图片草稿、语音、Changes、Files、diff、图片与失败保留均走真实页面/API。                                                                  |
| SAR-017 | 通过       | 旧 LowDB/scrollback 直接读取；项目/session/panel 排序、别名、focus、resize、pending flush 与重启后 marker 全保持。                                              |
| SAR-018 | 通过       | Hook、HTTP state、input WS、events WS、App overview 与 CLI handoff 对同一 TerminalState 一致；跨 session/ticket 负例被拒。                                      |
| SAR-019 | 通过       | run `atr_5ee0feb9_20260711041929` 真实 code→review→verify 串行完成 3/3，pane-scoped outbox 与导出证据一致。                                                     |
| SAR-020 | 通过       | run `atr_2c6be965_20260711042819` 在 backend 停机期间自然 Stop；重启 startup scanner 恢复，App Server 重放幂等且最终完成。                                      |
| SAR-021 | 通过       | 三个 App Server verify 全通过，覆盖 singleton、dedupe、projection/cursor/WS、cloud sync fallback 与恢复。                                                       |
| SAR-022 | 通过       | CLI send/handoff/interrupt、agent `/status`、panel 与历史主路径通过；缺 terminal/project、非法 mode/slash/confirm、未授权/不可达 exit code 均符合契约。         |
| SAR-023 | 通过       | updater fixture 18/18、Stable/Beta dry-run；Beta 真实 rollback 后健康，再从当前脏工作区成功更新到 0.131.0，App Server release 同步更新。                        |
| SAR-024 | 通过       | `toolkit:verify-hooks` 通过 canonical/mirror 内容、权限、缺失与错误 fixture；打包前 staged sync 正常跳过无改动。                                                |
| SAR-025 | 通过       | 缺/错 auth、Origin CORS、非法/跨 session ticket、路径逃逸、跨 panel、错误 hook/body 全部被拒；日志敏感值扫描 0 命中。                                           |
| SAR-026 | 通过       | Electron 20 轮资源循环回到 2 个 tab/无 orphan；Backend 20 轮在 node-pty beta14 后 FD 37→37、children 1→1、TCP 7→7、无 MaxListeners。                            |
| SAR-027 | 通过       | 旧 profile/scrollback/run/outbox/event state 无迁移读取；Backend/Electron 重启和 Beta rollback 均能读取冻结格式，无双写残留。                                   |

命令日志位于 `artifacts/architecture-refactor/final/logs/`，结构化汇总位于 `artifacts/architecture-refactor/final/command-results.json`。行为截图包括 `browser/agent-team-done.png`、`desktop/ios-native-authenticated.png` 和 `desktop/ios-native-restored-after-relaunch.png`。

## 必跑门禁

按顺序执行，任一失败即停：

```bash
pnpm architecture:check
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm app-server:verify-state-sync
pnpm toolkit:verify-hooks
git diff --check
```

涉及 Electron 的阶段额外执行：

```bash
pnpm --filter @runweave/electron typecheck
pnpm dist:electron:mac
```

以上命令是前置门禁。Web/App/Electron/终端交互仍需执行下列真实行为用例。

## 测试案例

### SAR-001 全仓架构报告覆盖全部源码模块

方法：场景法、完整性核对。

前置条件：在计划基线或最终提交运行，Git 工作区状态已记录。

操作：执行 `pnpm architecture:report`，再用 `git ls-files` 独立列出计划纳入的扩展名和目录；按 frontend、backend、app、electron、scripts、shared、CLI、app-server、toolkit hooks、common、terminal-renderer、根入口对照文件数。

预期：报告包含每个纳入文件的路径、物理行数、模块和规则结果；排除项带明确原因；没有源码文件静默漏扫；最终报告 `over600=0`。

失败判断：任一纳入目录未出现、通过改扩展名/移动目录绕过扫描、报告与独立清单不一致，或最终仍有 `>600` 文件。

### SAR-002 600/601 行边界对所有源码类型一致

方法：边界值分析。

前置条件：使用 `/tmp` 或 checker 支持的 fixture root，不污染产品源码。

操作：分别为 ts、tsx、css、mjs、cjs、sh 创建 599、600、601 物理行 fixture；覆盖有/无末尾换行、纯注释行和空行；执行 file-size checker。

预期：599 和 600 通过，601 失败；空行、注释计数；末尾换行不虚增一行；失败输出包含真实路径和行数。

失败判断：任一扩展行为不同、601 通过、600 失败、注释/空行被忽略，或只给笼统错误无法定位文件。

### SAR-003 legacy baseline 只能递减并最终归零

方法：状态迁移、错误猜测。

前置条件：阶段 0 存在 baseline；阶段 9 有最终分支。

操作：在隔离 fixture 中模拟“新增违规”“旧违规增长”“旧违规减少”“删除违规”“篡改 baseline”五种变化；最终分支执行全量检查并查找 baseline 文件。

预期：新增/增长/手工放宽 baseline 失败；减少/删除通过并更新机器结果；最终 baseline 文件不存在且零豁免检查通过。

失败判断：可通过编辑 baseline 掩盖债务、已有违规增长不报错，或最终仍依赖 allowlist。

### SAR-004 import graph 阻止 cycle 和反向依赖

方法：判定表。

前置条件：准备只含 type import、runtime import、barrel re-export 和合法 adapter->application->domain->port 的 fixture。

操作：分别制造 runtime cycle、type cycle、App service->component、store->component、Backend domain/application->route、合法 type-only leaf import；执行 architecture check。

预期：两类 cycle 和所有禁向 import 失败并输出完整链路；合法依赖通过；最终产品图 cycle=0、forbidden edges=0。

失败判断：barrel 隐藏的 cycle 未发现、type/runtime 混淆、只报一个文件不报链路，或用路径重命名即可绕过层级规则。

### SAR-005 shared 子路径迁移保持跨运行时合约兼容

方法：等价类、回归。

前置条件：保存重构前典型 Terminal project/session/panel/input/state/event/WS、Agent Team、App Server payload 样本。

操作：对 shared、frontend、app、backend、electron、app-server、CLI 执行 typecheck/build；用重构前后代码分别序列化样本；查找产品源码根 `@runweave/shared` import。

预期：字段、可选性、union discriminator 和序列化 JSON 一致；显式 subpath 可被全部运行时解析；迁移完成后根 import 为 0。

失败判断：仅 import 路径变化就改变 payload、consumer 需要类型断言绕过、root barrel 仍被新增使用，或任一运行时构建失败。

### SAR-006 质量脚本、文档和真实执行内容一致

方法：场景法。

前置条件：阶段 0 已完成；可查看 `package.json`、quality gate JSON 和 docs。

操作：执行 `pnpm test:e2e`、`pnpm quality:gate`；制造一个隔离的架构违规和一个 Playwright 断言失败，分别重跑；对照 `quality-harness.md`、`layers.md`、`command-matrix.md`。

预期：命令真实存在；quality gate 报告列出实际选择的 architecture/static/E2E 步骤；对应失败导致非零退出；文档没有声称未执行的层级。

失败判断：空脚本/echo 冒充测试、E2E 失败仍 pass、报告写已执行但没有命令证据，或文档继续与实现漂移。

### SAR-007 Web 多连接认证与 Query cache 隔离

方法：判定表、异步竞态。

前置条件：两个独立 backend/profile，包含不同项目/session；连接 A 响应可人为延迟；有效账号已准备。

操作：用 `$playwright-cli` 登录 A 并打开 Terminal，在 A 请求未完成时切到 B；再切回 A；分别触发 A 的 401、B 的网络失败和两个连接的 terminal event。

预期：B 页面只显示 B 数据；A 迟到响应/event 不覆盖 B；切回 A 可使用 A cache 或按策略刷新；A 的 401 只清理 A session，B 网络失败不清 token。

失败判断：项目/session 串连接、旧请求覆盖当前页、一个连接 logout 清空全部连接，或 cache key 不含 connection scope。

### SAR-008 Web Workspace 选择、marker 与事件收敛

方法：状态迁移、场景法。

前置条件：一个 backend 至少两个项目、每个两个 session，并可产生 terminal state、completion、bell、panel event。

操作：用 `$playwright-cli` 切换项目/session、拖拽排序、打开 history、产生 marker 和 panel split；刷新页面、断开/重连事件流、删除当前/非当前 session。

预期：active project/session 始终有效；排序和 recent selection 保持；当前 session marker 清除、非当前保留；事件只更新目标实体；删除后选择按既有规则回退。

失败判断：出现无效组合、同一实体在 Query/Zustand 两份值不一致、重连重复 marker、或删除后白屏/选中不存在 session。

### SAR-009 Web Terminal 实时输入输出与连接恢复

方法：端到端场景、依赖不可用。

前置条件：真实 backend、tmux-backed session、可暂时断开 terminal WS。

操作：用 `$playwright-cli` 打开 terminal，发送普通文本、控制键、resize；持续输出期间切换 tab；断开并恢复 WS；读取 xterm DOM/可访问状态和 backend session。

预期：输入只发送一次、输出顺序和历史补齐正确、resize 生效；切 tab 不清屏；重连不重复输出；高频 chunk 不导致 React 页面级 render/卡死。

失败判断：输入重复/丢失、输出乱序、重连双写、切换出现可观察 blank frame，或 output 被写入 Query/Zustand 造成明显渲染风暴。

### SAR-010 Preview 查询、编辑、冲突与 mutation 一致

方法：等价类、状态迁移、错误猜测。

前置条件：项目包含文本、Markdown、SVG、图片、Git change、目录；可制造保存冲突和 401/404。

操作：用 `$playwright-cli` 依次搜索文件/目录/内容，打开各种文件，切换 Changes/diff，编辑保存、覆盖冲突、重命名、删除、reset change；并触发错误响应。

预期：每个 query 独立 loading/error/data；mutation 成功只 invalidate 相关 key；冲突保留草稿；401 走统一 auth 处理；选中路径和 tree/changes/file 内容一致。

失败判断：旧 loading 覆盖新请求、mutation 后显示旧 cache、错误清空草稿、不同 mode 共用错误字段，或出现第二份 Zustand server entity。

### SAR-011 Preview 快速切换只呈现最后选择且不隐藏巨型 props

方法：异步迟到、结构审计。

前置条件：两个响应延迟可控的文件和 architecture React metrics。

操作：快速连续选择 A/B 并让 A 最后返回；切换 project 和 connection；运行 metrics 并人工查看核心组件接口和 JSX spread。

预期：最终只显示 B/当前 scope；A 结果留在自己的 query key，不覆盖 B；已知 52/37/35 props 中转消失；不存在 `{...controller}`、`viewModel` 等把同等字段打包后透传的替代。

失败判断：迟到响应覆盖、组件仍展开十几个不相关职责，或仅通过对象包装让 metrics 假通过。

### SAR-012 TerminalSurface 的 IME、搜索、滚动与 floating composer 无回归

方法：场景法、状态迁移。

前置条件：真实浏览器 terminal，支持中文 IME、tmux copy mode 和受支持 agent 状态。

操作：按现有 `terminal-ime-input-test-cases.md`、`terminal-floating-composer-test-cases.md` 和 `terminal-state-test-cases.md` 执行相关 Web 用例；覆盖搜索开关、离底、回到底部、draft、Stop 后状态。

预期：IME 不重复提交；搜索/scroll/floating composer 状态互斥符合既有规则；Stop 不提前伪造 idle；focus 回到 xterm。

失败判断：任一现有用例回退、拆 hook 后事件 listener 重复、未知 escape 后仍错误 replay，或 UI 状态组合不可能收敛。

### SAR-013 Web 非 Electron Browser 降级态保持明确

方法：等价类、回归。

前置条件：普通 Web 模式，不存在 Electron bridge。

操作：用 `$playwright-cli` 打开 Terminal Browser，创建/关闭/reorder tabs，输入 URL，尝试 Electron-only proxy/device/annotation/CDP 操作。

预期：Web tab state 正常；Electron-only 能力隐藏或明确禁用；页面不因 manager/provider 缺失崩溃。

失败判断：调用 undefined bridge、Web 与 Electron tab state 串扰、空白页或无说明失败。

### SAR-014 Electron Browser tabs、CDP、设备与注释全链路

方法：端到端场景、并发隔离。

前置条件：用 `$computer-use` 启动开发 Electron，再用 `$playwright-cli`/CDP 连接目标页面；至少两个 tab/group。

操作：执行现有 Terminal Browser CDP/MCP、Playwright MCP、自适应 tabs 用例；额外覆盖 popup、新建/关闭/reorder、proxy/header/device、DevTools、annotation 提交/删除、窗口重开。

预期：BrowserView manager 是唯一 owner；tab/window/group/target 不串扰；IPC validation、target scope、持久化顺序和 annotation DOM 结果与重构前一致。

失败判断：僵尸 BrowserView/CDP connection、错 tab 被操作、重开顺序丢失、annotation runtime 注入失败，或 Web 测试替代了 Electron 真实验证。

### SAR-015 App 多连接、认证、安全存储与 offline

方法：判定表、依赖不可用。

前置条件：App Web 与至少一个 Native/iOS 可用环境；两个 backend；可控制 health/401/offline。

操作：新增/编辑/切换/删除连接；分别登录；检查 Web localStorage 和 Native secure credentials；停止当前电脑后刷新首页，再恢复。

预期：连接、session、overview/query 按 connectionId 隔离；Native refresh token 只在安全存储；offline 保留已加载数据和 token并禁写；恢复后重连刷新。

失败判断：token 明文集合写入 localStorage、切换连接复用旧 terminalSessionId、offline 清登录态、恢复自动 flush 离线输入，或一处 401 清全部连接。

### SAR-016 App Terminal 输入、Stop、图片、语音、Changes 与 Files

方法：端到端场景、错误态。

前置条件：App 已登录且 terminal 存在；项目有 change、文本和图片；语音 provider 可成功和失败。

操作：真实 App/浏览器打开 terminal，发送文本/快捷键/图片路径、Stop、语音转写；切 Chat/Changes/Files、打开 diff/文件/图片；制造 offline 和请求失败。

预期：所有能力保持现有语义；Changes/Files 使用独立 query 且不把 server data 复制进 terminal UI store；失败保留 composer/已加载数据；Ionic 页面/overlay 与原生高密度按钮边界不变。

失败判断：Stop 直接改状态、选择图片自动发送、语音自动执行、tab 切换丢内容、offline 仍写入，或把固定 action slot 改成破坏布局的 `IonButton`。

### SAR-017 Backend project/session/panel/tmux/scrollback 持久化

方法：状态迁移、重启恢复、边界值。

前置条件：隔离 profile，含重构前生成的 LowDB/scrollback fixture；tmux 可用。

操作：启动重构后 backend 读取旧数据；创建/排序/改名 project/session，split/focus/resize/close panel，持续写 scrollback；在 pending flush、session running、session exited 三种状态重启；扫描/清理 orphan。

预期：旧数据无需迁移即可读；write-behind 不丢/重复；panel workspace、activeCommand、thread metadata、runtime metadata 和 scrollback 与操作一致；dispose 完成后无挂起 timer/process。

失败判断：schema 被静默改写、旧数据丢失、重启重复 session、scrollback 截断超出既有策略、orphan 误杀其他 profile，或 façade/新模块双写。

### SAR-018 TerminalState、Hook、HTTP 与两个 WebSocket 通道一致

方法：状态迁移、判定表。

前置条件：可产生 shell、Codex/Trae start/running/Stop、session exit；有 Web/App/CLI consumer。

操作：执行 `terminal-state-test-cases.md` 和 `terminal-active-command-consistency-test-cases.md`；同时观察 `/api/.../state`、`/ws/terminal`、`/ws/terminal-events`、App overview 和 CLI handoff。

预期：状态只由 active command/hook/受限 fallback 推进；session exit 优先；各 consumer 读取同一事实；输入/输出 WS 与全局事件 WS 职责不混淆。

失败判断：route/WS 各自写状态、completion 普通通知改变 TerminalState、不同 consumer 显示冲突，或拆 server 后重复 listener/event。

### SAR-019 Agent Team 正常拆分、串行验收与导出

方法：场景法、状态迁移。

前置条件：隔离项目，具备可追溯 test_case_file；主 pane 和 code/code_review/behavior_verify worker 可用。

操作：执行 `agent-team-loop-engineer-test-cases.md` 与 `agent-team-verification-case-source-test-cases.md` 的正常主路径；完成 split gate、code、review、verify、export。

预期：phase/status/active role 合法；worker 串行顺序不变；每次 transition 只有一个 owner；run/outbox 路径和 JSON schema不变；UI 与文件状态一致。

失败判断：跳过 test case gate、并发启动串行 worker、route helper 成为业务 owner、非法组合写入 run，或 export 丢证据。

### SAR-020 Agent Team completion、recheck、重启与幂等恢复

方法：并发、幂等、依赖失败、超时。

前置条件：按 `agent-team-completion-recovery-test-cases.md` 准备隔离 backend/App Server/run。

操作：执行 ATCR 全套；覆盖重复 completion、backend/App Server 不可用、null baseline、stale 身份、recheck timeout、fresh pane replacement 和 need_human。

预期：合法 outbox 只消费一次；错误 run/session/panel/role 不推进；恢复和超时规则不变；watchdog 可 start/stop 且不泄漏。

失败判断：重复 prompt/round、错 outbox 被消费、重启后永久停滞、timeout 次数变化，或拆分 service 后 queue/timer 多实例运行。

### SAR-021 App Server singleton、Event Center、projection 与恢复

方法：协议、重启、幂等、安全。

前置条件：隔离 App Server home 和端口。

操作：执行三个 app-server verify 命令及 `app-server-event-center-test-cases.md`、`app-server-state-sync-test-cases.md`；覆盖 singleton、auth/origin/query/payload、dedupe、projection rebuild、cursor、WS、cloud sync fallback、Codex compensation。

预期：现有 protocolVersion、JSONL/state/lock 格式和 at-least-once 语义不变；shared subpath 迁移不改变 payload；App Server 不因大重构被无必要重写。

失败判断：重复实例、事件丢失/重复副作用、非法请求通过、状态无法重建、敏感 token 入日志，或 Backend 把 ThreadRef 当 TerminalState。

### SAR-022 CLI 命令、agent 推断与确认兼容

方法：等价类、状态迁移。

前置条件：CLI 指向隔离 backend；准备 shell idle、agent starting/idle/running、echo/no-echo、timeout 场景。

操作：执行 `runweave-cli-control-plane-test-cases.md`；重点覆盖 `rw terminal send/handoff/interrupt`、agent start/exit、panel target、确认置信度和错误 exit code。

预期：flags、stdout/stderr、JSON、exit code、agent 推断和 timeout 与基线一致；command entry 不承担推断实现但行为不变。

失败判断：仅因拆文件改变 CLI 输出/exit、确认误判、输入发错 pane、或 CLI 直接依赖 Backend 内部实现。

### SAR-023 Stable/Beta 更新、失败回滚与本地安装

方法：场景法、故障注入、回滚。

前置条件：记录 Stable/Beta 当前版本、releaseId、安装路径、backend/App Server 健康和干净/脏工作区场景。

操作：分别执行 dry-run/status、成功 update、App-only/runtime-only/App Server-only、构建失败、健康失败、rollback；用 `$computer-use` 打开目标客户端并进入 Terminal 页面。

预期：拆分脚本与旧入口 flags 兼容；目标选择、snapshot、codesign、安装、健康、状态文件和 rollback 顺序不变；失败保留原可用版本。

失败判断：Stable/Beta 串通道、脏工作区丢失、失败仍更新 state、rollback 不可用，或只验证脚本退出码未验证 Terminal 页面。

### SAR-024 Toolkit Hook 唯一源码与 Electron mirror 一致

方法：一致性、错误猜测。

前置条件：`plugins/toolkit/hooks` 为 canonical source；Electron packaging mirror 可清空后重建。

操作：修改隔离 fixture 中一个 canonical Hook，运行 sync/build；比较五组文件 hash/权限；再故意改 mirror、缺文件、去执行位并运行 architecture/build/hook verify。

预期：正常同步后内容和权限一致；mirror 手改/缺失/权限错均失败并提示 canonical 路径；Hook 上报、fallback、飞书通知仍通过。

失败判断：两个目录都可被当作源码、过期 mirror 仍打包、secret 进入报告，或 sync 改动用户无关 Codex cache。

### SAR-025 鉴权、Origin、ticket、路径与日志脱敏边界不放宽

方法：判定表、安全负例。

前置条件：可构造缺/错 token、错误 Origin、非法 query/payload、跨 project/session/panel/target、路径逃逸和敏感字段。

操作：对 Backend、App Server、Electron IPC/CDP、prototype/preview 文件路径、terminal tickets 和日志执行现有安全负例；检查错误响应和日志。

预期：所有非法访问被拒；不同 connection/project/session/panel/window/target 隔离；Authorization、refresh token、webhook secret 不写日志/cache/manifest。

失败判断：适配器拆分后 validation 漏掉、越权读取、路径逃逸、target 串扰，或敏感字段出现在任一证据文件。

### SAR-026 listener、timer、WebSocket、PTY、BrowserView 资源可释放

方法：循环场景、容量边界。

前置条件：可读取进程句柄/日志/连接数；准备同一流程循环 20 次。

操作：循环打开关闭 Web terminal、切换 connection、mount/unmount Preview、断开重连 WS、创建删除 tmux panel、打开关闭 Browser tab/DevTools/annotation、重启 backend/Electron。

预期：listener/timer/WS/CDP/PTY/BrowserView 数量回到稳定基线；无 MaxListeners warning、重复事件、僵尸进程或端口占用；第 20 次行为与第 1 次一致。

失败判断：资源数单调增长、同一事件处理次数增长、退出挂起、端口无法重用，或靠强杀掩盖 dispose 缺失。

### SAR-027 旧版本数据与按 PR 回滚可用

方法：兼容、回滚。

前置条件：保存重构前 LowDB、scrollback、Agent Team run/outbox、App Server event/state/lock、App connection/auth index 和 Browser tabs fixture；保留每个 PR 的前一版本。

操作：新代码读取并操作旧 fixture；随后回滚当前 workstream PR，用回滚代码读取未改变格式的数据；对 HTTP/WS/IPC/CLI 样本做前后对照。

预期：无需一次性迁移；新旧代码均可读取冻结格式；回滚只影响当前模块；没有 Query/Zustand、façade/新 service 双写残留。

失败判断：必须手工修数据才能启动、回滚后数据不可读、合约字段变化、或一个 PR 同时绑定多个不可独立回退的系统。

## 覆盖说明

- 主路径：SAR-007 至 SAR-024。
- 边界值：SAR-002、SAR-003、SAR-017、SAR-026。
- 非法输入与安全：SAR-004、SAR-021、SAR-025。
- 异步迟到与竞态：SAR-007、SAR-011、SAR-020。
- 并发与隔离：SAR-007、SAR-014、SAR-020、SAR-026。
- 状态迁移：SAR-003、SAR-008、SAR-010、SAR-012、SAR-018 至 SAR-020、SAR-022。
- 重启/重连恢复：SAR-008、SAR-009、SAR-014、SAR-017、SAR-020、SAR-021、SAR-023。
- 幂等/去重：SAR-009、SAR-020、SAR-021、SAR-024。
- 数据/协议兼容：SAR-005、SAR-017 至 SAR-025、SAR-027。
- 权限/鉴权/越权：SAR-007、SAR-015、SAR-021、SAR-025。
- 用户视觉像素级变化不覆盖：本计划不做视觉改版；只验证可观察布局、可达性和交互语义。
- Windows 不覆盖：项目明确只要求当前 macOS Electron 客户端。
- 单元测试/coverage 不覆盖：仓库明确禁止；使用 E2E、verify 和真实环境证据。

## 验收通过标准

- SAR-001 至 SAR-027 全部通过；任一失败即不能删除 legacy baseline或宣称重构完成。
- 全仓纳入文件 `>600=0`，runtime/type cycle=0，forbidden import=0，永久豁免=0。
- 计划列出的 27 个违规文件和 11 个临界文件均由有意义的职责拆分处理，没有 `part-*` 或巨型对象伪拆分。
- Web/App 多连接、终端、Preview、Terminal Browser、Agent Team、App Server、CLI、更新与 Hook 行为均有真实证据。
- 静态门禁、repo Playwright、`$playwright-cli` 和 `$computer-use` 的职责证据齐全，未互相冒充。
- 旧持久化数据和公开合约保持兼容，每个 PR 可独立回滚。
