# Runweave Dev Session 分层开发环境测试用例

## 范围

本文档验证 Dev Session 的 profile 推荐、ownership 分层、服务身份、manifest、并发、生命周期和三种验证 surface。Beta 多实例的 bundle identity、更新和回滚细节继续由 `runweave-beta-instance-cdp-routing-test-cases.md` 覆盖。

本仓库不新增单元测试文件。纯协议和路径规则使用 `scripts/verify-dev-session.mjs`；浏览器页面使用 `$toolkit:playwright-cli`；Electron/Beta 窗口、应用启动和系统行为使用 `$computer-use`。

## 前置条件

- 记录 Stable Backend/App Server 的 PID、service identity、health、namespace 和端口基线。
- 准备 `<worktree-a>`、`<worktree-b>`；同一 worktree 可存在多个 Session，但资源冲突时本次启动必须 fail closed；稳定并行的多个 Agent Team 使用不同 worktree。
- 测试 Session ID 使用 `dvs-` 前缀；证据不记录 token、Authorization、密码或 hook secret。
- 页面用例保存 Playwright session name、URL/CDP endpoint、DOM marker、console 和 identity 输出。
- 所有命令从 Stable 主应用 terminal 执行；Beta 只作为被启动和被附着的目标，不在 Beta terminal 中执行任何测试步骤。

## 每轮测试清场

- 一个 Agent Team 只使用一个 worktree；同一 worktree 可保留多个 Session，多 Agent Team 需要稳定并行时使用不同 worktree。
- 每轮使用独立的 `RUNWEAVE_DEV_SESSION_HOME=/tmp/runweave-dev-session-<run-id>`。开始前若同名测试 home 已存在，先对身份可验证的测试 Session 执行 stop，再删除其中已 stopped/failed/stale 的 manifest、session 目录和 `.port-leases` 配置。
- 清场完成后确认该测试 home 不含旧 manifest/lease，且不存在属于该 `<run-id>` 的进程和监听端口；未清干净则本轮不启动。
- 只清理本轮测试 home 和测试前缀资源，不删除 Stable、其他 worktree 或其他 Agent Team 的 Session 配置。

## 必跑门禁

```bash
pnpm dev:session:verify
pnpm typecheck
pnpm lint
git diff --check
```

任一失败即停止。静态门禁不能替代真实进程、浏览器和桌面证据。

## 用例索引

| ID      | 场景                                 | 验证方式                  |
| ------- | ------------------------------------ | ------------------------- |
| DVS-000 | Stable 始终是开发控制面              | CLI + 真实进程            |
| DVS-001 | 显式 profile 优先于自动推荐          | verify 脚本               |
| DVS-002 | changed paths 计算影响闭包           | verify 脚本               |
| DVS-003 | 低于必要边界的 profile fail closed   | verify 脚本               |
| DVS-004 | manifest 原子写、权限和秘密过滤      | verify 脚本               |
| DVS-005 | 同 worktree 多 Session 冲突时回滚    | 真实进程 + CLI            |
| DVS-006 | Frontend 复用默认 Backend/App Server | 真实进程 + Playwright     |
| DVS-007 | shared 不可用时显式升级 ownership    | 真实进程 + CLI            |
| DVS-008 | capability 不匹配时拒绝共享          | 真实进程 + CLI            |
| DVS-009 | Fullstack 使用独立 Backend profile   | 真实进程 + Playwright     |
| DVS-010 | App Server profile 隔离状态          | 真实进程 + Playwright     |
| DVS-011 | Frontend 与错误 Backend 握手失败     | Playwright                |
| DVS-012 | Electron 区分两类 CDP surface        | Computer Use + Playwright |
| DVS-013 | 全局 CDP 配置不能劫持 resolver       | Playwright                |
| DVS-014 | 多候选未指定 Session 时拒绝猜测      | CLI                       |
| DVS-015 | Agent 重启/换 terminal 后恢复        | CLI + Playwright          |
| DVS-016 | stop 只停止 dedicated 服务           | 真实进程                  |
| DVS-017 | PID 复用/endpoint 漂移 fail closed   | 真实进程                  |
| DVS-018 | 强退后的 stale 诊断                  | 真实进程                  |
| DVS-019 | 旧开发入口兼容                       | 真实进程 + Playwright     |
| DVS-020 | Stable 控制面驱动 Beta adapter       | Beta 子用例               |
| DVS-021 | endpoint 与清理路径安全              | verify 脚本               |
| DVS-022 | 状态冲突迫使未改服务 dedicated       | 真实进程 + Playwright     |

## 用例细则

### DVS-000 Stable 始终是开发控制面

- Given：开发 Agent/Team 和 shell 位于 Stable 主应用 terminal；将 frontend、fullstack、app-server、electron、beta 作为五个相互独立的参数化场景执行。
- When：仅从该 Stable terminal 对目标 profile 执行 dry-run、start、status、open、验证和 stop；无论目标服务成功还是失败，都记录命令发起 terminal、Agent Team run/pane、源码 cwd 和目标服务 identity。
- Then：所有开发命令的发起 terminal、Agent Team run/pane 与源码 cwd 始终属于 Stable；任何 profile 都不要求进入目标 terminal，目标服务的启动或健康失败不改变该控制面归属结论。
- 失败判断：文档或命令要求在 Dev Server、Electron Dev 或 Beta 中继续跑开发脚本、迁移当前 Agent/Team，或依赖目标 shell env 才能完成验收。目标 profile 自身的 readiness、URL/status/CDP 或生命周期失败归入对应 profile 用例，不单独导致 DVS-000 失败。

### DVS-001 显式 profile 和 surface 优先

- Given：只修改 `frontend/**`，自动建议 `frontend`。
- When：分别 dry-run 默认、`--profile fullstack`、`--profile electron --surface desktop`。
- Then：结果依次为 frontend/fullstack/electron，并包含 `selectedBy` 和影响理由。
- 失败判断：显式值被 diff 覆盖，或同一输入结果不稳定。

### DVS-002 changed paths 计算最小影响闭包

- Given：构造 frontend、backend、app-server、electron、updater 和 shared contract 的 staged/unstaged/untracked 组合。
- When：执行 `dev:session --dry-run --json`。
- Then：得到计划定义的 profile；shared contract 根据真实 consumer 扩大；输出每条影响边。
- 失败判断：遗漏 untracked/unstaged，或 shared contract 固定映射到一个 profile。

### DVS-003 不完整 profile 在启动前失败

- Given：App Server 协议已改，必要闭包为 app-server。
- When：显式要求 `--profile frontend`，不提供 service override。
- Then：非零退出并列出缺失 Backend/App Server ownership；没有进程或状态副作用。
- 失败判断：以不完整链路启动，或静默提升但不告知。

### DVS-004 manifest 原子、最小权限且不泄密

- Given：临时 HOME 含秘密 env 和正常 identity。
- When：创建、更新并模拟中断写 manifest/registry。
- Then：始终可读完整 schema；文件 `0600`、目录不高于 `0700`；秘密不出现在文件、日志或 CLI JSON。
- 失败判断：半写 JSON、宽权限或秘密明文。

### DVS-005 同 worktree 多 Session 冲突时提示并回滚

- Given：`<worktree-a>` 已有 ready 的 fullstack Session `dvs-a1`；为 `dvs-a2` 注入与 `dvs-a1` 相同的端口、namespace 或 profile lock。
- When：从同一 worktree 启动 `dvs-a2`。
- Then：`dvs-a2` 非零退出并明确返回冲突资源、现有 Session/进程 identity 和处理指引；本次启动已经拉起的 dedicated 服务全部回滚，manifest 标记 failed/stopped；`dvs-a1` 的 PID、health、状态和配置保持不变。
- 失败判断：静默覆盖/复用冲突资源、只留下 EADDRINUSE 而无 Session 归因、本次半启动服务残留，或误停 `dvs-a1`。

### DVS-006 Frontend 有意复用默认服务

- 验证：真实进程 + `$toolkit:playwright-cli`。
- Given：默认 Backend/App Server healthy 且 capability 兼容，已记录 PID/identity。
- When：启动 `dvs-fe` frontend profile 并打开 web surface。
- Then：只新增 Frontend；Backend/App Server 为 shared-declared，记录真实 identity/sharedReason；页面可用；共享 PID 不变。
- 失败判断：重复启动共享服务、只记端口不记 identity，或页面连错 Backend。

### DVS-007 共享候选不可用时显式升级

- Given：默认 Backend 停止，frontend profile 允许安全补齐 dedicated Backend。
- When：启动 Session。
- Then：计划和 manifest 明确记录 ownership 升级及原因，并使用 Session profile。
- 失败判断：复用 stale lock，或升级但不告知。

### DVS-008 capability 不匹配时拒绝共享

- Given：默认 Backend 缺少验收要求的 capability，且命令要求必须共享。
- When：启动 frontend profile。
- Then：退出码 4，输出 expected/actual capability，不启动 Frontend。
- 失败判断：只 warning 后继续，或伪造 legacy capability。

### DVS-009 Fullstack Backend profile 独立

- 验证：真实进程 + `$toolkit:playwright-cli`。
- Given：默认 Backend 存在已知 terminal/browser 状态。
- When：启动 `dvs-fs` 并创建独有 marker。
- Then：Backend identity/namespace/profile 与默认不同；默认状态不可见且未改变；Vite proxy 指向 Session Backend。
- 失败判断：profile lock 冲突、状态跨实例可见或代理指错。

### DVS-010 App Server 隔离 home、event 与生命周期

- 验证：真实进程 + `$toolkit:playwright-cli`。
- Given：默认 App Server 有 event/cursor 基线，启动 `dvs-as`。
- When：写 Session event、重启 Session App Server并读取投影。
- Then：使用独立 home/token/event log/identity；默认 PID、event、cursor 不变。
- 失败判断：回退默认 lock、共享 event log 或停止默认 App Server。

### DVS-011 Frontend 错绑 Backend 时阻止业务页

- 验证：`$toolkit:playwright-cli`。
- Given：manifest 期望 Backend A，代理故障注入到 healthy Backend B。
- When：打开 Web surface。
- Then：显示明确握手错误和非敏感 expected/actual identity，业务请求不继续。
- 失败判断：正常进入并使用 B，或只有 console warning。

### DVS-012 Electron 区分 Desktop 与 Terminal Browser CDP

- 验证：`$computer-use` + `$toolkit:playwright-cli`。
- Given：Electron Session 的主窗口和 Terminal Browser 各有唯一 marker。
- When：分别 open desktop/terminal-browser 并显式附着。
- Then：endpoint/identity 不同；Desktop 只读主窗口 marker，Terminal Browser 只读内嵌页面 marker。
- 失败判断：surface 混用 endpoint 或 target 属于其他实例。

### DVS-013 全局 CDP 配置不能改变目标

- 验证：`$toolkit:playwright-cli`。
- Given：ambient env 和全局 CLI config 指向另一个 Runweave。
- When：解析并附着 `dvs-electron + desktop`。
- Then：target 与 manifest identity/marker 一致，证据记录显式 endpoint。
- 失败判断：附着 ambient endpoint，或 resolver 输出被覆盖。

### DVS-014 多候选时拒绝猜测

- Given：当前 worktree 有两个 live Session，shell 无 Session env。
- When：不传 `--session` 执行 status/open/stop。
- Then：退出码 3，列出 ID/profile/revision/state，无副作用，并要求显式选择 Session。
- 失败判断：按端口、时间或名字选择任一 Session。

### DVS-015 Agent 重启后按 identity 恢复

- 验证：CLI + `$toolkit:playwright-cli`。
- Given：`dvs-recover` ready，关闭原 Agent/Playwright session但保留服务。
- When：新 terminal 按 ID 查询并重新打开 surface。
- Then：得到相同 service identity、PID、revision 和页面 marker，不依赖旧 shell env。
- 失败判断：必须复制旧端口，或解析到最近的其他 Session。

### DVS-016 stop 只处理 owned 服务

- Given：Session 有 dedicated Frontend、shared Backend/App Server，记录 PID。
- When：执行 `dev:stop --session`。
- Then：Frontend 退出；shared PID/health/状态不变；manifest 进入 stopped。
- 失败判断：停止、重启或清理 shared 服务。

### DVS-017 PID 复用和 endpoint 漂移 fail closed

- Given：结束 dedicated 服务，并让无关进程占用相同端口或构造 PID/startedAt 不匹配。
- When：执行 status/open/stop。
- Then：标记 stale/identity mismatch；open/stop 非零；无关进程不受影响。
- 失败判断：端口 healthy 就接受新进程，或按 PID 直接 kill。

### DVS-018 跨 worktree 强退后可诊断且互不影响

- Given：`<worktree-a>` 的 Session A 与 `<worktree-b>` 的 Session B 均 ready。
- When：SIGKILL A launcher/Backend/Electron 的不同组合后查询 A/B。
- Then：A 准确标记 degraded/stale 并给日志/cleanup 指引；B 始终 ready；A cleanup 不删除 B。
- 失败判断：全局清理、B 被停止，或 A 仍报告 ready。

### DVS-019 旧入口迁移期兼容

- 验证：真实进程 + `$toolkit:playwright-cli`。
- Given：记录改动前 `pnpm dev`、`pnpm dev:electron`、`pnpm app:dev` 的端口、env、页面、退出基线。
- When：阶段 1 至 4 后逐一执行；阶段 5 再执行 `dev:legacy`。
- Then：旧入口行为与基线一致，legacy 复现原 fullstack 行为。
- 失败判断：helper 提取改变 profile/env 清洗/退出或旧入口无法启动。

### DVS-020 Stable 控制面驱动 Beta adapter

- 验证：执行 Beta 多实例测试文档。
- Given：Agent 位于 Stable 主应用 terminal；该 shell 的 channel/CDP env 均属于 Stable；准备两个 Beta revision/instance。
- When：只从该 Stable terminal 执行 beta profile 的启动、status、open、Playwright attach、stop 和 rollback。
- Then：无需进入 Beta terminal；Beta 在约定 readiness 窗口内达到 Desktop/Backend/CDP healthy；统一 resolver 从 manifest/Beta status 得到显式 Beta endpoint，最终 target identity/channel 为 Beta；App/userData/CDP 独占，未受影响 Backend/App Server 可 shared-declared；stop/rollback 完成身份复核与资源清理。
- 失败判断：Beta readiness 超时、manifest 与 Beta status 身份矛盾、stop/rollback 因实例身份漂移失败，任一步要求 Beta terminal/env、新版 Beta CLI 或手工复制端口，或 attach 使用 Stable ambient CDP。该失败只归入 DVS-020，不回写为 DVS-000 控制面失败。

### DVS-021 endpoint 与清理路径安全

- Given：非 loopback endpoint、`..`、symlink 和允许根外路径。
- When：执行 plan/open/cleanup。
- Then：连接/删除前失败；允许根外文件不变；错误不泄密。
- 失败判断：连接远端、跟随 symlink 删除或字符串前缀绕过。

### DVS-022 跨 worktree 状态冲突时不得因代码未改而共享

- 验证：真实进程 + `$toolkit:playwright-cli`。
- Given：Backend/App Server 代码未改，但 `<worktree-a>`、`<worktree-b>` 的验收会创建同名 terminal、修改 event/cursor 或测试重启恢复。
- When：两个 worktree 的 Planner 分别计算环境并并发运行用例。
- Then：受影响服务 dedicated 或使用独立 namespace；状态和生命周期互不影响。
- 失败判断：只凭“代码未改”共享，导致状态可见、cursor 争用或互相重启。

## 证据模板

```text
caseId:
result: passed | failed | blocked
devSessionId/profile:
sourceRoot/sourceRevision:
services: ownership + serviceInstanceId + PID + resourceNamespace
surface: web | desktop | terminal-browser | n/a
command/tool:
artifact: screenshot/DOM/console/status/log path
failureReason:
```

## 退出条件

- DVS-000 至 DVS-019、DVS-021、DVS-022 全通过后，才允许切换 `pnpm dev`。
- Beta profile 上线前，DVS-020 与 Beta 子文档全部通过。
- 浏览器用例未执行 `$toolkit:playwright-cli`，或桌面用例未执行 `$computer-use`，必须标记 blocked/未执行，不能以 typecheck、代码阅读或截图替代。
