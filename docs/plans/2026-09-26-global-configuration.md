# Runweave 全局配置统一方案

状态：用户已批准，实施中。交付分支 `feat/unified-instance-configuration`，基于 `09fd5a41`（并行合入 #595～#598 后复核）。

当前执行记录（2026-09-26 21:25）：统一 YAML 库、143 字段合同、CLI 管理、Backend/Desktop/App Server/独立服务和 Web/iOS 配置入口已进入实现与验收阶段，尚未发布到 Stable，未更新用户手机。以下记录区分代码、安装和真实交互，不据此宣称全部阶段完成。

| 范围           | 当前证据                                                                                                                                                                                                                                                                                                                                                                                                                 | 尚未完成                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 配置底座与权限 | GCS-001～016、018～020、GCL-006/008、GCI-001 已执行；GCY-001～004 已执行，共 26/49 条 required 有完整证据；GCY-001 在实际安装产物完成 12 类非法输入 × CLI validate/import/Backend reload 的 36 次拒绝、脱敏行列号及旧快照保持验证                                                                                                                                                                                        | 其余 required 用例、字段默认值和完整来源清单复核                                               |
| 安装态和隔离   | GCI-001 已在新 Dev `dvs-d915e5` 验收：planner 自动选择打包模式，实际 App/Backend 绑定同一新实例，页面终端执行并回显专用命令；Stable 安装与 4 份旧配置来源共 5 个文件的摘要保持，Stable YAML 仍不存在。原有两个打包 Dev Session `dvs-0a6e0c`、`dvs-9b5296` 的跨实例绑定和同 ID 重建证据仍保留                                                                                                                             | 完整数据隔离、配置字节保持的升级、退出重开和失败恢复                                           |
| 桌面交互       | 第一实例通过实际页面保存语音语言；新打包实例的嵌套 `zsh -l` 从全局旧 `rw` 抢先命中修复为绑定入口，真实终端写入当前 Dev 后返回其身份；显式指向另一 Dev 和绕过入口无目标写入均拒绝，另一 Dev 摘要保持（GCL-007/014 部分证据）；第二实例实际页面可读取本地 Desktop 消费者状态                                                                                                                                               | 独立测试用户 Stable 基线、更新/清理/恢复 tmux 写入目标，以及分域与分项状态的一致展示           |
| 原生 iOS       | 当前源码已构建并安装到独立租约模拟器；实际登录第二 Dev，页面修改语言为 `en-US` 并保存，YAML、Backend 和页面均确认保存/生效版本为 5；进程重开后连接、登录态及该值/版本保持                                                                                                                                                                                                                                                | 切换连接取消请求、真机验收；不将模拟器结果写成手机已更新                                       |
| 旧 CLI 与回退  | 真实旧 CLI 在显式旧 JSON fixture 完成登录和刷新，新 YAML 字节不变；不兼容产物受管恢复入口已验证写入前拒绝；真实 CLI 完成备份预览、当前 revision/摘要与备份摘要三重校验、未来 schema 显式恢复及完整旧文件私有备份。另在打包 Dev 实例用未来 schema 阻止启动，再显式恢复备份，重新启动实际 App；Backend 身份、原项目 ID、配置消费者状态与终端标记均核实（GCI-005 部分）                                                     | 独立用户默认路径 GCS-017、受管旧二进制回退与 Stable 基线的 GCI-005 完整验收                    |
| 首次初始化     | 新增显式 `rw config init --instance stable`：0600 私有认证文件、至少 16 字符密码、随机 JWT、独立数据目录、脱敏预览、确认提交和旧来源拒绝。Desktop 启动前先判定当前实例是否有 YAML：已有文件才加载主程序，有旧来源展示迁移提示，真正全新安装展示本机表单；初始化仍复用同一配置库。隔离目录验证私有文件拒绝、唯一 JWT、0600 落盘与重复提交拒绝；真实当前 Stable 的旧 `config.json` 导致 CLI 拒绝创建新身份，旧文件摘要保持 | 独立操作系统用户下的 Stable Desktop 首启、迁移提示及表单交互验收；未在本机现有 Stable 创建配置 |
| 部署           | Snapshot Host、Push Gateway、随记 YAML 模板通过字段合同校验                                                                                                                                                                                                                                                                                                                                                              | 实际部署启动；本机 Docker daemon 不可用                                                        |

证据位于本工作区 `.runweave/config-audit-20260926/`：`storage-evidence.json`、`running-boundaries-evidence.json`、`governance-evidence.json`、`yaml-evidence.json`、`old-cli-evidence.json`、`ui-config-saved.txt`、`terminal-bound-cli.txt`、`isolation-before-second.json`、`running-evidence.json`、`desktop-local-status-loaded.txt`、`ios-install.log`、`ios-configuration-save-evidence.json`、`same-session-rebuild-evidence.json`、`terminal-after-rebuild.txt`、`cli-refresh-concurrency-evidence.json`、`optional-domain-evidence.json`、`domain-versions-evidence.json`、`json-migration-evidence.json`、`live-yaml-evidence.json`、`explicit-restore-evidence.json`、`cold-corrupt-evidence.json`、`cold-auth-evidence.json`、`cold-auth-empty-evidence.json`、`target-required-evidence.json`、`nested-shell-evidence.json`。写入中断验证包括临时文件和 rename 后两个 SIGKILL 边界；配置应用失败确认保留旧快照，未仅用成功响应推定生效。

当前修复和边界：安装验证修正了产物未携带兼容声明、App Server 重复解析参数选错实例、安装器错误代填旧产物能力、CLI 默认输出对象字符串，以及 Dev 控制面把可选域错误升级成全局启动失败的问题。分享域故障的真实安装态验证已确认核心就绪、原终端执行标记、无错误发布，在线修复后无需重启即可向本机 HTTPS fixture 发布包含标记的终端快照。

完整 Dev Session 生命周期回归现已通过 64 项检查（`dev-session-verification-final.log`）；之前的活跃槽位干扰已通过只停止本任务资源消除，健康探测 fixture 已迁至 YAML，状态/停止并发断言按合法时序核对最终状态。行列号诊断版本已通过全量类型、lint 与安装产物复核；随后新增的显式备份恢复已通过配置库/共享合同/CLI 类型检查、CLI 构建和真实 CLI 冲突/恢复验证，治理与架构检查通过。重建时绑定 CLI 的地址与凭据随新 Backend 端口更新，revision 从 5 到 6；其余字段保持，不将该结果写成严格的配置字节保持通过。

本轮另用全新打包实例 `dvs-0a2782` 复核 GCS-008/019：损坏 YAML 被启动控制面和 CLI 拒绝；缺失 JWT 与整组认证时，即使注入旧环境变量也没有补齐，配置原件及数据摘要保持。缺失单项认证最初只向安装控制面返回健康超时，已将 Backend 核心域和必要认证值的启动前检查接入 Dev Session 入口，重验返回明确字段错误。嵌套登录 Shell 原先命中旧全局 `rw`，修复 ZDOTDIR 生命周期后从真实安装态终端写入当前 Dev，跨实例参数与绕过绑定入口的无目标写入均拒绝。测试终端已关闭，Playwright 已 detach，该 Session 已停止并还原测试偏好。并行合入的 Clarity 两个构建键与 iOS 即时回复设备键已补入清单/设备 adapter；最新配置治理检查覆盖 1104 个访问点。

GCL-005 的独立目录探针补到 9 次真实 CLI 路径拒绝，覆盖另一 Dev 的绝对路径、`..` 穿越与符号链接，`data`、`runtime`、`electron/user-data` 归属函数全部拒绝，两个 YAML 摘要不变；实际安装态覆盖 userData 的拒绝仍待补。GCI-005 的安装态复核已在同一打包 Dev 完成：未来 schema 阻断启动、脱敏预览、三摘要恢复、完整未来文件私有备份、App 重新就绪、原项目 ID 与终端命令输出保留，恢复偏好后停止资源。证据为 `owned-paths-evidence.json`、`installed-recovery-prepare-evidence.json`、`installed-recovery-running-evidence.json`、`installed-recovery-terminal.txt`；这两项因测试合同中的额外边界尚未计入通过数。

首次初始化新增 CLI 入口并完成配置库/CLI 类型检查、lint、构建及治理检查。隔离探针 `new-init-evidence.json` 验证弱密码、不安全权限、符号链接、非法 JSON、相对路径与重复初始化均拒绝，JWT 每次生成不同，预览不含凭据；当前真实 Stable 因存在旧 `config.json` 返回 `CONFIG_MIGRATION_REQUIRED`，原件摘要及不存在的 YAML 保持。隔离探针仅验证文件与配置合同，不等同于独立 Stable 用户或 Desktop 首启验收，因此不增加 required 通过数。

Desktop 首启入口已按阶段拆分：有 YAML 且可读才动态加载既有主程序；无 YAML 的 Stable 在主程序加载前检查已知旧 CLI/分享/飞书及 Desktop 本地来源，旧数据仅展示迁移提示，全新用户在受限本机窗口填写管理员身份，确认后复用配置库原子创建并重启。Electron 类型、lint 和打包 bundle 已通过，bundle 确认主程序延迟加载、向导 preload 独立产出。尚未在独立 OS 用户下实际点击向导或完成安装态首启，故不计 required 通过。

新增[首次启动验收计划](../testing/platform/global-configuration-bootstrap.testplan.yaml)覆盖全新 Stable、旧数据迁移提示、无效认证和损坏 YAML 四个独立边界；格式校验通过，总 required 从 45 调整为 49。首启代码变更后还在打包 Dev `dvs-0a2782` 验证了已有 YAML 的兼容路径：实际 App 就绪，Playwright 附着 `dev:open` 提供的 Desktop CDP，页面打开既有项目、创建终端并读到 `CONFIG_BOOTSTRAP_REGRESSION_OK_20260926_2107` 输出；证据为 `bootstrap-existing-status.json` 与 `bootstrap-existing-desktop.txt`。该临时终端已关闭，Playwright detached，Session 已停止且租约释放。此回归只证明已有配置的启动路径，不替代四条首次启动用例。

GCS-014 已补齐运行态证据：先从含伪造认证值的父环境和 cwd `.env` 执行真实构建 CLI，`doctor` 指向 Dev YAML 并只列出旧来源键名，`show` 读取原用户名且输出不含伪造值；再让同一打包 Dev 的 Backend 在确实继承 `AUTH_*` 父环境、实际 cwd 存在合成 `.env` 时启动。健康握手归属原 YAML；父环境和 dotenv 两组假凭据登录均返回 401，YAML 凭据登录成功，配置字节保持，两份安装日志未含合成值。最后临时移除该实例 YAML 的必需 JWT，保留两种旧来源再次启动，启动控制面明确拒绝缺失字段，不生成默认身份，坏文件与认证数据摘要保持；原 YAML 已逐字节恢复，临时 `.env` 已删除，Session 已停止且租约释放。证据为 `legacy-source-evidence.json`、`legacy-parent-runtime-evidence.json`、`legacy-missing-auth-evidence.json`。

GCL-006 已完成真实双实例验收：打包 Dev `dvs-0a2782` 与 `dvs-9b5296` 同时就绪，分别在 pool-03/pool-01；以 A 为显式实例、B 的真实 `127.0.0.1:5004` 为目标运行实际 `rw auth login`，在发送登录请求及保存 profile 前返回 `CONFIG_TARGET_MISMATCH`，两份 YAML 摘要不变，合成密码未进入输出。独立的握手探针也得到相同拒绝；证据为 `wrong-endpoint-evidence.json`、`wrong-endpoint-cli-evidence.json`。两个实例已停止，池租约均释放。

GCL-008 已执行同实例打包 Backend 重启：先在 Dev YAML 保存合成语音语言 `en`，重启前后实际 PID 为 73388/78097，`/health` 身份和配置根相同；认证消费者均用 YAML 凭据实际登录，配置 API 两次报告语音值 `en` 且状态 applied，原项目 ID 仍存在。绑定 CLI 的会话凭据重写使 savedRevision 从 18 到 19，未把整份 YAML 字节相同误当成条件；测试语音值已恢复 null，Session 已停止。证据为 `gcl8-before.json`、`gcl8-after.json`。

GCI-001 使用当前变更按 planner 新建 `dvs-d915e5`，选择 beta 安装模式但运行身份为 Dev，而非第三种 Beta；真实安装 App 及 Backend/CLI 均绑定该实例根。Playwright 附着 `dev:open` 的 Desktop CDP，页面专用终端命令输出已保存。与启动前相比，Stable App Info/可执行文件及旧 CLI/分享/飞书来源五个文件摘要保持，Stable YAML 未生成；临时终端关闭、Playwright detach、Session 停止并释放租约。证据为 `gci1-evidence.json`、`gci1-stable-before.json`、`gci1-stable-after.json`、`gci1-new-dev-desktop.txt`。

未完成门槛仍包括完整配置来源/默认合同复核、旧独立 Beta 入口退役、首次初始化与安装态完整备份恢复流程、跨环境/切换/升级失败矩阵、独立测试用户下 Stable 验证、真实整机重启及真机验收。本机 Docker daemon 不可用。模拟器测试连接与凭据已移除、原连接恢复、租约已释放；本机 HTTPS fixture 已停止且测试发布配置已清除。Stable 和用户手机未更新。五份测试计划的 49 条 required 用例不得因局部证据被整体标记通过。

剩余发布门槛：字段默认值/来源合同复核、所有旧 writer 退役、部署及更新链、设备偏好 adapter、治理门禁、后续 GCS/GCL/GCI/GCY 与业务验收。旧 Beta 内部名称在安装态等价验收前保留；不创建新的独立 Beta 身份。
审计基线：2026-09-26，工作区 HEAD `2c2ef200`。执行前复核最新主分支和并行修改。

## 1. 目标与最终形态

在每台主机、每个操作系统用户的范围内，永远只有一个 Stable 正式环境，允许多个用于测试的 Dev Session；没有独立 Beta 版本或 Beta 环境。这是环境归属边界；不同远程主机各自独立。

使用一个稳定的全局根目录，每个环境实例一份私有 YAML，共用一套配置读写模块。Backend 提供已有客户端可调用的管理 API，Desktop 和 CLI 共用同一个文件读写实现；不增加配置服务进程、配置数据库、云账号体系或通用插件框架。

用户在任意目录启动，从 Dock 启动、登录启动、重启 Backend、升级 App、重启电脑后，同一实例读取同一份配置。分享只是第一个暴露问题的功能，本次范围是下表全部配置域。

默认正式实例：`~/.runweave/settings.yaml`。目录权限 0700，文件和备份 0600。
现有 `~/.runweave/config.json` 是旧 CLI 文件，仅作为一次性迁移来源；新文件必须是独立普通文件，不能与旧路径互为符号链接或硬链接。迁移保留连接 ID、profile 名称、当前连接和有效凭据。旧版 `ProfileStore.load()` 只保留 activeProfile/profiles，后续 save 会覆盖整个文件，因此禁止原地扩展旧文件，也不能假设给新版加 schema 检查就能限制旧二进制。

建议布局：

```text
~/.runweave/
  settings.yaml                  # 正式实例持久配置，唯一权威来源
  config.json                    # 历史 CLI 来源；迁移后新版不再读写或同步
  config-backups/                 # 私有迁移/修改备份，带版本和摘要
  dev-sessions/<id>/              # 多个 Dev Session，每个实例独立
    settings.yaml
    data/                        # 本次测试的独立数据
    runtime/                     # 本次测试的锁、端口、PID、manifest
```

这是配置和环境隔离布局。Stable 已有数据路径作为显式配置保留，不为了改名搬迁全部数据库和浏览器数据；Dev Session 的全部 Runweave 自有状态必须绑定各自实例根，禁止沿用 Stable 的隐式全局目录。大文件、终端历史、数据库、Cookie、锁文件、运行时 manifest 不写进 settings.yaml。

远程 Linux 使用该服务运行账号的 `~/.runweave/settings.yaml`；systemd 等部署可通过明确的绝对 `--config-dir` 指定受管目录。多实例必须指定不同目录并复用已有 owner/锁检查。禁止依据 cwd、仓库路径、worktree 或软件版本自动选择配置根。

手机和浏览器受平台沙箱限制：通过 Backend API 管理服务配置；本设备主题、连接选择和登录凭据保留在本设备统一存储入口，Keychain/浏览器登录隔离不退化。统一管理不等于把手机登录 Token 拷贝到电脑全局文件。

## 2. 已确认的源码事实与审计覆盖

当前分享初始化只读取 `process.env`，旧登录脚本只设置 GUI 环境；推送另有持久 JSON；桌面代理、浏览器 profiles、伴随窗口、隧道、CLI、飞书分别有读写入口。默认 Backend profile 路径还包含 cwd 哈希。这些事实意味着仅修分享与推送不足以消除同类问题。

初次直接访问扫描为 285 个环境键/773 处访问/171 个文件；补查动态 allowlist、部署模板、历史通知 hook 和上下文输出后，当前清单包含 **332 个具名环境键、914 处来源记录、188 个文件**，结果在[访问清单](2026-09-26-global-configuration-accesses.csv)。这些数字不是用户配置项总数。扫描排除 Vendor 和私有忽略文件；动态生成的键另列规则。

[逐项 key 清单](2026-09-26-global-configuration-keys.md)补充非环境字段、设备存储键、类型草案、来源和目标归属；[YAML 展示样例](2026-09-26-global-configuration-settings.example.yaml)展示拟议结构与占位数据，不是当前电脑配置，也不可直接用于部署。样例不是默认值合同，真实迁移优先保留既有值。

所有访问均须在实施时分类：持久配置、系统环境、构建参数、运行上下文、测试专用、淘汰别名。未分类访问不能留到交付；不使用一个宽泛的“其他”白名单掩盖遗漏。

| 配置域                                                             | 当前主要源码入口                                                                                                                                                                         | 目标归属/处理                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend 监听端口、绑定地址、CORS、静态资源                         | `backend/src/server/runtime-config.ts`、`backend/src/index.ts`                                                                                                                           | `backend.server`；产物路径归启动上下文                                                                                                                     |
| 认证账号、JWT、TTL、Cookie、安全开关                               | `backend/src/auth/config.ts`、`electron/src/backend/packaged/auth.ts`                                                                                                                    | `backend.auth`；保留既有 secret 和认证数据库；登录会话仍属状态                                                                                             |
| 分享发布地址、上传凭据；Snapshot Host 端口与目录                   | `backend/src/terminal/snapshot-share/publisher.ts`、`backend/src/bootstrap/terminal-snapshot-shares.ts`、`deploy/snapshot-share/`                                                        | `services.snapshotPublisher`；Host 使用自己目录的 `services.snapshotHost`                                                                                  |
| 推送发送端、hostId；网关 APNs 与监听配置                           | `backend/src/device-monitor/push-client.ts`、`packages/push-gateway/src/config.ts`                                                                                                       | `services.pushSender`；网关自己的 `services.pushGateway`；APNs 私钥保留私有文件引用                                                                        |
| 飞书 App ID/Secret、群聊、允许用户、通知用户                       | `packages/runweave-cli/src/feishu/config.ts`、`state-store.ts`                                                                                                                           | `services.feishu`；消息去重、游标和 PID 属状态                                                                                                             |
| 隧道认证、SSH hosts、Backend endpoints、远程访问                   | `electron/src/tunnels/store.ts`、`backend/src/tunnels/`、`frontend/src/features/tunnels/migration.ts`                                                                                    | `desktop.tunnels`、`backend.tunnelAuth`；保留 desktopId、hostId、连接 ID；SSH 私钥仍在原凭据设施                                                           |
| 浏览器 profiles、默认 profile、代理、请求头                        | `electron/src/browser/profile/preferences.ts`、`browser/proxy/preferences.ts`、`terminal-browser-proxy-preferences.ts`、`frontend/src/components/terminal/browser/header/use-headers.ts` | `desktop.browser`；按 profile 保存，多个代理入口合为一个 owner；Cookie 不进入配置                                                                          |
| 浏览器控制/CDP 端口、Whistle、WebMCP                               | `electron/src/desktop/config.ts`、`electron/src/browser/`                                                                                                                                | 固定策略进入 `desktop.browser`；分配端口和握手地址归运行上下文                                                                                             |
| Agent 二进制、目录、默认 provider/model/effort                     | `backend/src/evolution/providers/`、`backend/src/voice/codex-app-server-client.ts`、`backend/src/terminal/runtime/terminal-agent-settings.ts`                                            | `agents`；同名路径解析统一；外部 Codex/Pi 自有配置仅引用，不复制登录和 provider 设置                                                                       |
| Agent Team 角色模型、执行策略                                      | `backend/src/agent-team/runtime/model-config-store.ts`、`packages/shared/src/agent-team/model-config.ts`                                                                                 | `agents.team`；运行快照保留创建时配置，不改变已运行任务                                                                                                    |
| 终端 tmux、Shell、滚动及输入偏好                                   | `backend/src/terminal/runtime/environment.ts`、`backend/src/terminal/tmux/`、`frontend/src/features/terminal/state/preferences.ts`                                                       | `terminal`；session/pane/运行命令/草稿/快捷回复内容仍是状态或用户内容                                                                                      |
| 定时任务总开关、超时、输出限制、存储路径                           | `backend/src/scheduled-tasks/bootstrap.ts`、`backend/src/utils/path.ts`                                                                                                                  | `scheduledTasks`；任务定义/历史仍由既有 SQLite 管理                                                                                                        |
| 语音转写语言、提示词、provider                                     | `backend/src/voice/transcription.ts`、`codex-app-server-client.ts`                                                                                                                       | `voice`；运行请求参数有明确的允许覆盖字段                                                                                                                  |
| Experience/Evolution/Activity 学习开关、路径、命名空间             | `backend/src/experience/`、`backend/src/evolution/`、`backend/src/utils/path.ts`                                                                                                         | `knowledge`、`storage`；临时 MCP 授权和测试 namespace 不持久化；保留数据库身份                                                                             |
| App Server 固定路径、发现策略、轮询策略                            | `app-server/src/config.ts`、`packages/shared/src/app-server/`                                                                                                                            | `appServer`；PID、releaseId、临时端口、实例 token 归握手/状态                                                                                              |
| 日志等级、落盘开关、日志目录                                       | `backend/src/logging/`、`backend/src/utils/path.ts` 及各运行时日志入口                                                                                                                   | `logging`；运行时日志内容不进入配置                                                                                                                        |
| Desktop 伴随窗口、偏好、主题、通知策略                             | `electron/src/companion/preferences.ts`、`electron/src/desktop/`、Frontend 偏好入口                                                                                                      | `desktop.preferences`；浏览器独立页面/手机保留设备局部偏好入口                                                                                             |
| 更新源、自动安装策略、签名工具选择                                 | `electron/src/updater/config.ts`、`scripts/update/context.mjs`、`scripts/update/system.mjs`                                                                                              | `updates`、本机 `developer`；安装包内默认值只作默认，临时构建输出与签名会话归工具上下文                                                                    |
| CLI 连接、当前 profile、认证上下文                                 | `packages/runweave-cli/src/config/profile-store.ts`、`client/auth-context.ts`                                                                                                            | `cli`，原 profiles 无损迁移；自动 refresh 与设置更新共用 revision/锁，避免互相覆盖                                                                         |
| Web/iOS 连接列表、主题、常亮、代理头偏好                           | `frontend/src/features/connection/`、`features/auth/`、`packages/app-ios/Sources/RunweaveIOS/State/ConnectionStore.swift`、`CredentialStore.swift`、`App/ScreenAwakeModifier.swift`      | 本设备统一 Preferences/Connection/Credential adapter；服务设置仅调用被选中 Backend，不落本地第二份权威副本                                                 |
| 随记服务数据库、存储、监听、鉴权时长、AI/MCP                       | `packages/suiji-server/src/config.ts`、`deploy/suiji/`、`packages/suiji-ios/`                                                                                                            | 独立部署同样用库和 schema 下的 `services.suiji`，独立私有配置根；保留已有 MCP 凭据迁移禁令                                                                 |
| 项目工作服务端口、命令与环境                                       | `backend/src/terminal/workspace-service/config.ts`、`environment.ts`、项目 `runweave.json`                                                                                               | 保持项目级文件；仅覆盖项目服务允许字段，不能覆盖账号、共享凭据或全局存储根                                                                                 |
| Dev Session、历史 Beta 入口、构建、部署、hook 和 Agent Bridge 参数 | `scripts/dev-session/`、`scripts/beta/`、`scripts/update/`、`packages/agent-bridge/`                                                                                                     | 固定用户选择归 `developer`；测试统一归 Dev Session；历史 Beta 命名/入口迁移退役；sessionId、owner、token、产物路径等归显式启动上下文；不得全量继承配置密钥 |

当前 `.env`、环境别名、动态 `env[name]`、解构读取和原生 ProcessInfo 访问均在盘点范围内。无需把 PATH、LANG、Shell 或第三方 CLI 的环境合同改为 Runweave 配置。

## 3. 最小配置机制

### 3.1 一份文件与一种明确覆盖规则

`settings.yaml` 提议顶层包含 `schemaVersion`、`revision`、`kind`、`instanceId`、`domainVersions`、按域 `migrations`，以及上表的业务域。schemaVersion 标识整体文件结构；业务域版本在 domainVersions 中记录，schema 登记 owner 和依赖，支持不同消费者分别升级。YAML 中可含本实例服务凭据，因此整个文件按私密数据处理；不另造第二份 secrets 文件引入跨文件事务。现有系统 Keychain、Electron safeStorage 加密凭据、SSH 私钥、APNs 文件采用引用或原 adapter 并保留保护方式，不迁成明文 YAML。

有效业务配置 = 内置安全默认值 + 当前实例文件。正式产品不从 cwd `.env` 或 Shell 环境读取同一业务字段，不在多个文件间搜索“看起来能用”的值。开发/部署需要一次性导入环境时，执行显式 `rw config import-env`，先校验、展示脱敏差异并持久保存，后续与环境脱钩。

项目级 `runweave.json` 只对项目字段生效。端口临时分配、进程 owner、构建 revision 等属于显式启动上下文，不成为永久配置。允许的上下文字段有穷举清单；凭据只传给需要的服务组件，不扩散到终端、Agent、Web 或手机。

`--config-dir` 是进程入口选择权威文件的唯一覆盖。正式 Desktop 默认定位唯一 Stable；测试入口创建或附着明确的 Dev Session 并绑定隔离目录。不存在第三种 Beta 运行身份。不再用 `RUNWEAVE_CONFIG_FILE` 同时表达 CLI、后端和测试实例的不同含义。

### 3.1.1 单 Stable、多测试 Dev Session 的硬合同

- 身份为 `{ kind: stable|dev, instanceId }`。Stable 的 ID 固定为 stable；Dev Session 的 ID 创建时生成并持久化。别名、端口、分支名、cwd 都不是身份。
- 正式产品默认只定位 Stable。Dev Session 必须明确实例身份；缺 ID、路径越界或文件身份不符时拒绝启动。禁止创建第二个 Stable 目录来绕过占用。
- Stable 的 Backend 有绑定操作系统用户的全局 owner 锁，锁身份不能随端口或 `--config-dir` 改变。首次明确选定 Stable 根后持久注册；另一个根的启动请求须拒绝，变更根只通过显式迁移完成。重复启动只能附着已验证的同一实例或报占用，不能换端口启动第二个 Stable。App Server 等角色有自己的角色锁，但属于同一 Stable 环境。
- 每个实例只读内置默认值和自己的配置文件；Dev Session 不继承 Stable 配置、密钥、CLI 登录、飞书发送身份、Browser Cookie 或终端数据。缺配置时对应能力明确 unconfigured。
- 隔离覆盖 auth/JWT/refresh token、hostId、CLI profile、Browser userData/profile、SSH tunnel owner、tmux socket/session、端口/CDP、Activity/Evolution/Experience、定时任务 SQLite、推送身份/订阅、Bridge 游标/租约、App Server state/token、日志、更新状态和运行锁。可共用只读产物及工具二进制，不共用可变状态。
- planner 当前的 shared-declared Backend/App Server 路径必须同步调整：有可变状态的服务改为 Session 独占；保留只读构建产物复用。不能仅改配置目录却继续连接共享服务；阶段 D 记录新增进程数量、启动耗时和内存占用，再决定并发 Session 上限。
- Backend、Electron、CLI、Bridge、App Server 绑定同一个明确 EnvironmentContext，握手校验 kind/instanceId/configRoot。环境引用通过受控启动参数传递，业务配置不靠父进程环境继承。
- 非 Stable 的可写路径必须做归属校验，防止绝对路径、路径穿越、符号链接指向 Stable 或其他实例。用户项目代码路径可显式引用，不等于共享运行状态。
- 现有代码中名为 Beta Pool 的槽位只作为待迁移的测试资源实现看待，不再代表独立产品环境；资源槽位和 Dev Session 身份分别管理。沿用资源租约、安全回收和设备池约束，复用槽位不能复用前一个 Session 的数据身份。
- Dev Session 提供绑定实例的 rw 启动入口，通过参数和 registry/manifest 验证 kind、instanceId、configRoot，随后核对服务握手；不能仅凭环境变量存在判断归属。普通机器 Shell 的无目标默认值只用于本机只读配置查询，输出必须带目标身份，不自动 refresh 或写磁盘。
- 配置修改、迁移、reload、认证登录、更新、清理以及其他远端写操作，必须携带显式实例选择（提议 `--instance stable|<dev-id>`）或受验证的绑定入口参数。两者冲突则拒绝；完全丢失上下文时，无论来自普通 Shell 还是 Dev Shell，一律拒绝无目标写操作。嵌套 Shell、tmux 恢复也遵守此合同；不会尝试猜测来源。`--instance` 通过注册信息解析目录，与显式 `--config-dir` 同时出现时必须一致。Token 自动刷新仅可在目标身份已验证后写入该实例的认证状态。
- 更新和清理绑定 kind/instanceId/owner。Dev Session 的构建、重建和运行只写测试产物与自己的数据；正式更新入口只针对唯一 Stable。结束 Dev Session 只清理本实例拥有的临时资源，不删除 Stable 或其他 Session。
- 跨环境导入只允许显式非敏感偏好白名单；创建新身份，不复制凭据、订阅、运行历史、PID/锁。无隐式 fallback 或自动同步。

### 3.1.2 Dev Session 的用途与旧 Beta 处理

Dev Session 仅用于源码开发和测试，不是第二套长期发行版。一个 Session 对应一次可追溯的测试上下文，可按原 ID 暂停后恢复；重新创建必须生成新 ID。测试完成通过既有生命周期入口结束，按证据保留策略处理该 Session 的测试数据，不能自动提升为 Stable。

测试初始化使用内置默认值、合成 fixture 和显式提供的测试服务凭据。可以显式复制非敏感偏好，不隐式借用正式 Token、账号、订阅或业务数据。需要真实外部服务的测试要单独声明授权目标。

现有 Beta 名称是源码审计中的历史事实，不是目标模型。实施时盘点 Beta App、更新目标、目录、Pool、CLI 参数和正在运行的 owner。Dev Session 必须保留源码 Web、源码 Electron、打包安装三种测试模式；打包模式覆盖首次启动、退出重开、升级、失败恢复和资源回收，全部绑定 Session，不能操作 Stable 安装。模式不是新增运行身份，也不建立长期 Beta 更新通道。

先把 `scripts/dev-session/planner.mjs` 对 installed runtime/updater 的影响闭包、`services/dedicated.mjs`、`beta-pool/`、`scripts/beta/`、`scripts/update/` 的目标解析接入 Dev Session，保留租约与 start/status/open/stop/stale recovery 合同。安装态等价验收通过后才停用旧创建/更新入口；退役后旧入口明确提示迁移，不静默映射到 Stable。正在使用的旧实例先保留并报告，不强制退出或删除。旧数据仅在归属明确且用户选择保留时导入指定 Dev Session 的测试资料或私有归档，不能并入 Stable。

### 3.2 一套小型读写库

配置采用 YAML 1.2 单文档、仅 JSON 可表达的数据类型；解析前限制文件 1 MiB，解析过程中限制嵌套深度 32，超限拒绝并保留原件。顶层必须为映射；拒绝重复 key、非字符串映射键、自定义标签、锚点/别名、merge key 和多文档。字符串不进行环境插值、Shell 执行或 include；日期、前导零 ID、Token 等字符串由序列化器正确引用，不能被隐式转型。禁止从 YAML 构造任意对象。沿用项目已有 YAML 库并锁定解析选项；同一解析器用于 CLI、Backend 和迁移。

统一 writer 使用文档 AST 修改指定字段，尽量保留无关字段顺序和注释；禁止把 YAML 当 JSON 文本拼接。CAS 与迁移摘要基于原文件字节，连只改注释的并发编辑也必须识别；revision 是成功提交序号。读入时同时记录磁盘摘要，写入加锁后重读比较摘要和 expectedRevision，避免手工编辑未递增 revision 时被覆盖。原子写、文件权限和备份策略不因换格式改变。旧 JSON 只经显式迁移转为 YAML，不维护 JSON/YAML 双份权威配置。

提议 `packages/config-node/` 提供 Node 文件与锁操作，`packages/shared/src/configuration/` 只提供纯类型、schema 和跨端 DTO；Swift 对照公开 DTO。不要把 fs/Keychain/Node 能力新增进纯共享合同。

必要能力只有：固定根路径、schema/默认值、读、校验、带 revision 写入、迁移、脱敏投影。
写入沿用现有私有文件原子写模式：同目录临时文件、0600、fsync、rename，按目标平台处理目录同步；加跨进程锁和 expectedRevision。刷新 CLI Token 与 UI 保存也走同一锁，禁止 read-modify-write 覆盖别人的字段。锁 owner 绑定进程身份，不能仅凭一个旧 PID 或超时直接抢锁。

启动顺序：确定实例目录 → 读取/显式迁移 → 校验文件结构与核心域 → 分域校验并创建消费者 → 公布核心 readiness 和各域状态。已存在旧来源的新版本首次启动应进入迁移提示，不自动导入或当作全新实例；真正没有旧来源的新安装才进入初始化向导。

- 无法解析 YAML、不支持整体 schema、身份/认证/路径归属等核心错误：阻止对应核心服务启动，保留原件，不写默认配置、不生成新身份；本机离线 doctor 仍可脱敏诊断。
- 分享、推送、飞书等可选域：缺配置显示 unconfigured，格式或版本错误显示 error，停用该域及其明确依赖；核心终端和无关域继续可用。不能把可选域错误升级为整机服务不可用，也不能把整个系统显示成全部正常。独立网关所必需的配置属于该网关核心域，由字段合同明确，不能照搬 Backend 的可选分类。
- 不理解的其他消费者业务域按原值保留，禁止默认化或覆盖；支持的域仍能读取并按 CAS 修改。PATCH 校验整体核心合同、被修改域及其依赖，不能因无关可选域已有错误而阻止修复其他域；修改未知域则明确拒绝。整体 schema 不支持仍拒写。
- reload 的校验失败保留原运行快照并报告磁盘错误；新启动没有旧运行快照时，只隔离错误可选域。任何凭据错误均不回退旧来源或其他实例。

Stable 已有数据的绝对路径写入 `storage` 引用，消除后续 cwd 推导；Stable 不移动 Cookie、数据库、App bundle 和缓存。Dev Session 现有可变数据仅按可证明的实例归属迁移；历史共享数据库中的记录必须核对 namespace/owner，归属无法证明的记录保留原状并报告冲突，不全库复制或划给任一实例。不存在或无法确认数据归属时停止迁移，不能自动新建另一套“空的正常实例”。

### 3.3 统一管理入口和真实生效状态

CLI 提议入口：`rw config path|show|validate|set|import|import-env|reload|migrate|doctor`。默认所有输出脱敏；`path` 不输出内容，`show` 默认不输出密钥，不提供通过远程接口导出原始私有文件的功能。

Backend 提议 API：

- `GET /api/configuration`：返回当前实例可管理字段、revision、字段生效方式、凭据 configured 状态。
- `PATCH /api/configuration`：`{ expectedRevision, changes }`；白名单字段 patch，未提交字段保持，凭据保留/替换/删除三态，不把脱敏占位当新凭据。
- `POST /api/configuration/reload`：加载手工编辑且校验通过的新版本，报告所影响服务。
- 状态响应：`savedRevision`、每个 consumer 的 `appliedRevision`、`state`（applied/restartRequired/error）、安全错误码。不能只因文件保存成功就报“已生效”。

通过现有认证保护。服务设置只能由当前 Backend 的配置管理者修改；现有单用户部署将现有所有者身份映射为管理者，不把任何新登录用户默认升级为所有者。完整配置根、认证根、JWT、可执行路径、数据库凭据、APNs、签名和更新源只允许本机文件拥有者/受管部署通道修改，普通远程设置接口不开放。Web/iOS 拿不到这些值，跨 Backend 切换取消旧请求并核对实例身份。

Backend 服务域由 Backend 应用；Desktop 独有域由 Electron 应用，不让远程 Backend 任意操作当前电脑配置。Desktop 在线通过受限本地通道报告自己的 appliedRevision；CLI 离线写磁盘后明确报告待对应进程 reload。手机显示“本手机”和“当前连接电脑”两个明确归属。

分享/推送这类可更换客户端，在保存后创建并验证新客户端、按 revision 切换，再释放旧客户端；在途请求按旧快照完成。端口、认证根、tmux、存储路径需要重启时准确显示，不自动中断运行任务。手工改文件需显式 reload；第一版不依赖文件监听实现跨进程一致性。

状态诊断不得自动发布终端正文、发通知或给他人发飞书消息；这些外部业务验证使用独立 fixture 和授权目标。

## 4. 迁移：逐域切换，每个字段只有一个权威来源

1. `rw config migrate --dry-run` 先列出唯一 Stable 及全部已注册 Dev Session 实例，对每个实例分别生成草稿和结果，不合并跨环境来源。明确枚举现有 CLI 文件、选定 Backend profile、Desktop userData、分享私有文件、推送文件、飞书配置来源和部署清单；不递归搜遍用户 HOME，不执行 env 文件或 shell。
2. 使用既有 owner/profile/连接身份定位来源，保存来源摘要、目标根、迁移 ID 和脱敏冲突报告。多个来源冲突不按“最后修改时间”或“先找到的文件”猜测；用户选择具体冲突字段，未冲突字段形成可审查草稿。
3. 分享地址与 Token、推送 gateway/hostId/token、认证 username/password/JWT 作为同来源原子组迁移。外部服务间不复用 Token。
4. 在私有备份目录保存原件，校验本批次完整凭据组与依赖后，用一次原子提交发布 settings.yaml，并在同一文件记录按域的迁移完成 ID。重跑是幂等，不重复改 revision 或身份。断电中断只能留下完整旧版或完整新版；恢复时通过迁移标记继续，不重复读取已迁移域的旧来源。
5. 按域切换全部读者、writer、脚本和部署 manifest；每批先明确消费者最低版本与停止/重启窗口，确认旧消费者退出后再提交该域迁移，重启新消费者并取证。未迁移域暂由登记的旧 owner 管理；新配置模块不能对已迁移域 fallback。域内有不可拆依赖时整组迁移。验收失败暂停后续批次，按本域备份和消费者版本恢复，不回滚其他域已完成的修改。
6. CLI 域从旧 config.json 一次性迁入 settings.yaml；新程序不再读写旧文件、不同步两个文件、不把新路径注入旧 RUNWEAVE_CONFIG_FILE，也不把旧文件链接到新文件。旧 CLI 可能仍运行，只能改旧文件；必须用真实旧二进制和合成认证服务验证登录/刷新均不能改新文件。切换时停止在途旧 refresh writer，验证新凭据仍可用；旧 CLI 之后的会话失效明确提示重新登录，不从旧文件自动找回凭据。该隔离只保护配置文件，不宣称旧 CLI 没有操作 Backend 的能力。
7. 验证新 Backend、Desktop、Bridge、App Server 等各自实际加载版本和业务结果后，停用分享环境 LaunchAgent 等旧启动补丁。旧备份保留，但已迁移域启动不再读取；全部域验收后移除旧入口登记。
8. 故障恢复分清二进制回退与配置回退。受管更新入口对目标版本执行兼容性预检；不兼容时阻止直接切换，通过明确恢复命令恢复匹配的配置备份，检查迁移后的新修改并提示差异，禁止静默丢失。不能声称此检查可阻止用户直接运行任何历史二进制；新旧文件路径隔离必须独立成立。升级失败先保持/恢复已知可用程序，配置不回退；只有程序明确不兼容时才进入显式配置恢复。

既有认证数据库、refresh token、tmux session、Browser profile ID、SSH host ID、定时任务和 App Server 线程不得清空或重建。配置写入目录与软件发布目录物理分离，更新器只能升级程序，不能覆盖全局配置。

## 5. 可独立验收的执行阶段

以下阶段按序推进，各阶段有独立验收；“底座完成”或“分享恢复”都不代表全仓统一已完成。

| 阶段                                               | 主要文件/模块范围                                                                                                      | 交付门槛                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A：逐项分类与迁移合同                              | 本清单、现有配置入口、拟新增 `packages/shared/src/configuration/`                                                      | 332 个具名环境键、动态键规则和全部非环境存储域均有分类与 owner；每个持久字段有目标、默认、密钥标记、生效方式、迁移来源                 |
| B：统一文件与无损迁移                              | 拟新增 `packages/config-node/`；`packages/runweave-cli/src/config/profile-store.ts`、拟新增 `commands/config.ts`       | 新旧文件隔离、真实旧 CLI 写入、原子写、CAS、锁、整体/分域版本、幂等迁移、离线修复通过；不运行服务也能检查配置                          |
| C：启动链和 Backend 全域                           | `backend/src/index.ts`、`bootstrap/`、`auth/config.ts`、`utils/path.ts`、上表各服务；`electron/src/backend/runtime.ts` | 无业务环境启动；单 Stable、多测试 Dev Session 的身份与数据隔离通过；清除 auth/sharing/push/voice/tasks/agents/knowledge 的直接环境读取 |
| D：Desktop、CLI、Bridge、App Server 与旧 Beta 退役 | 上表对应 Electron stores、CLI/飞书、App Server、`scripts/dev-session/`、`scripts/beta/`、`scripts/update/`             | 所有持久域归一；无目标写操作拒绝，嵌套 Shell/tmux 归属通过；可变服务独占；安装态 Dev Session 首启/升级/恢复通过后才退役旧入口          |
| E：独立服务与客户端设置                            | Snapshot Host、push-gateway、suiji-server、Frontend 设置、iOS 设置                                                     | 独立部署也直接读固定配置；公开 API 严格投影；设备偏好入口归一；项目配置边界保持                                                        |
| F：治理和真实生命周期验收                          | 拟新增 `scripts/quality/configuration.mjs`；各 AGENTS、部署文档、验证入口                                              | 全部迁移域无遗漏；门禁接入；完成安装态启动/升级/整机重启验收才宣布此类问题已关闭                                                       |

新 package 的依赖安装、打包（Electron Backend bundle、独立 Host/gateway、CLI）和构建身份指纹都必须覆盖它。迁移实现前分别读取 backend/electron/shared/CLI/iOS/scripts 的最近 AGENTS；遵循原生和 Dev Session 工具约束。

## 6. 防止以后重新散落的硬门禁

- 业务模块禁止直接读 `process.env`、dotenv、任意全局 JSON/YAML、localStorage/UserDefaults 的持久业务配置。配置模块、设备存储 adapter、构建工具、运行上下文 adapter 是具名边界；禁止用整个目录的无理由豁免。
- 系统变量、第三方 CLI 参数、进程上下文、构建和测试参数可以保留，但逐项登记用途；动态 `env[name]` 和解构也在检查范围。并非简单禁止所有环境变量。
- 每个新配置字段必须声明 owner、scope、类型、默认、是否敏感、持久化位置、迁移方式和生效方式。缺少任一项，lint/架构检查失败。
- 同一字段只有一个权威 writer/store；禁止另写 `foo-settings.yaml` 绕过统一模块。设备偏好和项目服务分别走有明确边界的 adapter。
- UI 不把保存成功当生效成功，启动 readiness 不把未完成配置校验当可用。
- 不靠人工记住规则；将配置访问扫描接入本地 lint 和现有 GitHub CI。初期按已分类存量生成精确基线，各阶段减少基线，最终业务配置旧入口归零。

## 7. 验证与交付证据

本轮维护四份目标行为计划；具体执行状态以上方记录为准，不能由格式校验推定通过。存储、环境归属、安装态分别取证；每个 case 使用自身 fixture，不能借上一例的遗留状态：

- [配置存储与权限验收](../testing/platform/global-configuration-store.testplan.yaml)
- [配置首次启动验收](../testing/platform/global-configuration-bootstrap.testplan.yaml)
- [配置启动与恢复验收](../testing/platform/global-configuration-lifecycle.testplan.yaml)
- [安装态配置与升级恢复验收](../testing/platform/global-configuration-installed.testplan.yaml)
- [YAML 格式与编辑验收](../testing/platform/global-configuration-yaml.testplan.yaml)

评审风险的发布门槛：P0 旧 CLI 覆盖对应 GCS-017；P1 故障扩大对应 GCS-018～020；YAML 格式合同对应 GCY-001～004；P1 目标丢失对应 GCL-007、GCL-014～015；P1 安装态能力丢失对应 GCI-001～006。任一 required 用例 fail/blocked 均不能宣称该风险已关闭；格式校验不计行为证据。

业务功能复用既有计划：[终端分享](../testing/terminal/snapshot-share.testplan.yaml)、[推送](../testing/app/push-notifications.testplan.yaml)、[飞书恢复](../testing/terminal/notifications/feishu-recovery.testplan.yaml)、[项目服务](../testing/terminal/workspace/services.testplan.yaml)、[iOS Agent 设置](../testing/app/ios-terminal-agent-settings.testplan.yaml)、[Backend 生命周期](../testing/platform/backend-runtime-lifecycle.testplan.yaml)。新增统一配置用例不能替代这些业务验证。

每个上表配置域须交付迁移前后脱敏字段比对、读取根路径/实例身份、saved/applied revision、原有数据身份和一个实际消费效果；各域单独记录 pass/fail/blocked，不用一项成功代替其他域。

命令：`pnpm docs:check`、上述四份文件各运行 `pnpm testplan:validate <path>`；实现后执行受影响包 lint/typecheck、`pnpm architecture:check` 和现有生命周期/业务验证入口。禁止新增单元测试或 TDD；必要的行为验证放入现有 scripts/verify 路线并按仓库合同执行。

静态校验、编译、安装、App 启动、业务可用、退出重开、升级、整机重启为不同证据。整机重启必须先保存任务并协调时间窗口，重启前后使用同一实例和配置；没有实际重启，相关 case 必须为未验收，不能用 kill/relaunch 替代。

## 8. 主要风险与退出条件

- 认证/JWT 或 profile 身份改动会导致掉线、空终端和订阅失联；迁移必须保留身份，禁止自动重建。
- 多个进程写同一文件会丢字段；跨进程锁、CAS、只修改指定域及并发冲突验收是发布前置。
- 旧 CLI 全量覆写风险通过独立 settings.yaml 隔离；真实旧二进制必须参与验收。新版 schema 拒写检查仅约束实现了检查的版本。
- 可选配置域故障不得阻断核心终端；核心身份与安全错误不得降级绕过。按消费者声明依赖和 ready/error/unconfigured，禁止一份文件变成全部功能的故障开关。
- Dev 写操作必须可证明目标身份；缺失目标拒绝，不能通过默认 Stable 补齐。安装态测试模式通过等价验收后才允许旧 Beta 入口退役。
- 全局文件集中密钥后，权限/日志/远程 API 投影必须核对；任何原始配置和迁移备份都不进入 Git、分享、诊断导出或 Agent 环境。
- 不承诺消除网络、磁盘或外部服务所有故障。交付承诺是：启动路径不再决定持久配置；配置源唯一且可验证；故障有明确状态且不静默丢配置；新代码不能绕过这套规则。
