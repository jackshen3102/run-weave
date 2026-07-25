# Agent Team 全局角色模型配置实施计划

> 粒度：L3 执行级
> 状态：已完成原型冻结与代码核查，待实现
> 原型：[`docs/prototypes/agent-team-role-model-config/`](../prototypes/agent-team-role-model-config/)
> 配套验收：[`docs/testing/agent-team/configuration/agent-team-role-model-config.testplan.yaml`](../testing/agent-team/configuration/agent-team-role-model-config.testplan.yaml)
> 当前 CLI 核对时间：2026-07-25

## 1. 目标

为当前 Runweave Backend 连接保存一份跨 Project 复用的 Agent Team 全局配置，让以下四个角色分别选择 Codex 或 TraeX 的模型与受支持参数：

- `main`：主 Agent；
- `code`：实现；
- `code_review`：代码评审；
- `behavior_verify`：行为验收。

新建 Workspace Run 必须在产生 Run、worker pane 或 checkpoint 分支之前完成配置与运行环境预检，并把四角色实际 CLI 参数固化为不可变 Run 快照。之后的 worker 调度、resume、recheck、repair、Retry 和 framework rerun 只读取来源 Run 快照，不因全局配置修改而漂移。

完成标准：

1. Workspace 右上角现有 `...` More 菜单能打开全局配置弹窗；
2. 四个角色能独立保存 Codex / TraeX、模型、reasoning、Codex Fast 或 TraeX Max；
3. 模型目录来自当前 Backend 上的 CLI，不在前端写死；
4. 新 Run 能真实混合启动 Codex 与 TraeX worker；
5. 运行中、历史和恢复链路保持原 Run 的运行时身份；
6. 历史 Run 与旧 API 显式 `terminal` 调用无需数据迁移即可继续工作。

## 2. 明确不做

- 不做 Project 级或单 Run 的产品 UI 覆盖。
- 不在 Agent Team 右侧面板放配置控件或运行时摘要；缺配置时只允许显示“去配置”导航动作。
- 不新增 App 移动端入口；本期只覆盖 Web / Electron 共用的 Terminal Workspace。
- 不实现第三方或可插拔 Provider 框架，只支持 `codex | traex`。
- 不允许填写原始命令、原始 CLI args、自定义模型 ID、sandbox、approval 或 permission 参数。
- 不提供 Codex 输出详细度，不恢复“复制到其他角色”。
- 不自动选择 catalog 第一项；模型必须由用户显式选择。
- 不做跨 Backend、跨设备或账号云同步。
- 不迁移或批量改写历史 Run JSON。
- 不新增单元测试、Vitest、Node test 或新的测试框架。

## 3. 冻结的用户行为

### 3.1 入口与弹窗

1. 用户打开 Terminal Workspace 右上角 `More actions`。
2. 菜单底部新增 `Agent Team 模型配置`，带 `全局` 标识。
3. 点击后打开居中 Dialog；标题区域只显示 `Agent Team 模型配置` 和 `全局`，不显示连接地址或作用域说明。
4. 左侧固定四个角色，右侧编辑当前角色。
5. 关闭、点击遮罩、按 Escape 或点击取消都丢弃草稿；只有 `保存全局配置` 写入 Backend。

Dialog 必须放在 Workspace overlay 层，不能局限在 header 的局部 state 中，因为 Agent Team 启动错误也需要打开同一个 Dialog。

### 3.2 角色编辑

- CLI 分段选择只显示 Codex 和 TraeX；硬不可用的 CLI 置灰。
- 切换 CLI 后把模型置空，同时清理 reasoning、Fast 和 Max，不自动选择第一项。
- 模型选择器支持搜索，只能选择 Backend catalog 返回的模型。
- 选择模型后，reasoning 初值取 catalog 声明且确实位于支持列表中的默认档位；catalog 没有可配置档位时保存 `null` 且不传 reasoning override。
- Codex 高级参数只显示 Fast；不支持 Fast 的模型禁用该开关。
- TraeX 高级参数只显示 Max；不支持 Max 的模型禁用该开关。
- 四个角色都通过当前 catalog 校验后才允许保存。
- 同一角色出现多个 worker 时，所有实例解析同一个角色快照。

### 3.3 新 Run 与错误反馈

- 没有全局配置：Workspace 创建 Run 返回结构化 `config_required`，右侧错误区显示原消息和 `去配置`。
- 保存配置后不自动补发之前的启动请求；用户回到任务区再次点击开始。
- CLI 缺失、模型失效或参数不受支持：错误必须包含角色、Provider 和模型；不静默改用默认模型或另一个 CLI。
- Workspace 新 Run 的 main pane 只有在 `shell_idle` 时可启动。`agent_starting`、`agent_idle` 和 `agent_running` 都拒绝，不 respawn、resume、覆盖或注入已有线程。

## 4. 当前代码事实与差距

| 主题            | 当前事实                                                                                                                                  | 目标差距                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| UI 入口         | `frontend/src/components/terminal/terminal-workspace-header.tsx` 已有 `MoreHorizontal`、Radix Dropdown 和全局 overlay store               | 复用菜单，新增跨 header / Agent Team panel 可打开的 Dialog                                   |
| Dialog 基础     | `frontend/src/components/ui/dialog.tsx` 已封装 Radix Dialog                                                                               | 新增业务 Dialog，不造第二套 overlay primitive                                                |
| 创建请求        | `terminal-agent-team-panel.tsx` 的 `startFlow` 不传 `terminal`                                                                            | Workspace 新 Run 由 Backend 读取全局配置                                                     |
| 旧 API          | `CreateAgentTeamRunRequest.terminal` 和 route schema 仍允许 Run 级 CLI                                                                    | 保留兼容，不作为 Workspace 主路径                                                            |
| Run 合约        | `AgentTeamRun.terminal` 是 main 与全部 worker 共用的单一终端                                                                              | 新增四角色快照；`terminal` 仅保留 main/legacy 投影                                           |
| 主启动          | `service-lifecycle.ts` 解析一个 terminal，`requireAgentTeamTerminalAvailable` 允许部分同 Provider agent idle 状态                         | 全局路径严格要求 main pane `shell_idle`                                                      |
| worker 启动     | `service-execution.ts`、`service-serial-dispatch.ts`、`service-completion-recheck.ts`、`service-repair-protocol.ts` 等读取 `run.terminal` | 全部改为按 worker role 解析快照，旧 Run fallback 到 `run.terminal`                           |
| 恢复            | `service-worker-dispatch-support.ts` 能按 Provider thread 身份复用或 resume，但 terminal 仍来自 Run 级字段                                | 保留身份门禁，传入对应角色的快照 terminal                                                    |
| framework rerun | `service-framework-repair.ts` 只克隆 `run.terminal`                                                                                       | 同时深拷贝四角色快照                                                                         |
| UI Retry        | `retryFailedRun` 只回填表单；再次开始会创建普通新 Run                                                                                     | 新增 Backend 校验的 `retryOfRunId`，继承来源快照                                             |
| 存储            | Agent Team Run 是 Project 级文件；`utils/path.ts` 已有 Browser Profile 级 LowDB 文件路径                                                  | 全局设置与 catalog cache 必须新增 Browser Profile 级 store，不能写进 Run 目录或 localStorage |
| catalog         | 当前没有模型 catalog 服务/API                                                                                                             | 新增两个固定 CLI adapter、规范化结果与磁盘缓存                                               |
| 导出            | `AgentTeamExportResponse.run` 已完整包含 Run                                                                                              | `roleRuntimes` 进入 Run 后自动进入导出，无需第二份导出模型                                   |

## 5. 目标共享合约

### 5.1 新建 `packages/shared/src/agent-team-model-config.ts`

只定义 Codex / TraeX 两个显式 Provider，不抽象插件注册机制：

```ts
export type AgentTeamRole = "main" | AgentTeamWorkerRole;
export type AgentTeamModelProvider = "codex" | "traex";

export interface AgentTeamCatalogModel {
  id: string;
  label: string;
  description: string;
  contextWindow: number | null;
  defaultReasoningEffort: string | null;
  reasoningEfforts: string[];
  supportsFast: boolean;
  supportsMax: boolean;
}

export interface AgentTeamProviderCatalog {
  provider: AgentTeamModelProvider;
  command: "codex" | "traex";
  availability: "available" | "unavailable";
  source: "fresh" | "cache" | "none";
  version: string | null;
  capturedAt: string | null;
  models: AgentTeamCatalogModel[];
  errorCode: "cli_missing" | "catalog_unavailable" | null;
}

export type AgentTeamRoleModelConfig =
  | {
      provider: "codex";
      model: string;
      reasoningEffort: string | null;
      fast: boolean;
    }
  | {
      provider: "traex";
      model: string;
      reasoningEffort: string | null;
      max: boolean;
    };

export type AgentTeamRoleModelConfigMap = Record<
  AgentTeamRole,
  AgentTeamRoleModelConfig
>;

export interface AgentTeamGlobalModelConfig {
  schemaVersion: 1;
  roles: AgentTeamRoleModelConfigMap;
  updatedAt: string;
}

export interface AgentTeamModelSettingsResponse {
  config: AgentTeamGlobalModelConfig | null;
  catalogs: Record<AgentTeamModelProvider, AgentTeamProviderCatalog>;
}

export interface SaveAgentTeamModelConfigRequest {
  roles: AgentTeamRoleModelConfigMap;
}
```

catalog 的 `source` 和 `errorCode` 是协议事实，但原型不要求把 cache/fresh 状态画进 UI。Frontend 只用它们判断 Provider 是否可选和展示错误。

### 5.2 Run 运行时快照

在同一文件增加：

```ts
export interface AgentTeamRoleRuntime {
  selection: AgentTeamRoleModelConfig;
  terminal: AgentTeamTerminal;
  providerVersion: string | null;
  catalogCapturedAt: string | null;
}

export interface AgentTeamRoleRuntimeSnapshot {
  schemaVersion: 1;
  source: "global_config" | "retry_snapshot" | "legacy_terminal";
  capturedAt: string;
  roles: Record<AgentTeamRole, AgentTeamRoleRuntime>;
}
```

在 `AgentTeamRun` 增加可选字段：

```ts
roleRuntimes?: AgentTeamRoleRuntimeSnapshot;
```

规则：

- Workspace 全局路径创建的新 Run 必须有 `roleRuntimes`。
- UI Retry 的 successor 和 framework rerun 深拷贝来源快照。
- 历史 Run 没有该字段时，`resolveAgentTeamRoleTerminal(run, role)` 对所有角色返回规范化后的 `run.terminal`。
- 新 Run 仍写 `run.terminal = roleRuntimes.roles.main.terminal`，只作为 main/旧消费者投影；worker 不得继续直接读取它。
- 快照同时保存结构化选择和编译后的 `AgentTeamTerminal`。恢复时使用编译结果，避免未来 adapter 规则变化重解释历史配置。

### 5.3 创建 Run 兼容输入

在 `CreateAgentTeamRunRequest` 增加：

```ts
retryOfRunId?: string;
```

Backend 选择运行时的优先级固定为：

1. `retryOfRunId`：校验来源 Run 属于同 Project、同 Terminal 且已失败；深拷贝来源 `roleRuntimes`，历史来源则把原 `terminal` 投影到四个角色。
2. 显式 `terminal`：保留旧脚本/API 的 Run 级行为，不要求全局配置。
3. 两者都没有：Workspace 主路径读取全局配置并生成快照。

`retryOfRunId` 与 `terminal` 同时出现返回 400，禁止两种来源竞争。

## 6. Catalog、缓存与参数编译

### 6.1 Provider adapter

新增固定 adapter，不接受用户传入命令：

| Provider | 固定命令                                                       | 读取字段                                                                                                                                            |
| -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | `codex --version`、`codex debug models`                        | `slug`、`display_name`、`description`、`default_reasoning_level`、`supported_reasoning_levels[].effort`、`context_window`、`additional_speed_tiers` |
| TraeX    | `traex --version`、`traex models --json`、`traex debug models` | `name/slug`、描述、context window、reasoning levels、`_meta.trae.supportsMaxMode`、`business_metadata.variants.max_key`                             |

实现约束：

- 使用 `node:child_process.execFile` 或等价无 shell API；命令和参数均为代码常量。
- 每次命令设置 15 秒超时与 8 MiB `maxBuffer`。
- 只持久化上表归一化字段。CLI 原始 catalog 含大段 instructions 和内部 metadata，禁止原样写磁盘或返回前端。
- `models --json` 与 `debug models` 按精确 `name/slug` 合并；缺少标识、重复标识或非法字段的条目直接丢弃并记 warning。
- TraeX 只有 `supportsMaxMode === true` 且 `variants.max_key` 非空时才视为支持 Max。
- Codex 只有 `additional_speed_tiers` 包含 `fast` 时才视为支持 Fast；不能把 API `priority` tier 当成产品的 ChatGPT Fast。

### 6.2 缓存判定表

每个 Provider 独立缓存，不能让 TraeX 失败抹掉 Codex 的成功结果：

| CLI 状态         | catalog 结果               | 旧缓存 | 返回与写入                                                           |
| ---------------- | -------------------------- | ------ | -------------------------------------------------------------------- |
| 可执行           | 成功                       | 任意   | 返回 fresh，并覆盖该 Provider 磁盘缓存                               |
| 可执行           | 超时、非零退出或 JSON 非法 | 有     | 直接返回 cache，不要求前端刷新或确认                                 |
| 可执行           | 超时、非零退出或 JSON 非法 | 无     | 返回 unavailable / catalog_unavailable                               |
| 不存在或不可执行 | 任意                       | 任意   | 返回 unavailable / cli_missing；旧缓存保留在磁盘但不得用于保存或启动 |

最后一行与普通 catalog 临时失败分开：缺少可执行文件时即使有缓存也无法启动，因此必须硬阻止。

### 6.3 CLI 参数编译

所有 off 状态也必须显式编译，覆盖用户 `~/.codex/config.toml` 或 `~/.trae/traecli.toml` 的 ambient 值。

| 选择            | `AgentTeamTerminal`                                              |
| --------------- | ---------------------------------------------------------------- |
| Codex 基础      | `command: "codex"`，args 包含 `-m <model>`                       |
| Codex reasoning | 非 null 时追加 `-c model_reasoning_effort="<effort>"`            |
| Codex Fast 开   | 追加 `-c features.fast_mode=true`、`-c service_tier="fast"`      |
| Codex Fast 关   | 追加 `-c features.fast_mode=false`、`-c service_tier="standard"` |
| TraeX 基础      | `command: "traex"`，args 包含 `-m <model>`                       |
| TraeX reasoning | 非 null 时追加 `-c model_reasoning_effort="<effort>"`            |
| TraeX Max 开    | 追加 `-c model_backend_variant="max"`                            |
| TraeX Max 关    | 追加 `-c model_backend_variant="standard"`                       |

两者统一写 `cwd: null`、`runtimePreference: "auto"`；Project/Terminal cwd 继续由现有 session 决定。Codex 的 `check_for_update_on_startup=false` 继续由 `prepareTerminalAgent` 集中追加，adapter 不重复。

Codex Fast 的 `service_tier="fast"` 与 `features.fast_mode` 取值以当前 Codex 官方 Speed / Config 文档为准；不要使用 catalog 中面向 API service tier 的 `priority` 字段替代。

## 7. Backend 实施步骤

### 任务 1：增加 Browser Profile 级持久化

修改：

- `backend/src/utils/path.ts`
  - 在 `StoragePaths` 增加 `agentTeamModelStoreFile`；
  - 默认路径为 `path.join(browserProfileDir, "agent-team-model-settings.json")`。
- 新增 `backend/src/agent-team/model-config-store.ts`
  - LowDB 数据固定为 `{ config: AgentTeamGlobalModelConfig | null, catalogs: Partial<Record<Provider, PersistedCatalog>> }`；
  - 初始化时只做 schemaVersion 1 的保守读取，非法 config 视为 null，合法 catalog 可独立保留；
  - 复用 `pendingWrite` 串行写入，避免 config 与 catalog 产生 torn write。
- `backend/src/bootstrap/runtime-services.ts`
  - 初始化 store 与 model settings service；
  - 注入 `AgentTeamService`；
  - 暴露 store 并在 shutdown 等待 `dispose()`。
- `backend/src/index.ts`
  - shutdown 链增加 model store dispose，不改变其他资源顺序。

并发边界：本期不做 optimistic revision；Backend 串行原子写，多个客户端同时保存时最后一个成功请求生效，`updatedAt` 记录最终写入时间。

验证：

```bash
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
```

### 任务 2：实现两个 catalog adapter 与设置服务

新增：

- `backend/src/agent-team/model-catalog/codex.ts`
- `backend/src/agent-team/model-catalog/traex.ts`
- `backend/src/agent-team/model-catalog/service.ts`
- `backend/src/agent-team/model-runtime.ts`

职责：

- Codex / TraeX 文件只处理各自命令、JSON 解析和字段归一化。
- catalog service 负责 CLI 硬可用性、fresh/cache/none 判定和缓存写入。
- model runtime 负责：
  - 校验四个固定角色齐全；
  - 校验 model 与 reasoning/能力组合；
  - 编译 `AgentTeamTerminal`；
  - 创建、深拷贝和 legacy 投影 `AgentTeamRoleRuntimeSnapshot`；
  - 提供唯一的 `resolveAgentTeamRoleTerminal(run, role)`。

不要在 frontend、route 或各 lifecycle service 中复制参数拼接。

验证：

- 用受控 PATH 下的 Codex / TraeX shim 覆盖 fresh、软失败、硬缺失和非法 JSON；
- 断言磁盘只出现规范化 catalog，不包含 `base_instructions`、环境变量或认证内容；
- 断言 Fast/Max 的 on/off 都生成显式参数。

### 任务 3：增加设置 API 与结构化错误

修改：

- `packages/shared/src/agent-team.ts`：导出 model config 合约。
- `backend/src/routes/agent-team.ts`：
  - `GET /api/agent-team/model-settings`
  - `PUT /api/agent-team/model-settings`
  - PUT body 使用严格 Zod discriminated union，四个角色必填，拒绝额外字段。
- `backend/src/agent-team/service-context.ts`：暴露 get/save 方法并调用 model settings service。
- `frontend/src/services/http.ts`：让 `HttpError` 保留 JSON error 的 `details`，现有 message/status 行为不变。
- `frontend/src/services/terminal-agent-team.ts`：增加读取和保存方法。

GET 打开弹窗时探测两个 Provider；PUT 在 Backend 再校验一次请求，不信任前端 capability 状态。两条 route 继续挂在现有 `/api/agent-team` 的 `requireAuth` 之后。

统一错误详情：

```ts
type AgentTeamModelErrorDetails =
  | { code: "config_required" }
  | {
      code: "provider_unavailable";
      role: AgentTeamRole;
      provider: AgentTeamModelProvider;
    }
  | {
      code: "model_unavailable";
      role: AgentTeamRole;
      provider: AgentTeamModelProvider;
      model: string;
    }
  | {
      code: "parameter_unsupported";
      role: AgentTeamRole;
      provider: AgentTeamModelProvider;
      model: string;
      parameter: string;
    }
  | { code: "main_panel_not_shell_idle"; state: TerminalStateValue };
```

请求结构错误返回 400；保存值与当前 catalog 冲突、缺配置或运行环境冲突返回 409。

### 任务 4：在所有副作用前解析 Run 快照

修改 `backend/src/agent-team/service-lifecycle.ts` 的 `startRun`，顺序固定为：

1. 校验 session、Project、active Run、task 和 `retryOfRunId/terminal` 互斥；
2. 按 5.3 的优先级解析运行时来源；
3. 全局路径探测实际引用的 Provider，校验四角色并编译快照；
4. 解析 main terminal；
5. 准备验收来源；
6. 取得 main panel，要求全局/Retry Workspace 路径的实际 pane 状态严格为 `shell_idle`；
7. 完成 review checkpoint preflight 后才允许创建 checkpoint 分支；
8. 构造 Run，写入 `roleRuntimes`，并把 main terminal 投影到 `run.terminal`；
9. 无验收案例时用 main 快照启动主 Agent；有案例时按现有 proposal/split 流程继续。

任何 model config 错误必须停在第 3 步之前，不得留下 Run JSON、pane 或 Git 分支。旧 API 显式 `terminal` 继续走现有 availability 行为，不强制全局配置。

`retryOfRunId` 校验：

- 来源存在；
- `projectId`、`terminalSessionId` 与请求一致；
- 来源状态为 `failed`；
- 新 Run 只复制 runtime snapshot，不复用旧 worker/pane/dispatch 身份。

### 任务 5：把 worker 和恢复链统一切到角色终端

修改以下调用点，禁止在 worker 路径直接使用 `run.terminal`：

- `backend/src/agent-team/service-execution.ts`
  - `applySplit` 创建 pane cwd 继续取 session；
  - 首个 worker 启动、bounce 回派按 `activeWorker.role` 解析 terminal；
  - Evolution Memory 的 provider 记录实际 worker Provider。
- `backend/src/agent-team/service-serial-dispatch.ts`
  - 普通串行派发按目标 role 解析。
- `backend/src/agent-team/service-completion-recheck.ts`
  - recheck 使用 recheck worker role。
- `backend/src/agent-team/service-repair-protocol.ts`
  - 协议补交使用目标 worker role。
- `backend/src/agent-team/service-framework-repair.ts`
  - continue 使用当前目标 role；
  - rerun successor 深拷贝 `roleRuntimes`，旧 Run 则生成 `legacy_terminal` 快照。
- `backend/src/agent-team/service-worker-dispatch-support.ts`
  - 保留现有 provider/thread identity 检查；
  - resume 继续在快照 args 后追加 `resume <threadId>`，禁止因 Provider 不同新开 thread。
- `backend/src/agent-team/service-run-policy.ts`
  - synthetic completion 的 commandName 仍读 main 投影；
  - 新增 role terminal helper 或改由 `model-runtime.ts` 唯一提供。

保留以下 `run.terminal` 使用：

- main completion/source 投影；
- 历史 Run fallback；
- export/project cwd fallback；
- 旧 API 显式 terminal Run。

完成后用 `rg "run\\.terminal" backend/src/agent-team` 逐项审计，每个剩余调用必须属于上述保留清单。

### 任务 6：补 targeted verifier

新增：

- `scripts/verify-agent-team-model-config.mjs`
- root `package.json` script：`agent-team:verify-model-config`

Verifier 使用隔离临时目录和临时 PATH shim，不读取或覆盖用户真实配置，至少断言：

1. Codex / TraeX catalog 白名单归一化；
2. fresh 成功覆盖缓存；
3. CLI 存在但 catalog 失败回旧缓存；
4. CLI 缺失不使用旧缓存启动；
5. 四角色结构校验和 Fast/Max/reasoning 参数编译；
6. 全局新 Run、retry snapshot、legacy terminal 三种来源优先级；
7. model 错误发生时没有 Run/pane/checkpoint 副作用；
8. framework successor 和 role dispatch 使用来源快照。

该脚本是仓库现有模式的集成 verifier，不新增 `*.test.*`、Vitest 或 Node test。

## 8. Frontend 实施步骤

### 任务 7：建立可跨组件打开的 overlay state

修改 `frontend/src/features/terminal/workspace-store.ts`：

- 增加 `agentTeamModelConfigOpen: boolean`；
- 增加 `setAgentTeamModelConfigOpen`；
- `resetForConnection` 必须关闭 Dialog，防止连接切换后把 A 的草稿保存到 B。

修改 `frontend/src/components/terminal/terminal-workspace-header.tsx`：

- 在非 mobile 的 More menu 底部加分隔线和入口；
- 点击只调用 workspace store 打开 Dialog；
- 不依赖 active Project 或 active Terminal。

### 任务 8：实现配置 Dialog

新增 `frontend/src/components/terminal/terminal-agent-team-model-config-dialog.tsx`，挂载到 `terminal-workspace-overlays.tsx`。

组件状态：

- `loading/error/settings`：每次打开从当前 `apiBase/token` 读取；
- `draftRoles`：打开时从已保存 config 深拷贝；没有 config 时四角色模型均为空；
- `selectedRole`：只控制编辑页；
- `modelSearch` 与 `advancedOpenByRole`：纯 UI 草稿；
- `saving`：防重复提交。

交互要求：

- 使用现有 `Dialog`、Button 和项目 Tailwind 风格；不要复制原型 HTML/CSS。
- handlers 使用 `useMemoizedFn`，不静默引入 `useCallback`。
- 关闭/取消不调用 PUT；保存成功后用响应替换已保存值并关闭。
- Provider `availability=unavailable` 时禁用 segment；已有草稿指向 unavailable Provider 时保留可见错误但禁止保存。
- 没有 config 时不填充任何 catalog 第一项。
- 角色摘要显示 `CLI · 模型 · reasoning`，模型为空时显示 `请选择模型`。
- 不渲染连接地址、Project/Run scope、复制按钮、输出详细度或 prototype helper。

### 任务 9：缺配置时提供导航，不自动启动

修改：

- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`
- 必要时小范围修改 `terminal-agent-team-panel-sections.tsx`

行为：

- `startFlow` 的 POST 继续不传 `terminal`。
- `retryingRunId` 非空时传 `retryOfRunId`，成功后清空。
- `runAction` 捕获 `HttpError.details.code`：
  - model config 相关错误保留精确文案；
  - 显示 `去配置`，点击打开同一个 Workspace Dialog；
  - 不保存待启动请求，Dialog 保存后不自动调用 `startFlow`。
- 不在 executing section 或 header summary 增加 runtime 展示。

## 9. 文档与索引

实现完成时更新：

- `docs/architecture/multi-agent-orchestrator.md`
  - 当前连接级配置作用域；
  - role runtime snapshot；
  - catalog/cache 降级；
  - legacy `terminal` fallback。
- `docs/testing/agent-team/README.md`
  - 保留本计划已新增的“模型配置”分类与 Case 数。
- `docs/prototypes/agent-team-role-model-config/README.md`
  - 原型继续作为冻结交互，不把真实 API 状态或 verifier 控件画入页面。

不需要修改 `docs/cli/agent-team-cli.md`：当前 `rw agent-team` 没有创建 Run 或编辑模型设置的命令，export 已通过 `run` 自动携带快照。

## 10. 安全、兼容、迁移与回滚

### 安全

- 设置 API 复用现有 Bearer 鉴权。
- 用户只能提交结构化 Provider/model/参数，不能提交命令或 args。
- Backend 必须重新校验 catalog 与 capability，不能信任前端禁用态。
- CLI 探测使用固定 `execFile` 参数，无 shell 拼接。
- 真正启动仍走 `prepareTerminalAgent` 的逐参数 `shellQuote`。
- raw CLI 输出、config 文件、环境变量、token 和完整 instructions 不落缓存、不返回前端、不写日志。

### 历史兼容

- `roleRuntimes` 为 optional；历史 JSON 无需迁移。
- 旧 Run 的所有角色继续 fallback 到原 `run.terminal`。
- 旧 API 显式 `terminal` 保留；验证脚本无需一次性全部改造。
- 新 Workspace Run 不传 `terminal`，因此不会绕过全局设置。
- `AgentTeamExportResponse.run` 自动携带新字段，旧导出消费者忽略未知 optional 字段。

### 配置损坏

- config schema 非法时按“未配置”处理并返回 `config_required`，不猜测修复。
- 单个 Provider cache 损坏只失效该 Provider，不删除另一个 Provider cache。
- 不自动删除损坏文件；下一次成功保存以 schemaVersion 1 的合法数据覆盖。

### 回滚

- 回滚前无需改历史 Run；新增 optional 字段可被旧代码忽略。
- 如果回滚到只认识单 terminal 的版本，新 Run 的 `run.terminal` 已保存 main 投影，至少可读取和导出。
- 回滚会失去 worker 角色差异，不能在含混合 Provider 的 active Run 中热回滚；先等待或停止这些 Run。
- 全局设置文件可保留，旧版本不会读取；不要在回滚脚本中删除用户配置。

## 11. 验证顺序

### 11.1 静态与集成门禁

```bash
pnpm testplan:validate docs/testing/agent-team/configuration/agent-team-role-model-config.testplan.yaml
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm agent-team:verify-model-config
pnpm agent-team:verify-control-plane
pnpm agent-team:verify-review-checkpoints
git diff --check
```

失败判断：

- shared/backend/frontend 任一类型或 lint 失败；
- verifier 不能证明 cache 判定、显式 off 参数、三种 runtime 来源或无副作用预检；
- `rg "run\\.terminal"` 仍存在未解释的 worker 调度读取；
- testplan schema 或 ID 连续性失败。

### 11.2 真实行为验收

按 `AGT-MC-001`～`AGT-MC-013` 执行：

1. 使用 `$toolkit:runweave-dev-session` 对只包含本次 patch 的 source root 执行 dry-run、启动和 surface 解析；
2. Electron Workspace 验收从 `pnpm dev:open --surface desktop --json` 取得 CDP；
3. 使用 `$toolkit:playwright-cli attach --cdp=<desktop endpoint>`，验证 More → Dialog、草稿/保存和“去配置”；
4. 使用当前真实 `codex debug models`、`traex models --json`、`traex debug models` 选择账号实际可用模型；
5. 创建真实混合 Provider Run，核对 Run JSON、pane metadata、thread provider、启动命令和 pane-scoped outbox；
6. 修改全局配置后触发 resume、recheck、repair、UI Retry 和 framework rerun，逐条证明仍用来源快照；
7. 验收结束关闭本次新建 tab、detach，并通过 `dev:stop` 清理 Dev Session。

禁止用原型截图、typecheck、静态代码阅读或 adapter shim 冒充真实混合 Provider 行为通过。

## 12. 最终验收清单

- [ ] 当前连接只有一份全局四角色配置，Project 切换和 Backend 重启不丢失。
- [ ] More menu 是唯一常驻入口，Dialog 与冻结原型一致。
- [ ] 右侧 Agent Team 面板没有配置控件或 runtime 摘要。
- [ ] CLI 切换清空模型，四角色不完整时不能保存。
- [ ] fresh/cache/none 和 CLI 硬缺失严格遵守判定表。
- [ ] Codex / TraeX 参数只由 Backend adapter 编译，on/off 都覆盖 ambient config。
- [ ] 新 Workspace Run 在所有副作用前完成 config/model/main pane 预检。
- [ ] Run 快照包含 main/code/code_review/behavior_verify 四个角色。
- [ ] 所有 worker 调度与恢复按 role 读取快照。
- [ ] UI Retry 与 framework successor 继承来源快照。
- [ ] 历史 Run 和显式 `terminal` API 继续可用。
- [ ] Run API/export 保留快照，但右侧 UI 不展示。
- [ ] 13 条 YAML Case 格式有效并取得真实行为 verdict。
