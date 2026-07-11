# Runweave Dev Session 分层开发环境实施计划

## 结论

Runweave 自身开发不应继续以“是否启动 Beta”作为第一层选择。目标方案是由源码侧 **Dev Session** 统一完成环境规划、服务解析、启动、身份握手、验证入口发现和停止清理；每项服务再根据本次改动的代码、契约、状态和生命周期影响，选择：

- `dedicated`：由当前 Dev Session 独占并负责生命周期。
- `shared-declared`：明确复用一个已解析、已校验的默认服务实例。
- `disabled`：本次链路不需要该服务。

Beta 只是其中一个 profile，主要用于安装态、更新态、跨版本和多 revision 验收，不是所有开发任务的默认环境。

本改动按 **L3 高风险** 执行，采用渐进兼容：先增加 `pnpm dev:session`，保留现有 `pnpm dev`、`pnpm dev:electron` 和 `pnpm app:dev`；待 profile、恢复、并发和回滚门禁通过后，再将 `pnpm dev` 切换到 Dev Session，并暂留 `pnpm dev:legacy` 作为一个迁移周期的逃生入口。

## 原型与关联计划

- 架构原型：`docs/architecture-flows/development-environment-isolation/`
- 配套测试：`docs/testing/runweave-dev-session-test-cases.md`
- Beta 子计划：`docs/plans/2026-07-11-runweave-beta-instance-cdp-routing.md`
- Beta 子计划测试：`docs/testing/runweave-beta-instance-cdp-routing-test-cases.md`

Beta 子计划必须复用本计划的 Planner、manifest、service identity、status/open/stop 和 ownership 语义。若两份计划冲突，以本计划的“按影响范围分层共享”原则为准。

## 不可变运行前提：Stable 是控制面，所有 profile 都是被测面

真实开发中，代码编辑、开发用 Agent/Team、shell 和 `pnpm` 命令始终运行在 Runweave Stable 主应用的 terminal 中。Frontend Dev Server、dedicated Backend/App Server、Electron Dev 和 Beta 都只是测试/验证目标，不提供开发控制入口，也不要求开发者或 Agent“进入目标环境”。本计划必须支持且只支持以下控制方向：

```text
Stable 主应用 terminal（唯一控制面）
  └─ 当前源码 worktree 的 pnpm dev:session / status / open / stop
       ├─ 编辑代码、运行脚本、承载开发用 Agent/Team
       ├─ 启动/停止 Dev Server、Electron Dev 或 Beta
       ├─ 读取 Dev Session manifest 与目标 status
       └─ 解析 Web URL 或显式 CDP endpoint
            └─ 从 Stable terminal 验证目标页面/服务（被测面）
```

由此产生五条硬约束：

1. 五个 profile 的所有命令都必须可从 Stable terminal 完整执行，不能依赖目标环境的 terminal、shell env 或其中安装了新版 CLI/skill。
2. profile 表达“本次 System Under Test 由哪些服务组成”，不表达 Agent/Team 应该切换到哪里运行。
3. Stable terminal 当前继承的 Backend、`RUNWEAVE_DESKTOP_CHANNEL` 和 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 只描述 Stable 控制面，不能用来推断目标环境。
4. 目标 Frontend/Backend/App Server/Electron/Beta 负责暴露 health、status、URL 和 CDP identity；Stable 侧 resolver 读取并交叉验证，再驱动 `$toolkit:playwright-cli` 或 `$computer-use`。
5. 若被修改的功能本身是 Agent/Team，当前开发 Agent/Team 仍留在 Stable。验证时由 Stable 控制面对目标服务发起隔离测试请求并读取结果，不能把当前开发 run、pane 或任务上下文迁入目标环境。

因此这里不是“兼容一种特殊场景”，而是控制面拓扑本身。任何要求在 Dev Server、Electron Dev 或 Beta terminal 中继续编辑代码、承载开发 Agent/Team、设置目标 session env 或从目标 terminal 发起下一步的实现与用例，都应判为架构错误。

## 背景与当前问题

当前入口分别由 `dev.mjs`、`electron-dev.mjs`、`app-dev.mjs`、App Server 命令和 Beta 命令承担。它们能启动进程，但没有共同表达“一次开发任务到底使用了哪些真实服务实例”。

1. 同一个 worktree 中的多个 Agent 默认使用同一 cwd hash Backend profile，可能共享 terminal、auth 和 browser 状态。
2. Frontend 通过 `VITE_PROXY_TARGET` 固定 Backend URL，但不校验实例、revision、capability 或资源 namespace。
3. Backend 未显式配置 App Server 时会发现默认 App Server，无法区分“有意共享”与 ambient env/lock 偶然复用。
4. Backend `/health` 和 App Server `/healthz` 都缺少足以完成归属握手的稳定身份。
5. Electron Desktop CDP、Terminal Browser CDP Proxy、group-scoped endpoint 是不同 surface；全局 Playwright 配置可能让 Agent 附着错误实例。
6. 当前 launcher 缺少可从新 terminal 恢复的 session 状态、所有权和安全停止协议。
7. `dev.mjs` 同时是 CLI 和公共 helper，直接重写会连带破坏 Electron、App 和 iOS 本地入口。

目标不是再增加几套固定端口脚本，而是建立“规划结果可见、共享关系显式、实例身份可校验、生命周期可恢复”的本地控制层。

## 目标

1. 提供位于当前源码 worktree 的稳定入口，从改动范围得到最小充分环境。
2. 支持 `frontend`、`fullstack`、`app-server`、`electron`、`beta` 五个 profile，并允许显式覆盖自动建议。
3. 为每次开发生成稳定 `devSessionId`，为每个真实服务记录 `serviceInstanceId`、ownership、endpoint、capability、revision 和 `resourceNamespace`。
4. 允许未受影响的 Backend、App Server 被显式共享；共享服务不被当前 Session 停止或清理。
5. 同一 worktree 可存在多个 Session；资源冲突时明确提示并回滚本次启动，稳定并行的多个 Agent Team 推荐使用不同 worktree。
6. `status/open/stop` 可在 Agent 重启或更换 terminal 后恢复，并对 stale、PID 复用和 endpoint 漂移 fail closed。
7. CDP 按 `devSessionId + surface` 解析；Beta 多实例再增加 `instanceId`，不读取全局 Playwright 配置选择目标。
8. 保持现有开发入口在迁移阶段可用，并提供明确回滚路径。
9. Agent Team 与 worktree 一一对应；验收开始前只清理本轮测试前缀的旧 Session 配置和已验证归属的残留资源，不删除该 worktree 的其他合法 Session。

## 非目标

- 不在第一阶段实现容器化、远程沙箱或跨机器调度。
- 不要求每个 profile 都启动 Beta、独立 Backend 或独立 App Server。
- 不把 shared 服务强行归属于某个 Session。
- 不合并 Desktop CDP 与 Terminal Browser CDP 的协议或权限模型。
- 不把 git diff 当最终裁决；自动分析只负责推荐。
- 不把移动 App 强塞进这五个桌面 profile；继续保留 `app:dev` / iOS 入口。
- 不新增单元测试文件或测试框架。
- 不在 manifest、status 或日志中持久化 token、Authorization、密码或 hook secret。

## 目标交互与行为

第一阶段增加：

```bash
pnpm dev:session
pnpm dev:session --profile frontend
pnpm dev:session --profile fullstack --session agent-a
pnpm dev:session --profile electron --session cdp-refactor
pnpm dev:session --profile beta --session agent-a --instance agent-a

pnpm dev:status --session agent-a --json
pnpm dev:open --session agent-a --surface web --json
pnpm dev:open --session cdp-refactor --surface desktop --json
pnpm dev:open --session cdp-refactor --surface terminal-browser --json
pnpm dev:stop --session agent-a
```

- 未传 `--profile`：输出推荐 profile、判定依据和每项服务 ownership，再按确定结果启动。
- 显式 `--profile`：显式值优先，但仍执行依赖、capability 和状态冲突校验。
- 未传 `--session`：没有 live session 时生成可读短 ID；查询时只有一个候选可恢复；多个候选返回非零并要求显式选择，不按端口或最近时间猜测。
- Stable 控制 terminal 的解析优先级为显式 `--session`、可选 `RUNWEAVE_DEV_SESSION_ID`、cwd 唯一候选；Beta profile 不依赖 Beta terminal 注入任何 session/instance env。
- `dev:stop` 只停止通过完整进程身份复核的 dedicated 资源。

成功时应满足：

- 同 worktree 多 Session 无冲突时可独立运行；出现端口、namespace 或 profile lock 冲突时，本次启动明确失败并回滚自身服务，既有 Session 不变。
- 每轮验收使用独立测试 home；启动前不存在同前缀旧 manifest、port lease、测试进程或监听端口。
- 纯 Frontend 可复用兼容默认 Backend/App Server；共享目标不可用或不兼容时，Planner 明确升级为 dedicated 或失败。
- “代码未改”只是允许共享的必要条件；协议、状态写入、故障恢复或生命周期受影响时仍 dedicated。
- 错误的 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 不改变 `dev:open` 的解析结果。

## 决策输入与优先级

Planner 从高到低使用：

1. 显式 `--profile`、`--service <name>=<ownership>`、`--surface`、`--instance`。
2. 用户目标与验收目标，例如 Electron 菜单、更新回滚、纯前端样式。
3. 改动文件的影响闭包。
4. 当前服务的 capability、版本、namespace 和健康状态。
5. 兼容默认：无足够信息时保持现有 `pnpm dev` 的 fullstack 语义，不擅自判定为 frontend。

changed paths 是以下集合的并集：

- `git diff --name-only HEAD` 的 staged 与 unstaged 文件。
- `git ls-files --others --exclude-standard` 的 untracked 文件。
- 显式多个 `--changed-file`，用于非 Git 或历史 revision 复现。

工作区干净且没有显式目标时，Planner 输出理由并采用兼容 fullstack 默认，不根据上次 session 猜测。

## 影响闭包与 profile

| 范围                                         | 初始建议               | 扩大条件                                                 |
| -------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| `frontend/**`、纯 Web UI                     | `frontend`             | API 合约、共享状态或重连语义变化时到 `fullstack`         |
| `backend/**`、Backend 配置/合约              | `fullstack`            | App Server 协议、事件或生命周期受影响时到 `app-server`   |
| `app-server/**`、hook/event/cursor           | `app-server`           | 安装态或跨版本验收时再扩大                               |
| `electron/**`、Terminal Browser、Desktop CDP | `electron`             | updater、bundle identity、迁移或安装态变化时用 `beta`    |
| builder、updater、runtime package、Beta 迁移 | `beta`                 | 不自动降级                                               |
| `packages/shared/**`                         | 计算真实 consumer 闭包 | 无法确定时选择覆盖真实 consumer 的较高 profile并打印原因 |
| `app/**`                                     | 现有 App 开发入口      | 不纳入桌面 profile                                       |

显式 profile 低于必要边界时，启动前失败并列出缺少服务，不带着不完整链路继续。

### ownership 矩阵

| Profile      | Frontend      | Backend                                  | App Server                               | CDP                                        |
| ------------ | ------------- | ---------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| `frontend`   | dedicated     | 优先 shared-declared；不兼容时 dedicated | 随 Backend 显式解析或 disabled           | 验收需要时 shared-declared                 |
| `fullstack`  | dedicated     | dedicated + session profile              | 默认 shared-declared；受影响时 dedicated | 验收需要时显式解析                         |
| `app-server` | dedicated     | dedicated + session profile              | dedicated + session home/token/event log | 验收需要时显式解析                         |
| `electron`   | dedicated     | 按影响闭包 shared-declared/dedicated     | 按影响闭包 shared-declared/dedicated     | Desktop 与 Terminal Browser dedicated      |
| `beta`       | Beta App 承载 | 按影响闭包 shared-declared/dedicated     | 按影响闭包 shared-declared/dedicated     | Beta Desktop 与 Terminal Browser dedicated |

共享必须先解析具体实例、完成 handshake，并在 manifest 记录 `sharedReason`。候选不存在时：

- 可安全补齐则升级为 dedicated，并打印“共享不可用，已升级 ownership”。
- 用户要求必须共享，或 capability 不允许替代时，启动前失败。
- dedicated/disabled 模式禁止回退默认 App Server、默认 Backend 或全局 CDP。

## 核心数据模型

状态机：

```text
planned -> starting -> ready -> stopping -> stopped
                    \-> failed
ready/starting + identity lost -> stale
```

同一 `devSessionId` 的 start/stop 由 session lock 串行化；不同 Session 可并行尝试启动。资源冲突时不做复杂的全局串行或自动迁移，只提示冲突并回滚本次启动。

Canonical manifest：

```text
~/.runweave/dev-sessions/<devSessionId>/manifest.json
~/.runweave/dev-sessions/<devSessionId>/session.lock
~/.runweave/dev-sessions/<devSessionId>/logs/
```

`.runweave` 已被 gitignore。全局 manifest 是事实来源；同一 worktree 的多个 manifest 可共存，候选不唯一时要求显式 Session，不依赖端口、最近启动时间或 shell 临时变量猜测目标。

```json
{
  "schemaVersion": 1,
  "devSessionId": "agent-a",
  "state": "ready",
  "profile": "frontend",
  "controlPlane": {
    "appChannel": "stable",
    "sourceRoot": "/path",
    "originTerminalSessionId": "<stable-terminal-id>",
    "agentTeamRunId": null
  },
  "targetEnvironment": {
    "kind": "frontend",
    "acceptanceSurfaces": ["web"]
  },
  "source": { "root": "/path", "revision": "<sha>", "dirty": true },
  "services": {
    "frontend": {
      "ownership": "dedicated",
      "serviceInstanceId": "frontend:<uuid>",
      "ownerDevSessionId": "agent-a",
      "pid": 123,
      "url": "http://127.0.0.1:5173"
    },
    "backend": {
      "ownership": "shared-declared",
      "serviceInstanceId": "backend:<backendId>",
      "url": "http://127.0.0.1:5001",
      "resourceNamespace": "profile:<hash>",
      "sharedReason": "backend code and contract unchanged"
    },
    "appServer": {
      "ownership": "shared-declared",
      "serviceInstanceId": "app-server:<uuid>",
      "url": "http://127.0.0.1:<port>"
    },
    "cdp": {
      "desktop": { "ownership": "disabled" },
      "terminalBrowser": {
        "ownership": "shared-declared",
        "serviceInstanceId": "cdp:<uuid>",
        "endpoint": "http://127.0.0.1:<port>"
      }
    }
  }
}
```

约束：

- manifest/registry 临时文件 + rename 原子写，文件 `0600`，目录不高于 `0700`。
- 不记录 token；凭据通过进程 env 或现有受保护 token 文件传递。
- `controlPlane` 固定声明 Stable；origin terminal/Agent Team ID 只追踪来源，不代表 Session 归它独占，Agent 重启后仍可恢复。
- dedicated 记录 PID、启动时间、executable、cwd 和握手 identity；停止前全部复核。
- shared 不写 `ownerDevSessionId`，只记录引用、namespace 和共享原因。

## 服务身份与 capability

Backend `/health` 保留旧字段并增加可选字段：

```json
{
  "status": "ok",
  "service": "runweave-backend",
  "serviceInstanceId": "backend:<backendId>",
  "devSessionId": "agent-a",
  "sourceRevision": "<sha>",
  "resourceNamespace": "profile:<hash>",
  "protocolVersion": 1,
  "runtimeReleaseId": null
}
```

App Server `/healthz` 与 lock 增加 `serviceInstanceId`、可选 `devSessionId`、`sourceRevision` 和 capability。旧格式标记为 `legacy`：仅在 profile 不依赖新增 capability 且未要求严格隔离时允许共享。

health/status 不返回原始 profile/token 路径；对外只暴露不可逆 namespace。原始路径仅存在本机受保护 manifest。

## CDP 与验证 surface

`dev:open` 只解析目标，不把全局 Playwright 配置当目标来源：

```bash
pnpm dev:open --session agent-a --surface web --json
pnpm dev:open --session agent-a --surface desktop --json
pnpm dev:open --session agent-a --surface terminal-browser --json
```

JSON 至少包含 session、surface、service identity、endpoint/URL、PID、revision、健康状态和建议 Playwright session name。

- `web`：本次 dedicated Frontend URL。
- `desktop`：Electron 主窗口 CDP。
- `terminal-browser`：本实例 CDP Proxy；多个 Agent Control Group 时必须继续指定 group。
- 默认只打印；后续可加显式 `--launch` / `--attach`，但不得改变 resolver。
- `$toolkit:playwright-cli` 使用显式 endpoint 和含 session/surface 的 session name 附着。
- 上述命令与 Playwright attach 全部从 Stable 主应用 terminal 执行；Beta 只暴露状态和被测 target。

## 实施阶段

### 阶段 0：冻结合约与兼容基线

- 新增 `scripts/dev-session/contracts.mjs`：profile、ownership、manifest、状态机与 JSON 校验。
- 新增 `scripts/verify-dev-session.mjs`：在临时目录验证 ID、路径、状态迁移、原子写、权限和 fail-closed；这是 verify 脚本，不是单元测试文件。
- `package.json` 增加 `dev:session:verify`，不改变现有 `dev`。

验收：记录 `pnpm dev`、`pnpm dev:electron`、`pnpm app:dev` 的端口、env 清洗和退出基线；dry-run 不启动服务即可校验合约。

### 阶段 1：拆公共进程层，增加 additive 入口

- 新增 `scripts/dev-process.mjs`：从 `dev.mjs` 提取端口、env 清洗、spawn、health wait、stop/watch 和 Electron bundle helper。
- 修改 `dev.mjs`、`electron-dev.mjs`、`app-dev.mjs`、`scripts/app-ios-local.mjs`：改从公共层导入，CLI 行为不变。
- 新增 `scripts/dev-session/cli.mjs`：start/status/open/stop/dry-run。
- 新增 `scripts/dev-session/planner.mjs`：changed paths、显式输入、影响闭包和 ownership。
- 新增 `scripts/dev-session/registry.mjs`：manifest、lock、cwd 索引、stale 和清理。
- 新增 `scripts/dev-session/services.mjs`：Frontend/Backend/App Server/Electron adapter。
- `package.json` 增加 `dev:session`、`dev:status`、`dev:open`、`dev:stop`。

验收：旧入口基线不变；dry-run 稳定输出五种计划；两个 session 的 owned 路径不重叠。

### 阶段 2：Backend/App Server 身份与 shared 解析

- `packages/shared/src/runtime-monitor.ts`：为 `BackendHealthPayload` 增加兼容可选字段。
- `backend/src/server/health.ts`、`backend/src/index.ts`、`backend/src/server/profile-lock.ts`：输出/关联 Backend identity、session 和 namespace；复用已有 `backendId`。
- `packages/shared/src/app-server/types.ts`、`packages/shared/src/app-server/discovery.ts`：扩展 lock/health 和 legacy parser。
- `app-server/src/index.ts`、`app-server/src/http-server.ts`、`app-server/src/singleton.ts`：生成并返回稳定 App Server identity。
- dedicated Backend 注入 session/revision/namespace；shared resolver 交叉校验 lock、health、PID 和 capability。

验收：Frontend 可明确复用默认服务；fullstack/app-server 使用独立 namespace；服务被替换后 status 标记 stale，不按相同端口接受新进程。

### 阶段 3：跨服务 handshake 与三种 surface

- `frontend/vite.config.ts`：接收 expected Backend identity，保留现有 proxy。
- `frontend/src/App.tsx` 加局部 dev-session guard：仅 Dev Session env 存在时校验 Backend identity/capability。
- `electron/src/main.ts`、`electron/src/packaged-backend-controller.ts`、`electron/src/desktop-diagnostics.ts`：状态表达 Session、Backend 和两类 CDP identity。
- `electron/src/terminal-browser-cdp-proxy.ts`、`electron/src/terminal-browser-cdp-handlers.ts`：提供实例/group 归属证据，不改变权限模型。
- `scripts/dev-session/services.mjs`：实现 open surface 交叉校验和 JSON。

验收：Frontend 错绑 Backend 时阻止进入业务页；Electron 唯一解析两个 CDP；ambient CDP 不劫持目标。

### 阶段 4：Beta profile 与多实例

- 按 Beta 子计划修改 `scripts/runweave-beta.mjs`、`scripts/runweave-update-core.mjs`、`electron/electron-builder.beta.yml` 和 Electron Beta 状态。
- Beta 作为 Dev Session adapter，不另建 session/status/open/stop 协议。
- 修订“Backend/App Server 每 Beta 必须独占”的旧假设：仅受代码、契约、状态或生命周期影响时 dedicated。
- Beta adapter 必须是 Stable 侧的外部控制器：启动/更新后等待 Beta 写 status，再从 Stable 侧解析 Desktop/Terminal Browser CDP；不得通过 Beta terminal 完成后续步骤。

验收：两个 revision Beta 并行；App identity/userData/CDP 独占；未受影响默认 Backend/App Server 可明确共享，stop/rollback 不影响共享服务或另一实例。

### 阶段 5：切换默认入口

前置：阶段 1 至 4 的兼容、并发、stale、恢复和真实页面用例全部通过。

- `package.json` 将 `pnpm dev` 切到 Planner；原行为保留 `pnpm dev:legacy`。
- 更新 `docs/README.md`、部署/开发文档和 Toolkit Playwright 文档，只保留一条推荐主线。
- 一个稳定迁移周期后再单独评审删除 `dev:legacy`，不与默认切换同批删除。

## API、兼容与恢复

CLI 退出码：

- `0` 成功；`2` 参数非法；`3` 候选不唯一；`4` identity/capability/revision/namespace 失败；`5` 生命周期冲突或 stale；`1` 其他错误。
- JSON 诊断写 stderr、结果写 stdout。

兼容规则：

- Backend/App Server 新 health 字段可选，旧 App/CLI/Electron 继续解析。
- legacy 服务只在不依赖新 capability 时允许 shared，不伪造 identity。
- 未知较新 manifest schema 只读诊断，不允许 stop/cleanup。
- launcher 异常退出后，以 PID + startedAt + executable/cwd + health identity 判断 live/stale。
- cleanup 只处理 stale 且位于允许根目录的 owned 文件；shared 服务永不自动清理。

## 安全边界

- endpoint 仅允许 loopback；远端 CDP/Backend/App Server 默认拒绝。
- manifest/CLI JSON 采用字段 allowlist，不保存 token。
- stop 不按端口查找并杀进程，必须验证 ownership 和完整身份。
- 删除前 realpath 校验仍位于 Session/Beta 允许根目录，拒绝 symlink 越界。
- dedicated App Server/Backend 配置缺失时不得回退默认 lock。

## 风险、缓解与回滚

| 风险                        | 缓解                                                        |
| --------------------------- | ----------------------------------------------------------- |
| 一次性替换 `pnpm dev`       | additive 入口，阶段 5 才切换并保留 legacy                   |
| `dev.mjs` 被多个脚本导入    | 先提取公共层并逐入口回归                                    |
| diff 误判用户目标           | 自动只推荐；显式目标与必要闭包优先                          |
| shared 服务串线             | lock + health + PID + capability + namespace 握手           |
| 同 worktree 多 Session 争用 | 提示冲突 identity，回滚本次启动，不误停既有 Session         |
| 旧测试配置阻塞启动          | 每轮独立 test home；启动前 stop 并删除同前缀 manifest/lease |
| PID 复用误杀                | 同时校验 PID、startedAt、executable、cwd、identity          |
| 全局 Playwright 劫持        | `dev:open` 显式 endpoint                                    |
| Beta 再造控制面             | Beta 仅提供 adapter                                         |

回滚：阶段 0 至 4 均可关闭新入口回到旧命令；阶段 5 使用 `dev:legacy`。health 字段可选，无数据迁移。身份不确定时拒绝清理，不回退按端口/名称杀进程。

## 验证

完整 Given/When/Then 见 `docs/testing/runweave-dev-session-test-cases.md`。实现阶段至少执行：

```bash
pnpm dev:session:verify
pnpm typecheck
pnpm lint
git diff --check
```

还必须实际验证四个非 Beta profile、测试前清场、同 worktree 多 Session 冲突回滚、跨 worktree 多 Agent Team 并发、shared 复用与不兼容、强退 stale 恢复，并：

- 证明代码编辑、脚本执行和开发用 Agent/Team 始终在 Stable 主应用，五种 target profile 中都没有继续开发所需的 terminal 步骤。
- 用 `$computer-use` 准备和核对 Electron/Beta 桌面实例。
- 用 `$toolkit:playwright-cli` 附着 Web、Desktop、Terminal Browser，保留 URL、DOM marker、identity、endpoint 和 console 证据。
- Beta profile 继续执行 Beta 子计划全套用例。
- 所有 Beta 命令和 CDP 附着都从 Stable 主应用 terminal 发起，并记录控制 terminal 的 channel 与最终 target channel，证明两者分别为 stable/beta。

若未实际执行对应 skill，必须记录“未执行 + 阻塞原因”，不能用静态检查替代。

## 文档更新范围

- `docs/architecture-flows/development-environment-isolation/README.md`：实现后把目标命令改为真实命令。
- `docs/README.md`：登记配套测试。
- `docs/deployment/runweave-beta.md`：接入 Dev Session beta profile。
- `plugins/toolkit/skills/playwright-cli/SKILL.md` 及直接引用：补充显式 CDP resolver，不改变通用 CLI 语义。
- Beta 计划：标明上层依赖并修订 Backend/App Server ownership。

## 完成定义

- 五个 profile 共用一套 Session contract，Beta 无平行控制面。
- 每项服务的 ownership 可解释、可查询、可恢复。
- 同一 worktree 多 Session 冲突时本次启动完整回滚且不影响既有 Session；多个 Agent Team 稳定并行时使用不同 worktree，且不共享 dedicated 状态、生命周期或 CDP。
- shared Backend/App Server 可有意复用，任一 Session stop 不影响它们。
- Web/Desktop/Terminal Browser 均可由 session + surface 唯一解析并完成真实验收。
- 默认入口切换前，旧入口兼容、回滚、stale 和多实例用例全部通过。
