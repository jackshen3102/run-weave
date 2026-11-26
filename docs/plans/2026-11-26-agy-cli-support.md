# Antigravity CLI (`agy`) 全链路集成实施计划

开发者与 Agent 在 Runweave（Web、Electron、iOS、CLI、MCP 与后台任务）中像使用 Codex、Claude、TraeX、Pi 一样启动、交互、恢复、检索、竞速和自动化运行 `agy`（Google Antigravity CLI），并具备完整的进程/会话身份隔离与原生证据校验。

## 1. 目标与非目标

### 目标（全量范围）

1. **统一身份与配置能力底座**：
   - 新增 canonical provider 标识 `"agy"`，接入 `TerminalAgentKind`、`AgentCapabilityProvider`、`AppServerAgentKind`、`SessionSearchProvider`、`DailyProvider`、`AgentModelProvider`、`RaceAgent` 与后台任务/自进化 provider。
   - 新增实例级配置 `agents.agy.binary` 与 `agents.agy.configDirectory`（外部引用 `~/.gemini/antigravity-cli`，不复制凭据），接入 `/api/agent-capabilities` 版本与可用性探测。
2. **Hook Bridge、主进程代次校验与 Toolkit 插件分发**：
   - 适配 `agy` 的命名分组 `hooks.json` 格式（`SessionStart`、`PreInvocation`、`PostInvocation`、`PreToolUse`、`PostToolUse`、`Stop`）及**同步 JSON stdout 输出合同**（避免阻塞或报错中断 `agy` 主循环）。
   - 实现 `runweave-hook-agy.cjs` 主进程 PID + 启动时间代次校验，过滤 `invoke_subagent` / `/swarm` 子会话与非 `fullyIdle` / 非正常结束的 `Stop` 事件。
   - 在 `electron/src/hooks/hook-installer.ts` 与 `pnpm toolkit:sync` / `pnpm agents:build` 中支持 `agy` 全局 Hook（`~/.gemini/config/hooks.json`）与 Toolkit 插件安装。
3. **终端生命周期、跨端输入、受管启动与精确恢复**：
   - 前台命令 `agy` 识别、`TerminalState`（`agent_starting` / `agent_idle` / `agent_running`）推进、终端 Tab 名称 `xxx(agy)`、小绿点与桌面/飞书完成通知。
   - Web Floating Composer 与 iOS 输入通道适配、`rw` 与 Backend 的 `prepare`（`agy -i <prompt>`）和精确 `resume` / `recover`（`agy --resume <conversation-id>`，校验真实 transcript 存在且会话身份匹配）。
4. **原生会话阅读、会话搜索（Session Search）与日报采集（Daily Record）**：
   - App Server 新增 `AgySessionReader` 与 `AgyConversationReader`，读取 `<configDirectory>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`（及按需关联 `transcript_full.jsonl`）并在 Web/iOS 展示对话正文。
   - 持久化 `agy` 会话的工作区归属元数据（Hook 写入 `<configDirectory>/brain/<conversation-id>/.runweave-session-meta.json` 或 App Server 索引），使 `packages/agent-history-node`（`session-search`）与 `packages/daily-record` 能精确关联 `cwd` / `repositoryId` 并解析用户、助手与工具记录。
5. **模型目录、实时模型设置（Live Settings）、Race 竞速与后台自动化**：
   - `AgentModelCatalogService` 新增 `probeAgyCatalog`（解析 `agy models` 与支持的 `--effort low|medium|high|xhigh|max`）。
   - `TerminalAgentSettings` 支持在运行中的 `agy` TUI 通过 `/model` 或原生设置在 iOS/Web 切换模型与推理强度并读回确认。
   - Race 竞速支持选择 `agy` worker（`agy --model <model> --effort <effort> -i <goal>`）。
   - 定时任务与快捷指令后台运行（`ScheduledTasks`）、任务控制与自进化（`Evolution`）新增 `agy` 执行器（基于 `agy -p --output-format json|stream-json --json-schema <path>` 与 `--resume <conversation-id>`）。

### 非目标（不做什么）

- 不更改现有默认 provider（默认 provider 仍为 `codex`，不把已有项目或定时任务静默切换到 `agy`）。
- 不读取、拷贝或托管 `~/.gemini/antigravity-cli` 中的 Google 账号 OAuth 凭据。
- 不将 Codex 的 `:minimal` 或沙箱策略机械映射为 `agy --dangerously-skip-permissions`；`agy` 后台执行策略必须显式校验 `--sandbox` 或 `--mode`。
- 不在没有原生分叉保证的情况下伪造内存级 `sideChat`；若 `agy` 当前版本不支持独立只读 `thread/fork`，`/api/agent-capabilities` 中 `agy` 的 `fork` / `sideChat` 明确报告 `unsupported` 或按实际验证结果开放。

---

## 2. 架构与核心技术设计

### 2.1 `agy` 原生接口与目录事实

| 维度               | `agy` (1.5.17) 原生事实                                                                                                                                                                  | Runweave 适配设计                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 配置与数据根       | `~/.gemini/antigravity-cli`（日志与会话在 `brain/<uuid>/.system_generated/logs/transcript.jsonl`，设置在 `settings.json`）；全局自定义根为 `~/.gemini/config`                            | `agents.agy.configDirectory` 默认指向 `~/.gemini/antigravity-cli`；Hook 安装器同时支持 `~/.gemini/config/hooks.json`                                                                                                                                                                                                                      |
| Hook 配置结构      | 顶层为自定义 hook 名：`{ "runweave": { "enabled": true, "SessionStart": [...], "PreInvocation": [...], "PostToolUse": [...], "Stop": [...] } }`                                          | `hook-installer-config.ts` 新增 `mergeAgyHooksJson`，只维护顶层 `"runweave"` 命名块，完全保留用户其他命名块                                                                                                                                                                                                                               |
| Hook 输入 (stdin)  | camelCase JSON：`{ conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName, lastUserInput, hookEventName, cwd, ... }`                                           | `runweave-hook-payload.cjs` 兼容 `conversationId` -> `threadId`、`transcriptPath` -> 摘要提取、`lastUserInput` -> `query`                                                                                                                                                                                                                 |
| Hook 输出 (stdout) | **同步阻塞且必须输出 JSON**：`PreToolUse` 需 `{"decision":"allow"}`；`PostToolUse` / `SessionStart` / `PreInvocation` / `PostInvocation` / `Stop` 默认输出 `{}`                          | `runweave-hook-bridge.cjs` 识别 `source === "agy"` 时，在退出前向 stdout 写出对应合法 JSON（即使内部网络请求失败也输出放行 JSON，绝不阻塞 `agy`）                                                                                                                                                                                         |
| 生命周期映射       | `SessionStart`（新会话启动）、`PreInvocation`（每轮模型调用前，含用户提问后首次调用及工具返回后继续调用）、`PreToolUse` / `PostToolUse`、`Stop`（带 `terminationReason` 与 `fullyIdle`） | 主进程 `agy` 的 `SessionStart` -> `agent_idle`；`PreInvocation` / `PreToolUse` / `PostToolUse` -> `agent_running`；`Stop`（当 `terminationReason === "NO_TOOL_CALL"` 且 `fullyIdle !== false`）-> `agent_idle` + Completion 通知；`terminationReason === "ERROR"` 或 `"USER_CANCELED"` -> `agent_idle`（记录失败/中断，不发成功完成通知） |
| 启动与恢复命令     | 交互启动带初始提示词：`agy -i <prompt>`；恢复：`agy --resume <conversationId>`；非交互：`agy -p <prompt> --output-format json --json-schema <file>`                                      | `buildAgentResumeArgs("agy", id)` 返回 `["--resume", id]`；`prepareTerminalAgent` 对 `agy` 使用 `-i <prompt>`（当存在 initial prompt 且非仅 resume 时）                                                                                                                                                                                   |

### 2.2 子 Agent 隔离与主进程代次校验 (`AgyAgentContext`)

`agy` 支持 `invoke_subagent` 和 `/swarm`。子 Agent 执行时同样会触发 `PreInvocation`、`PreToolUse`、`Stop`，但其 `conversationId` 是子会话 ID。为防止子 Agent 的 `Stop` 提前把主终端置为 `agent_idle` 或触发虚假完成通知：

1. **进程代次提取（`packages/agent-bridge/hooks/runweave-hook-agy.cjs`）**：
   - 沿用 `runweave-hook-claude.cjs` 的进程树回溯方案，从 `process.ppid` 向上查找当前 Pane 下的主 `agy` 进程 PID 与启动时间 `startedAt`，生成 `instanceId = "${agyPid}:${startedAt}"`。
   - 若进程树中存在多层 `agy`（嵌套 CLI 调用），直接拒绝上报。
2. **主会话锁定**：
   - 同一 `instanceId` 首次通过 `SessionStart`（或恢复后的首个 `PreInvocation`）绑定主 `conversationId`。
   - 同一 `instanceId` 后续若收到不同 `conversationId` 的事件（且非用户显式切换会话的 `SessionStart`），识别为子 Agent 活动：不覆盖主会话 `threadId`，其 `Stop` 事件直接忽略。
3. **工作区元数据落盘**：
   - `transcript.jsonl` 本身每行不含 `cwd`。当 `runweave-hook-bridge` 收到 `agy` Hook 且携带 `transcriptPath` 与 `cwd` / `workspacePaths` 时，在 `path.dirname(transcriptPath)`（或 `<brain>/<conversationId>/`）下原子写入 `.runweave-agy-meta.json`（含 `conversationId`、`cwd`、`workspacePaths`、`modelName`、`updatedAt`），供 App Server、`session-search` 和 `daily-record` 可靠读取项目归属。

### 2.3 原生 Transcript 解析规范

`agy` 的 `transcript.jsonl` 每行结构如下：

- **用户输入**：`source === "USER_EXPLICIT"` 且 `type === "USER_INPUT"`，`content` 包含 `<USER_REQUEST>\n...\n</USER_REQUEST>` 包裹的用户原文（或纯文本）。解析器需剥离 `<USER_REQUEST>`、`<ADDITIONAL_METADATA>`、`<USER_SETTINGS_CHANGE>` 等系统包装标签，提取真实用户文本。
- **模型回复与工具调用**：`source === "MODEL"` 且 `type === "PLANNER_RESPONSE"`，`content` 为助手可见回复文本，`tool_calls` 数组为 `[{ name, args }]`。
- **工具结果**：`source === "MODEL"` 且 `type === "GENERIC"`，对应紧随其后的工具执行输出。当行内含 `truncated_fields: ["content"]` 时，详情读取可按相同行号从同目录 `transcript_full.jsonl` 读取完整内容。
- **系统注入**：`source === "SYSTEM"` 且 `type === "SYSTEM_MESSAGE"`，标记为 `context` 并从对话正文中排除。

---

## 3. 分阶段实施任务清单（L2/L3）

### 阶段一：共享合同与配置底座（`packages/shared` & `packages/config-node`）

- [ ] **1.1 扩展跨运行时 Agent 枚举与上下文类型**
  - 修改 `packages/shared/src/terminal/runtime/state.ts`：
    ```ts
    export type TerminalAgentKind =
      | "codex"
      | "claude"
      | "trae"
      | "traex"
      | "pi"
      | "traecli"
      | "agy";
    ```
  - 新增 `packages/shared/src/terminal/agy-agent.ts`（并从 `packages/shared/package.json` 导出 `@runweave/shared/terminal/agy-agent`）：
    - 定义 `AgyAgentContext`（`version: 1`、`conversationId`、`instanceId`、`startedAt`、`observedAt`、`eventId`、`event`、`terminationReason?`、`fullyIdle?`、`modelName?`、`transcriptPath?`）。
    - 实现 `isAgyAgentContext`、`isNewerAgyContext`、`agyHookStatus`。
  - 修改 `packages/shared/src/agent-capabilities.ts`：`AgentCapabilityProvider` 自动包含 `"agy"`。
  - 修改 `packages/shared/src/terminal/agent-resume.ts`：
    ```ts
    const resumeFlags: Record<string, string> = {
      pi: "--session",
      claude: "--resume",
      agy: "--resume",
    };
    ```
  - 修改 `packages/shared/src/terminal/runtime/agent-preparation.ts`：
    ```ts
    export type TerminalAgentPreparationAgent =
      | "codex"
      | "traex"
      | "pi"
      | "agy";
    ```
  - 修改 `packages/shared/src/app-server/events.ts`、`packages/shared/src/terminal/panel.ts`、`packages/shared/src/terminal/runtime/completion.ts`、`packages/shared/src/terminal/runtime/events.ts`：将 `"agy"` 与可选 `agy?: AgyAgentContext` 加入 union 和 DTO。
  - 修改 `packages/shared/src/session-search.ts`（`SessionSearchProvider` 加入 `"agy"`）、`packages/shared/src/daily-record.ts`（`DailyProvider` 加入 `"agy"`）、`packages/shared/src/agent-model-catalog.ts`（`AgentModelProvider` 加入 `"agy"`）、`packages/shared/src/terminal/agent-settings.ts`（`TerminalAgentSettingsProvider` 加入 `"agy"`）、`packages/shared/src/race/race.ts`（`RaceAgent` 与 `RaceAgentCatalog` 加入 `"agy"`）。

- [ ] **1.2 新增 `agents.agy` 配置域与解析器**
  - 修改 `packages/shared/src/configuration/fields.ts`、`types.ts`、`constraints.ts`、`services.ts`、`compatibility.ts`：
    - `agents.agy.binary`：类型 `string`，默认通过 PATH 查找 `agy`，环境变量 `AGY_BIN` / `RUNWEAVE_AGY_BIN`。
    - `agents.agy.configDirectory`：类型 `string`，默认引用 `~/.gemini/antigravity-cli`，环境变量 `AGY_CONFIG_DIR` / `RUNWEAVE_AGY_CONFIG_DIR`，必须为绝对路径。
  - 新增 `packages/config-node/src/agy.ts`（并在 `packages/config-node/package.json` 导出 `@runweave/config-node/agy`）：
    - 实现 `resolveAgyConfiguration(env)`，返回 `{ binary, configDirectory, brainDirectory: path.join(configDirectory, "brain"), globalCustomizationsDirectory: path.join(path.dirname(configDirectory), "config") }`。
  - 运行 `pnpm configuration:docs` 更新 `docs/cli/configuration-reference.md`。

### 阶段二：Hook Bridge 与桌面/Toolkit 安装器（`packages/agent-bridge` & `electron` & `scripts`）

- [ ] **2.1 实现 `agy` Hook 上下文提取与 stdout 协议**
  - 新增 `packages/agent-bridge/hooks/runweave-hook-agy.cjs`：
    - `readAgyIdentity()`：扫描进程树定位主 `agy` 进程 PID 与 `startedAt`，排除嵌套 `agy` 进程。
    - `readAgyContext(payload, eventId)`：校验 `payload.conversationId`，提取 `hookEventName`、`terminationReason`、`fullyIdle`、`modelName`、`transcriptPath`。
    - `writeAgySessionMeta(payload)`：当 `payload.transcriptPath` 位于 `brain/<conversationId>` 下且 `payload.cwd` 为绝对路径时，将 `{ conversationId, cwd, workspacePaths, modelName, updatedAt }` 写入 `<brain>/<conversationId>/.runweave-agy-meta.json`。
    - `writeAgyHookStdout(normalizedEvent)`：
      - `pretooluse` / `pre_tool_use` -> `process.stdout.write('{"decision":"allow"}\n')`
      - 其余事件（`sessionstart`、`preinvocation`、`postinvocation`、`posttooluse`、`stop`）-> `process.stdout.write('{}\n')`
  - 修改 `packages/agent-bridge/hooks/runweave-hook-payload.cjs`：
    - `normalizeSource` 支持 `"agy"`。
    - `readThreadId` 支持 `payload.conversationId ?? payload.conversation_id`。
    - `extractUserPrompt` 支持 `payload.lastUserInput ?? payload.last_user_input`，并清洗 `<USER_REQUEST>` 标签。
    - `extractToolHook` 兼容 `agy` 的 `payload.toolCall` 结构（`toolCall.id`、`toolCall.name`、`toolCall.args`、`payload.error`）。
    - `toAgentHookStateEvent` 映射：
      - `sessionstart` -> `"SessionStart"`
      - `preinvocation` / `pre_invocation` -> `"UserPromptSubmit"`
      - `pretooluse` -> `"ToolRequested"`
      - `posttooluse` -> `"ToolCompleted"`
      - `stop` -> `"Stop"`
    - `readTranscriptReply` 支持 `payload.transcriptPath`（ camelCase ），并新增对 `agy` transcript 行（`source === "MODEL" && type === "PLANNER_RESPONSE"` 的 `content`）的解析，提取最新助手回复摘要。
  - 修改 `packages/agent-bridge/hooks/runweave-hook-bridge.cjs`：
    - 引入 `runweave-hook-agy.cjs`（并加入 `packages/agent-bridge/src/install-pi.mjs` 的 `bridgeAssets` 清单）。
    - 当 `source === "agy"` 时，无论环境变量是否齐全、是否在 Runweave 终端内，**必须在 `finally` 中调用 `writeAgyHookStdout(normalizedEvent)`**，保证外部终端运行 `agy` 时不会因 Hook 无输出而报错。
    - `Stop` 完成通知判定：对 `source === "agy"`，仅当 `payload.agy` 验证通过、会话 ID 与主会话匹配、`payload.terminationReason === "NO_TOOL_CALL"`（或缺省）且 `payload.fullyIdle !== false` 时，才设置 `shouldRecordCompletion = true` 并发送桌面（标题 `AGY 完成了`）与飞书通知。

- [ ] **2.2 扩展 Hook 安装器与 `pnpm toolkit:sync`**
  - 修改 `electron/src/hooks/hook-installer-config.ts`：
    - 新增 `mergeAgyHooksJson(existing, command)`：按照 `agy` 的 `hooks.json` schema，写入或更新顶层 `"runweave"` 键：
      ```json
      {
        "runweave": {
          "enabled": true,
          "SessionStart": [
            {
              "type": "command",
              "command": "<launcher> --source agy",
              "timeout": 10
            }
          ],
          "PreInvocation": [
            {
              "type": "command",
              "command": "<launcher> --source agy",
              "timeout": 10
            }
          ],
          "PreToolUse": [
            {
              "matcher": "*",
              "hooks": [
                {
                  "type": "command",
                  "command": "<launcher> --source agy",
                  "timeout": 10
                }
              ]
            }
          ],
          "PostToolUse": [
            {
              "matcher": "*",
              "hooks": [
                {
                  "type": "command",
                  "command": "<launcher> --source agy",
                  "timeout": 10
                }
              ]
            }
          ],
          "Stop": [
            {
              "type": "command",
              "command": "<launcher> --source agy",
              "timeout": 30
            }
          ]
        }
      }
      ```
  - 修改 `electron/src/hooks/hook-installer.ts`：
    - 新增 `installAgyHooks(context)`：当 `~/.gemini/antigravity-cli` 或 `~/.gemini/config` 存在时，备份并合并 `~/.gemini/config/hooks.json`；同时将 `runweave-hook-agy.cjs` 复制到 `~/.runweave/bin/`。
  - 修改 `scripts/agents/build.mjs` 与 `scripts/toolkit/sync.mjs`：
    - 分发 `runweave-hook-agy.cjs`；在本机安装了 `agy` 时，同步支持将 `plugins/toolkit` 的 skills 注册到 `~/.gemini/config/skills.json`（保留用户已有条目）。

### 阶段三：终端生命周期、受管启动与精确恢复（`backend` & `frontend` & `packages/runweave-cli` & `packages/app-ios`）

- [ ] **3.1 Backend 终端状态与 Hook 处理**
  - 修改 `backend/src/terminal/state/terminal-state-service.ts`：`AGENT_COMMANDS` 加入 `agy: new Set(["agy"])`。
  - 修改 `backend/src/terminal/completion/source-gate.ts`：`allowedActiveCommandsBySource` 加入 `agy: new Set(["agy"])`。
  - 新增 `backend/src/terminal/application/agy-hook-lifecycle.ts`（对照 `claude-hook-lifecycle.ts`）：
    - 按 session 串行队列校验 `AgyAgentContext` 的 `instanceId`、`startedAt`、`observedAt` 与主 `conversationId`。
    - 拒绝旧代次、乱序或子 Agent `conversationId` 覆盖主 Panel 状态。
  - 修改 `backend/src/terminal/application/agent-hook-processor.ts`、`backend/src/routes/terminal/state.ts`、`backend/src/routes/terminal/completion.ts`、`backend/src/app-server/handlers/agent-lifecycle.ts`：
    - 接入 `"agy"`、`isAgyAgentContext` 与 `recordAgyHookContext`。
    - 对 `agy` 的 `PreInvocation`（映射为 `UserPromptSubmit`），当 `panel.terminalState?.state === "agent_running"` 且属于同一轮内部工具后续调用时，不重复清空草稿或重复触发 `beginTurn`。

- [ ] **3.2 受管启动（Prepare）与精确恢复（Recover / Resume）**
  - 修改 `backend/src/terminal/runtime/agent-adapters.ts`：
    - 新增 `agyAdapter`：
      - `resolveResumeTarget(threadId)`：使用 `resolveAgyConfiguration()` 校验 `<brainDirectory>/<threadId>/.system_generated/logs/transcript.jsonl` 真实存在、非符号链接且 UUID 格式合法；不存在时抛出明确错误，不回退到 `--continue` 或最近会话。
    - `buildAgentResumeCommand` 支持 `thread.provider === "agy"`，读取 `settingText("agents.agy.binary")`。
  - 修改 `backend/src/terminal/application/agent-preparation.ts`：
    - `buildAgentLaunchCommand`：当 `request.agent === "agy"` 且 `!skipInitialPrompt` 且有 `request.prompt` 时，使用 `-i ${shellQuote(request.prompt)}` 传递初始交互提示词（因为 `agy` 的位置参数或 `-p` 分别是子命令或非交互打印模式，交互式初始 prompt 必须传 `-i`）。
  - 修改 `backend/src/terminal/application/agent-recovery.ts` 与 `backend/src/routes/terminal/panels/index.ts`：
    - `prepareTerminalAgentSchema` 允许 `"agy"`。
    - `recoverTerminalAgent` 允许空闲的 `"agy"` 面板按已保存的 `threadId` 精确恢复（`agy --resume <threadId>`）。
  - 修改 `packages/runweave-cli/src/commands/terminal-agent-preparation.ts` 与 `terminal-agent-inference.ts`：
    - 识别 `agy` 命令、`isPreparationAgent` 包含 `"agy"`，默认退出命令支持 `/exit` 或 `/quit`。

- [ ] **3.3 Web 与 iOS 终端交互适配**
  - 修改 `frontend/src/features/terminal/input/floating-composer.ts`：`SUPPORTED_AGENT_COMMANDS` 加入 `"agy"`。
  - 修改 `frontend/src/features/terminal/state/session-name.ts`：`DISPLAY_AGENT_COMMANDS` 加入 `"agy"`，使终端标签显示 `项目名(agy)`。
  - 修改 `packages/app-ios/Sources/RunweaveIOS/State/AppSession+Input.swift` 及相关 Agent 展示映射：识别 `"agy"`。

### 阶段四：App Server 原生会话阅读、Session Search 与 Daily Record

- [ ] **4.1 App Server `AgySessionReader` 与 `AgyConversationReader`**
  - 新增 `app-server/src/agy/session-reader.ts`（对照 `app-server/src/claude/session-reader.ts`）：
    - 仅在 `resolveAgyConfiguration().brainDirectory` 下定位 `<threadId>/.system_generated/logs/transcript.jsonl`（UUID 严格校验，`realpath`、`lstat` 防符号链接越界，单文件 64 MiB 上限）。
    - 读取同目录 `.runweave-agy-meta.json` 校验 `cwd`（若请求携带 `thread.cwd` 且元数据存在但 `cwd` 不匹配，返回 409 `AGY_SESSION_MISMATCH`）。
  - 新增 `app-server/src/agy/conversation-reader.ts`：
    - 解析 `transcript.jsonl`：
      - `source === "USER_EXPLICIT" && type === "USER_INPUT"` -> 开启新 `ConversationTurn`，清洗 `<USER_REQUEST>` 标签后生成 `role: "user"` 消息。
      - `source === "MODEL" && type === "PLANNER_RESPONSE"` -> 提取 `content` 生成 `role: "assistant"` 消息（忽略纯 tool_calls 无文本的空消息，或仅保留可见正文）。
      - 过滤 `source === "SYSTEM"` 及子 Agent 内部消息。
      - 支持追加中的半行容错与 8 MiB 响应预算截断（`partial: true`）。
  - 修改 `app-server/src/agents/conversation-reader.ts`、`app-server/src/state/projector.ts`、`app-server/src/index.ts`：
    - 注册 `AgyConversationReader` 与 `AgyAgentContext` 状态投影。

- [ ] **4.2 会话搜索（`packages/agent-history-node` & `backend/src/session-search`）**
  - 修改 `packages/agent-history-node/src/parser.ts`：
    - 新增 `agyRow(row, state, location)`：
      - 从文件路径 `<brain>/<uuid>/.system_generated/logs/transcript.jsonl` 提取 `threadId = <uuid>`。
      - 解析 `USER_INPUT`（`kind: "user"`，清洗系统包裹标签）、`PLANNER_RESPONSE`（`content` 为 `kind: "assistant"`，`tool_calls` 展开为 `kind: "request"`）、`GENERIC`（工具输出为 `kind: "result"`）。
  - 修改 `backend/src/session-search/scanner.ts`：
    - `nativeSearchRoots` 新增 `{ provider: "agy", path: resolveAgyConfiguration().brainDirectory }`。
    - `discover` 支持定位 `<uuid>/.system_generated/logs/transcript.jsonl`（跳过 `transcript_full.jsonl` 以免重复索引同一条记录），并在 `indexFile` 时读取 `.runweave-agy-meta.json` 补齐 `source.state.cwd`（若无元数据且从首批 `run_command` / 系统信息中解析到 workspace path，则回退提取，确保 `repositoryId` 可解析）。

- [ ] **4.3 日报采集（`packages/daily-record`）**
  - 修改 `packages/daily-record/src/native.ts`：
    - `nativeRoots` 新增 `agy: path.join(home, ".gemini/antigravity-cli/brain")`。
    - `filesIn` 对 `agy` 仅收集 `.system_generated/logs/transcript.jsonl`。
    - 在 `collectNative` 中新增 `provider === "agy"` 分支，读取 `.runweave-agy-meta.json` 获取 `cwd`，将 `USER_INPUT`、`PLANNER_RESPONSE` 和工具调用转为 `DailyMaterial`。

### 阶段五：能力探测、模型目录、实时设置、Race 与后台自动化

- [ ] **5.1 `/api/agent-capabilities` 与模型目录探测（`AgentModelCatalogService`）**
  - 新增 `backend/src/agent-model-catalog/agy.ts`：
    - 执行 `agy --version` 获取版本号。
    - 执行 `agy models`（或解析其可用模型输出；当沙箱或离线受限时使用已验证的缓存/标准目录），结合 `agy --help` 支持的 reasoning effort `["low", "medium", "high", "xhigh", "max"]` 构建 `AgentCatalogModel[]`。
  - 修改 `backend/src/agent-model-catalog/service.ts` 与 `store.ts`：`PROVIDERS` 加入 `"agy"`。
  - 修改 `backend/src/agent-capabilities/service.ts`：
    - `ADAPTERS` 新增 `agy: ["prepare", "conversation", "resume", "attachments", "liveSettings", "background"]`。
    - 实现 `readAgy()`：通过 `resolveAgyConfiguration` 校验 `agy --version` 与配置目录可用性。

- [ ] **5.2 终端实时模型设置（Live Settings）与 Race 竞速**
  - 修改 `backend/src/terminal/runtime/terminal-agent-settings.ts`：
    - `normalizeProvider` 支持 `"agy"`。
    - `readThread` 对 `"agy"` 从当前会话的 `.runweave-agy-meta.json` / `transcript.jsonl` 最新 `PLANNER_RESPONSE.model`（或 `~/.gemini/antigravity-cli/settings.json`）读取当前模型与 effort。
    - `chooseModelAndEffort` 支持在 `agy` TUI 中通过 `/model` 菜单选择目标模型并核对读回结果。
  - 修改 `backend/src/race/race-service.ts`、`backend/src/routes/race.ts`、`frontend/src/components/terminal/race/race-panel.tsx`：
    - `workerSchema` 允许 `agent: z.enum(["codex", "traex", "agy"])`。
    - `modelArgs` 对 `worker.agent === "agy"` 返回 `["--model", model]`。
    - `getAgentCatalog` 返回 `agy` 模型列表，前端 Race 面板支持选择 `AGY` Worker。

- [ ] **5.3 定时任务/快捷指令后台运行（`ScheduledTasks`）与自进化（`Evolution`）**
  - 新增 `backend/src/scheduled-tasks/providers/agy.ts`：
    - 实现 `AgyScheduledTaskProvider`：
      - 使用 `agy -p --output-format stream-json --json-schema <schemaPath>`（续跑时附加 `--resume <resumeThreadId>`，模型参数 `--model <model> --effort <effort>`）。
      - 执行策略映射：`sandbox` -> `["--sandbox"]`；`auto-review` -> `["--mode", "auto"]`；`full-access` -> `["--dangerously-skip-permissions"]`（仅在探测到 CLI 支持对应 flag 时开放）。
      - 从 stream-json 事件或新生成的 transcript 中捕获 `conversationId`（回调 `request.onThread`）和最终结构化 JSON 输出（通过 `parseScheduledResult` 校验业务 schema）。
  - 修改 `backend/src/scheduled-tasks/providers/capabilities.ts`、`frontend/src/features/scheduled-tasks/task-editor.tsx`、`model-settings.tsx`、`packages/app-ios/Sources/RunweaveIOS/Features/ScheduledTasks/ScheduledTaskEditorView.swift`：
    - 探测并暴露 `agy` provider 及其支持的 `executionPolicies` 与 `continuation`。
  - 新增 `backend/src/evolution/providers/agy.ts` 并更新 `backend/src/evolution/providers/availability.ts`、`packages/shared/src/evolution/index.ts`：
    - 支持在自进化分析中使用 `agy -p --sandbox --output-format json --json-schema <path>`。

---

## 4. 文件变更清单

| 模块                                                    | 新增 / 修改文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 职责                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/shared`                                       | `src/terminal/agy-agent.ts` (新增), `src/terminal/runtime/state.ts`, `src/agent-capabilities.ts`, `src/terminal/agent-resume.ts`, `src/terminal/runtime/agent-preparation.ts`, `src/app-server/events.ts`, `src/terminal/panel.ts`, `src/terminal/runtime/completion.ts`, `src/session-search.ts`, `src/daily-record.ts`, `src/agent-model-catalog.ts`, `src/terminal/agent-settings.ts`, `src/race/race.ts`, `src/evolution/index.ts`, `src/configuration/fields.ts` 等                                                                                                                                                                                                                                                                                                                                                                                                                                 | 跨运行时类型定义、`AgyAgentContext` 守卫与配置字段合同                        |
| `packages/config-node`                                  | `src/agy.ts` (新增), `src/validation.ts`, `package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `agents.agy.binary` 与 `agents.agy.configDirectory` 解析与校验                |
| `packages/agent-bridge`                                 | `hooks/runweave-hook-agy.cjs` (新增), `hooks/runweave-hook-payload.cjs`, `hooks/runweave-hook-bridge.cjs`, `hooks/runweave-hook-completion.cjs`, `src/install-pi.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `agy` Hook 进程代次识别、元数据落盘、事件归一化与同步 JSON stdout 响应        |
| `electron` & `scripts`                                  | `electron/src/hooks/hook-installer.ts`, `electron/src/hooks/hook-installer-config.ts`, `scripts/agents/build.mjs`, `scripts/toolkit/sync.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `~/.gemini/config/hooks.json` 受管安装、备份去重与构建同步                    |
| `backend`                                               | `src/terminal/state/terminal-state-service.ts`, `src/terminal/completion/source-gate.ts`, `src/terminal/application/agy-hook-lifecycle.ts` (新增), `src/terminal/application/agent-hook-processor.ts`, `src/terminal/runtime/agent-adapters.ts`, `src/terminal/application/agent-preparation.ts`, `src/terminal/application/agent-recovery.ts`, `src/routes/terminal/state.ts`, `src/routes/terminal/completion.ts`, `src/routes/terminal/panels/index.ts`, `src/agent-capabilities/service.ts`, `src/agent-model-catalog/agy.ts` (新增), `src/agent-model-catalog/service.ts`, `src/terminal/runtime/terminal-agent-settings.ts`, `src/race/race-service.ts`, `src/routes/race.ts`, `src/scheduled-tasks/providers/agy.ts` (新增), `src/scheduled-tasks/providers/capabilities.ts`, `src/session-search/scanner.ts`, `src/evolution/providers/agy.ts` (新增), `src/evolution/providers/availability.ts` | Backend 全链路 `agy` 终端生命周期、恢复、目录、设置、Race、搜索与后台任务支持 |
| `app-server`                                            | `src/agy/session-reader.ts` (新增), `src/agy/conversation-reader.ts` (新增), `src/agents/conversation-reader.ts`, `src/state/projector.ts`, `src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `agy` 原生 `transcript.jsonl` 安全定位、对话投影与状态中心同步                |
| `packages/agent-history-node` & `packages/daily-record` | `packages/agent-history-node/src/parser.ts`, `packages/daily-record/src/native.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `agy` 原生历史行解析与日报素材采集                                            |
| `packages/runweave-cli`                                 | `src/commands/terminal-agent-preparation.ts`, `src/commands/terminal-agent-inference.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `rw` CLI `--agent agy` 启动、推断与控制                                       |
| `frontend` & `packages/app-ios`                         | `frontend/src/features/terminal/input/floating-composer.ts`, `frontend/src/features/terminal/state/session-name.ts`, `frontend/src/components/terminal/race/race-panel.tsx`, `frontend/src/features/scheduled-tasks/*`, `packages/app-ios/Sources/RunweaveIOS/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Web / iOS 浮动输入、标签名、Race 与定时任务 UI 适配                           |
| `docs`                                                  | `docs/architecture/README.md`, `docs/architecture/terminal-state.md`, `docs/architecture/terminal-completion-hooks.md`, `docs/cli/configuration.md`, `docs/cli/session-search.md`, `docs/testing/README.md`, `docs/testing/terminal/runtime/agy-cli.testplan.yaml` (新增)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 架构文档、配置文档与测试计划更新                                              |

---

## 5. 安全、兼容与错误处理边界

1. **绝不阻塞或破坏 `agy` 原生执行**：
   - `agy` 的 command hook 是同步阻塞的，且要求 stdout 为合法 JSON。`runweave-hook-bridge.cjs` 在 `--source agy` 下必须捕获所有异常并始终输出合法 JSON（`PreToolUse` 输出 `{"decision":"allow"}`，其余输出 `{}`），退出码始终为 `0`。
2. **配置文件安全合并**：
   - `~/.gemini/config/hooks.json` 若非合法 JSON，安装器直接跳过并保留原文件字节，绝不覆盖为空对象；首次修改前创建 `~/.gemini/config/hooks.json.runweave-hook-backup`。
3. **文件读取越界防护**：
   - `AgySessionReader` 仅接受严格 UUID 格式的 `threadId`，拼装在 `resolveAgyConfiguration().brainDirectory` 下，并通过 `lstat` + `realpath` 拒绝任何符号链接或目录穿越；不信任客户端在 HTTP 请求中传入的任何任意文件路径。
4. **子 Agent 与未完成停止过滤**：
   - `Stop` 事件只有同时满足：① 进程代次 `instanceId` 为当前 Pane 顶层 `agy` 进程；② `conversationId` 为当前主会话；③ `terminationReason === "NO_TOOL_CALL"` 且 `fullyIdle !== false` 时，才触发完成提醒。`ERROR` 或 `USER_CANCELED` 仅将状态更新回 `agent_idle`，不产生成功完成提醒。

---

## 6. 验收标准与验证方式

### 6.1 自动化与静态门禁命令

在每个阶段完成后依次执行：

```bash
# 1. 生成公共 Hook 与 Agent Bridge 资产并校验
pnpm agents:build
pnpm toolkit:verify-hooks

# 2. 配置字典与文档一致性校验
pnpm configuration:docs
pnpm configuration:check

# 3. 全仓类型检查、代码规范与架构边界校验
pnpm typecheck
pnpm lint
pnpm architecture:check
pnpm docs:check

# 4. 测试计划格式校验
pnpm testplan:validate docs/testing/terminal/runtime/agy-cli.testplan.yaml
```

### 6.2 端到端行为验收计划

完整行为验收用例已配套落盘至：

- [`docs/testing/terminal/runtime/agy-cli.testplan.yaml`](../testing/terminal/runtime/agy-cli.testplan.yaml)

覆盖以下核心验收不变量：

- `AGY-001`：受管 Hook 安装幂等、保留第三方命名块并在损坏配置下保持只读。
- `AGY-002`：Hook Bridge 对 `agy` 各生命周期事件同步返回符合协议的 JSON stdout，外部终端静默放行。
- `AGY-003`：真实 `agy` 请求驱动 Panel `TerminalState`（`agent_starting` -> `agent_running` -> `agent_idle`）与 Tab 名称 `(agy)`。
- `AGY-004`：子 Agent（`invoke_subagent`）与非 `NO_TOOL_CALL` / 非 `fullyIdle` 的 `Stop` 不提前结束主任务或误发完成通知。
- `AGY-005`：`rw` / Backend `prepare`（`agy -i`）与精确 `resume` / `recover`（`agy --resume <id>`）身份校验，缺失会话明确失败且不回退最近会话。
- `AGY-006`：App Server `AgyConversationReader` 正确提取 `<USER_REQUEST>` 用户正文与 `PLANNER_RESPONSE` 助手回复，拒绝越界路径并容忍半行追加。
- `AGY-007`：Web Floating Composer 与 iOS 输入完整投递到当前 `agy` 目标面板。
- `AGY-008`：会话搜索（`session-search`）与日报采集（`daily-record`）能按工作区 `cwd` 检索并采集 `agy` 原生 transcript。
- `AGY-009`：模型目录探测、实时设置、Race 竞速与后台任务执行器（`agy -p --json-schema`）按 schema 返回结构化结果。
