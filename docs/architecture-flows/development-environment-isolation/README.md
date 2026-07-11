# development-environment-isolation（Runweave 开发环境隔离架构）

Runweave 本地开发、Electron Dev、Beta 和多 Beta 并行验证时的服务 ownership、环境分级、身份握手与串线风险可运行架构说明。

- **性质**：基于当前工作区源码、当前进程/lock/CDP 状态和既有 Beta 隔离方案制作的技术架构原型。
- **梳理日期**：`2026-07-11`。
- **核心问题**：开发者如何用一条稳定主线，从改动范围得到最小充分环境，并确保 Frontend、Backend、App Server、CDP 不串线。
- **目标结论**：源码侧统一创建 Dev Session。Dev Session 自动推荐环境 profile，允许显式覆盖；未改动且不受契约、状态和生命周期影响的服务复用默认实例，其余服务由本次 Session 独占。
- **非目标**：不实现新的编排器，不修改现有服务，不把技术说明页面当作产品 UI。

## 启动

```bash
python3 -m http.server 6194 --directory docs/architecture-flows/development-environment-isolation
```

打开：

```text
http://127.0.0.1:6194/
```

## 怎么读

1. 先读“推荐开发工作流”，理解日常开发唯一主入口和完整生命周期。
2. 再读“分层判定”和环境 profile，理解为什么某些服务复用默认实例、某些服务必须独占。
3. “Dev Session Capsule”展示 Session、服务实例、资源 namespace 和 CDP surface 的身份关系。
4. 最后看当前风险和渐进落地顺序；风险只是解释目标方案的必要性，不再承担阅读主线。

## 推荐开发工作流

### 唯一主入口：源码侧 Dev Session

推荐将现有分散启动方式收敛为一个源码侧入口。以下是目标交互，当前尚未实现：

```bash
# 根据 changed paths 和验收目标推荐最小 profile，并打印将复用/启动的服务
pnpm dev

# 开发者或 agent 对推荐结果做显式覆盖
pnpm dev --profile frontend
pnpm dev --profile fullstack
pnpm dev --profile app-server
pnpm dev --profile electron
pnpm dev --profile beta --instance agent-a

# 统一发现、打开、诊断和停止
pnpm dev:status --json
pnpm dev:open --surface web
pnpm dev:open --surface desktop
pnpm dev:open --surface terminal-browser
pnpm dev:stop
```

`pnpm dev` 位于当前源码 worktree，因此不依赖可能较旧的 Stable App/CLI。自动判断只负责**推荐** profile；显式 `--profile`、验收目标和用户意图始终优先，避免纯 diff 推断误判。

### 一次开发的完整闭环

1. **Plan**：读取 changed paths、用户目标和验收 surface，计算影响闭包并推荐 profile。
2. **Resolve**：为四项服务分别选择 `dedicated`、`shared-declared` 或 `disabled`；共享服务解析到具体 `serviceInstanceId`。
3. **Start**：只启动 dedicated 服务，生成 Dev Session manifest；不重复启动默认 Backend/App Server。
4. **Handshake**：逐边核对 service instance、capability、revision、profile/namespace 和 endpoint。
5. **Open & Verify**：返回准确 Web URL 或 CDP surface，供右侧 Browser、`$toolkit:playwright-cli`、`$computer-use` 使用。
6. **Stop**：只停止 Session 拥有的进程和资源；shared 服务不被重启或清理，stale 资源进入诊断。

### 身份模型

| 身份                | 含义                                                | 解决的问题                                       |
| ------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `devSessionId`      | 一次开发/验收任务                                   | Agent 重启、换 terminal 后仍能恢复同一工作上下文 |
| `serviceInstanceId` | 一个真实运行的 Frontend/Backend/App Server/CDP 实例 | 共享服务不必错误归属于某个 Session               |
| `ownership`         | `dedicated` / `shared-declared` / `disabled`        | 决定谁负责启动、停止和清理                       |
| `resourceNamespace` | profile、event/cursor、auth、browser group 等状态域 | 服务共享时仍能判断状态是否会冲突                 |
| `surface`           | `web` / `desktop` / `terminal-browser`              | 决定验证入口和 CDP 目标                          |

dedicated 服务记录 `ownerDevSessionId`；shared 服务保留自己的稳定 `serviceInstanceId`，Dev Session 只引用它。不能要求共享 Backend 的 `ownerDevSessionId` 等于某个 Frontend Session，否则“一份默认 Backend 服务多个前端”的合理模型会被破坏。

### 为什么选择这个方案

| 方案                         | 优点                         | 主要问题                                     | 判断                       |
| ---------------------------- | ---------------------------- | -------------------------------------------- | -------------------------- |
| 继续靠文档和手工命令         | 实现成本最低                 | 端口、profile、环境变量和清理持续漂移        | 不足以解决串线             |
| 固定五套启动脚本             | 容易理解                     | 只解决启动，不解决身份、发现和生命周期       | 可作为 profile 底层实现    |
| 完全依赖 git diff 自动启动   | 使用最省事                   | 无法理解用户意图、状态写入和验收目标         | 只用于推荐，不作为最终裁决 |
| 每 worktree 全量容器/沙箱    | 隔离强                       | Electron/macOS/CDP 成本高，Frontend 开发过重 | 不作为本地默认             |
| 所有改动都部署 Beta          | 最接近发布形态               | 反馈慢、资源多、掩盖服务边界                 | 仅用于安装态/跨版本验收    |
| Dev Session：推荐 + 显式覆盖 | 兼顾复用、隔离、可诊断和扩展 | 需要统一 manifest/status/stop 协议           | 推荐方向                   |

## 当前代码事实

- `dev.mjs` 为 `pnpm dev` 动态分配 Backend/Frontend 端口，并按 cwd hash 选择 dev browser profile；同一 worktree 内的并行 agent 仍会落到同一 profile。
- Frontend 通过 `VITE_PROXY_TARGET` 固定代理到本次 dev Backend，这是当前较清晰的一条绑定边。
- Backend 未收到显式 `RUNWEAVE_APP_SERVER_URL/TOKEN` 时，会从默认 App Server lock/token 自动发现全局 App Server。
- Electron 为每个运行实例启动 Terminal Browser CDP Proxy，并把 endpoint 注入 Backend/新 terminal；全局 Playwright 配置和 ambient env 仍可能指向别的实例。
- Beta Desktop CDP 与 Terminal Browser CDP 是两个不同 surface。

## 2026-07-11 当前现场

- 发现 5 份 Backend profile lock，实际监听至少包含 `5001/5002/5003`，说明历史/stale lock 与多运行实例同时存在。
- 发现 Stable 和 Beta 两个 App Server lock，分别使用独立 home。
- 同时存在 `9224/9225/9226` 三个 Runweave CDP Proxy，以及 Beta Desktop `9335` 原生 CDP。
- 当前现象证明“端口存在”不能说明服务属于哪个 worktree、revision 或被测实例。

## 核心结论

### 分层依据：不是全局或不全局，而是影响范围

对每项服务按顺序判断：

1. **代码是否改变**：服务自身代码、配置或运行时发生变化时使用 `dedicated`。
2. **契约是否受影响**：即使服务代码没改，只要上游/下游协议、认证、事件 schema 或启动参数改变，也需要把相关服务纳入独立验证闭环。
3. **状态是否会冲突**：测试会创建/修改 terminal、event、cursor、auth、browser tab 等共享状态时，使用独立实例或明确 namespace。
4. **生命周期是否是验收对象**：涉及启动、停止、重连、更新、回滚、故障恢复时，该服务必须由本次 Dev Session 拥有。

四项都是否时，服务可以使用 `shared-declared`：包括默认 Backend、默认 App Server 或全局规则。关键不是禁止全局，而是 manifest 明确记录“为何允许共享、实际解析到哪个服务身份”。

“代码未改”是允许共享的必要条件，但不是充分条件。例如 Backend 代码未改，但测试会并发创建相同 profile 下的 terminal，则仍需独立 Backend/profile；App Server 代码未改，但验收涉及 event log 重放或进程重启，则仍需独立 App Server。

### 最小充分环境，而不是默认全量 Beta

| 改动范围                       | 最小建议环境                                                                                                  | 不应默认启动                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 纯 Frontend 视图/交互          | 独立 Vite Frontend + 默认 Backend；默认 Backend 可继续使用全局 App Server；右侧 Browser group-scoped tab 验证 | Beta App、独立 Backend/App Server、Desktop CDP |
| Frontend + Backend/API         | 独立 Frontend + 独立 Backend/profile；App Server 按影响范围选择 shared-declared 或 dedicated                  | 打包 Beta                                      |
| App Server/hook/event schema   | 独立 Frontend/Backend + 独立 App Server home/token/event log                                                  | 共享 Stable App Server                         |
| Electron/Terminal Browser/CDP  | Electron Dev Session：独立 Frontend/Electron/CDP；Backend/App Server 继续按影响闭包选择                       | 完整安装 Beta，除非涉及安装态                  |
| packaging/updater/runtime/迁移 | Beta App identity/userData/runtime/CDP 独立；Backend/App Server 继续按影响闭包选择                            | 不相关服务的全量复制                           |
| 两个 revision 并行或升级兼容   | 多 Beta capsule；App identity/userData/CDP 独占，未受影响且无状态冲突的 Backend/App Server 可 shared-declared | 全局端口、全局 Playwright 默认                 |

### Dev Session Capsule

每次开发运行由一个 manifest 描述：

```json
{
  "devSessionId": "dev-agent-a",
  "profile": "electron",
  "source": {
    "root": "/path/to/worktree",
    "revision": "<git sha>"
  },
  "services": {
    "frontend": {
      "ownership": "dedicated",
      "serviceInstanceId": "frontend:<id>",
      "ownerDevSessionId": "dev-agent-a",
      "url": "http://127.0.0.1:<port>"
    },
    "backend": {
      "ownership": "shared-declared",
      "serviceInstanceId": "backend:stable-default",
      "url": "http://127.0.0.1:5001",
      "resourceNamespace": "stable-default-profile"
    },
    "appServer": {
      "ownership": "shared-declared",
      "serviceInstanceId": "app-server:stable-default",
      "url": "http://127.0.0.1:<port>"
    },
    "cdp": {
      "desktop": {
        "ownership": "dedicated",
        "serviceInstanceId": "cdp:dev-agent-a:desktop",
        "endpoint": "<endpoint>"
      },
      "terminalBrowser": {
        "ownership": "dedicated",
        "serviceInstanceId": "cdp:dev-agent-a:terminal-browser",
        "endpoint": "<endpoint>"
      }
    }
  }
}
```

`shared-declared` 可以指向默认服务，不要求额外部署。它与 ambient discovery 的区别是：Planner 明确决定复用，manifest 记录解析后的 `serviceInstanceId`、endpoint、capability、版本和状态边界，启动后再做身份校验。没有出现在 manifest 中的服务不得被 ambient env、默认 lock、默认端口或最近会话自动引入。

### 身份握手

端口和 PID 只是 transport 信息，不是实例身份。目标态至少需要以下握手：

- Frontend manifest 记录 `expectedBackendServiceInstanceId`；Backend health 返回的身份/capability 不匹配时阻止进入业务页面。
- Backend 为 dedicated 时绑定 Session-scoped profile；使用默认 Backend 时记录其 `serviceInstanceId`、profile 和允许共享的状态边界。
- App Server 事件、consumer cursor、hook payload 至少可关联 backend ownership/resource namespace；dedicated 模式不得回退到默认 App Server。
- Electron 状态同时报告 Desktop CDP 与 Terminal Browser CDP，并包含 `devSessionId`、`serviceInstanceId`、revision、PID 与 target identity。

## 潜在问题与证据等级

| 编号 | 结论                                                                                                    | 等级                               |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| R1   | Backend 在无显式 env 时会发现默认全局 App Server                                                        | 当前代码事实                       |
| R2   | dev profile 默认按 cwd hash，同一 worktree 多 agent 可能共享 profile lock/data                          | 当前代码事实                       |
| R3   | Frontend 通过 Vite proxy 固定 Backend，但尚无 service instance/capability 握手                          | 当前代码事实 + 结构性风险          |
| R4   | 当前机器同时存在多个 Backend lock/CDP Proxy，端口不能充当实例身份                                       | 当前现场事实                       |
| R5   | 全局 Playwright config/ambient CDP env 可能覆盖开发者的被测目标                                         | 已验证历史问题                     |
| R6   | shared App Server 即使通过 terminal ownership 过滤，也仍共享 event log、cursor 命名空间、版本和生命周期 | 明确共享边界，不等于已确认业务串线 |
| R7   | 各服务独立寻找空闲端口只能避免占用，不能证明它们属于同一 Dev Session                                    | 结构性风险                         |

## 渐进式落地顺序

1. **Dev Session Planner**：基于 changed paths、用户意图、契约影响、状态写入和验收 surface 推荐 profile，并允许显式覆盖。
2. **统一 manifest 与身份输出**：让现有启动脚本记录 devSessionId、serviceInstanceId、revision、endpoint/profile/ownership，并提供 status/open/stop。
3. **禁止隐式发现**：在 isolated mode 中关闭默认 App Server 和全局 CDP fallback；shared 模式必须显式声明。
4. **服务握手与 fail closed**：Frontend↔Backend、Backend↔App Server、Agent↔CDP 校验 service instance、capability 和 resource namespace。
5. **实例级生命周期**：统一 start/status/stop/cleanup，识别 stale lock/orphan process，不按端口盲杀。
6. **多 Beta**：最后扩展动态 app identity、per-instance bundle/userData/App Server/CDP；复用前五步，而不是另建一套规则。

## 与现有计划的关系

`docs/plans/2026-07-11-runweave-beta-instance-cdp-routing.md` 应视为 Dev Session 的 `beta` profile 子计划，不应成为所有开发任务的默认环境。若继续实施，建议先写上层 Dev Session 计划，再让多 Beta 复用同一套 Planner、manifest、service identity、open 和 stop 协议。

## 代码源

- `dev.mjs`
- `frontend/vite.config.ts`
- `frontend/src/App.tsx`
- `backend/src/index.ts`
- `backend/src/server/profile-lock.ts`
- `backend/src/utils/path.ts`
- `packages/shared/src/app-server-node.ts`
- `app-server/src/config.ts`
- `app-server/src/singleton.ts`
- `electron/src/main.ts`
- `electron/src/backend-runtime.ts`
- `electron/src/terminal-browser-cdp-proxy-port.ts`
- `electron/src/terminal-browser-cdp-proxy.ts`
- `scripts/runweave-beta.mjs`
- `scripts/runweave-update-core.mjs`

## 验收点

- 五种开发模式均可切换，四项服务 ownership 和说明随模式更新。
- 默认视图直接展示推荐 Dev Session 工作流和目标命令入口。
- Dev Session Capsule 展示 Session、服务实例、ownership、resource namespace 和 surface 的目标关系。
- 风险表明确区分当前事实、结构性风险和历史问题。
- 页面在 1440×1000 视口无非预期横向溢出，console error/warning 为 0。
- 默认阅读状态截图保存为 `prototype-preview.png`。

## 边界

- HTML 不连接或修改任何 Runweave 服务。
- 页面只展示当前事实和目标原则；Dev Session、统一握手和环境选择器均未实现。
