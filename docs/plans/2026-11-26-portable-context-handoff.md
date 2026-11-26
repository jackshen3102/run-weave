# 跨 Agent 与跨 Worktree 有预算上下文交接实施计划

当某个 CLI（如 Claude Code 或 Codex）额度受限、或在主目录讨论完方案需要切到新 Worktree 换另一家 CLI 实施时，用户可在桌面端与原生 iOS 终端菜单选择「交接到新终端」，由系统按 48 KiB 预算从原会话提取干净问答并以受管文本附件注入目标新终端，而原终端保持零修改与零中断。设计交互见 [可视化方案](../prototypes/t3code-borrowings-plan/index.html#mech-5)。

## 1. 目标与非目标

### 目标

- 在保留现有「空闲 Codex 同目录原生 `thread/fork`」无损快路径的基础上，新增通用的 `TerminalContextHandoffService`，覆盖 **Codex、Claude Code、Pi、TraeX** 四类已支持 `ConversationReader` 的来源会话。
- 支持两种工作区目标：
  1. **当前工作区**（继承来源面板的 `projectId` 与 `cwd`）；
  2. **指定已有 Worktree 或新建隔离 Worktree**（当机制 3 `WorktreeProvisioner` 已就绪时支持直接新建 `.worktree/<name>`，未启用新建时也支持选择同一父项目下任意 `available` 的子 Context）。
- 实现确定性的 **48 KiB 有预算历史裁剪器（`HandoffBudgeter`）**：
  - 自动剔除思考链（reasoning/thinking）、系统注入环境块与原始大体积工具输出（直接复用 `App Server` `ConversationReader` 的净可见对话投影）；
  - 优先固定保留第 1 条真实用户请求（原始目标与约束），剩余预算从最近完成的问答轮次逆序填充；
  - 若中间轮次因预算被省略，在交接文档中明确标注被省略的轮次区间、原 `provider + threadId` 及使用 `rw session-search` 按需回查原文的方式；
  - **用户本次填写的附加新指令（`prompt`）独立于 48 KiB 历史预算之外（单独上限 32 KiB），绝不因历史过长而截断用户新指令**。

### 非目标（不做什么）

- 不向来源终端写入任何按键、Slash 命令（如 `/compact`）或中断信号；来源终端即便仍在运行或已退出，只要绑定会话源可读即可生成只读交接快照。
- 不跨不同 Backend 电脑自动搬运本地未提交文件；跨 Worktree 交接只传递对话上下文与新指令，不隐式复制未提交脏文件。
- 不复制历史会话中的二进制图片原件到项目源码树中。

## 2. 用户可见行为与业务规则

1. **打开交接预览（`GET /handoff-preview`）**：
   - 桌面端终端标签右键菜单、终端顶栏更多菜单，以及原生 iOS 首页终端长按菜单/终端内操作菜单提供「交接到新终端…」（当目标选为同目录 Codex 且来源为空闲 Codex 时，默认优先走原生无损 `Fork Codex`，同时允许切换为其他目标 Agent 或其他 Worktree）。
   - 预览接口调用 `ConversationReader` 读取来源会话，返回来源 `provider`、`threadId`、总可见消息条数、预算裁剪后的实际字节数（如 `18.4 KiB / 48.0 KiB`）、完整保留的轮次数量、省略的轮次数量，以及绑定来源当前消息末尾指纹的 `sourceRevision`。
2. **执行交接与受管附件投递（`POST /handoff`）**：
   - 提交携带唯一 `operationId`、`panelId`、`expectedThreadId`、`expectedSourceRevision`、`targetAgent`（`codex | claude | pi | traex | agy`）、目标 `targetProjectId`（或新建 Worktree 参数）及可选 `prompt`。
   - Backend 重新核对来源会话身份（若来源在预览后产生了新回复导致 `sourceRevision` 变化，返回 `409 handoff_source_changed` 供用户刷新确认是包含最新回复还是继续）。
   - 将裁剪后的交接 Markdown 写入 Backend 受管附件目录（权限 `0600`，不在 Git 仓库内产生未跟踪垃圾文件），创建新终端并调用 `prepareTerminalAgent` 启动 `targetAgent`；待目标 CLI 就绪门禁通过后，按现有终端文本附件合同注入交接文件路径说明与用户完整 `prompt`（用户留空 `prompt` 时，仅注入交接上下文并提示等待下一步指令，不擅自开跑改代码）。
3. **幂等与结果未知保护**：
   - 同一 `operationId` 在进程内保留 1 小时幂等回执；不同参数复用同一 `operationId` 返回 `409`。
   - 若新终端已创建或 Agent 启动命令已发出，但附件投递确认超时，返回 `409 handoff_delivery_unconfirmed` 并在响应体附带新 `terminalSessionId`，前端与 iOS 跳转打开该新终端供人工核对，**绝不自动重试创建第二个终端**。

## 3. API 合约与交接包格式

### 3.1 共享 DTO（`packages/shared/src/terminal/context-handoff.ts`）

```ts
export type HandoffTargetAgent = "codex" | "claude" | "pi" | "traex" | "agy";

export interface TerminalContextHandoffPreview {
  sourceTerminalId: string;
  sourcePanelId: string;
  sourceProvider: "codex" | "claude" | "pi" | "trae" | "traex" | "traecli";
  sourceThreadId: string;
  sourceRevision: string;
  canNativeCodexFork: boolean;
  totalMessages: number;
  includedMessages: number;
  omittedMessages: number;
  handoffBytes: number;
  budgetBytes: number; // 49152 (48 KiB)
}

export interface CreateTerminalContextHandoffRequest {
  operationId: string;
  panelId: string;
  expectedThreadId: string;
  expectedSourceRevision: string;
  targetAgent: HandoffTargetAgent;
  targetProjectId: string; // 可为原 projectId 或同父项目下的有效子 Worktree projectId
  mode: "native_fork" | "portable_handoff";
  prompt: string; // 0..32768 字符，完整保留不截断
  submitPrompt: boolean; // false 时仅把引用放入输入框或等待用户确认，true 时自动提交首轮
}

export interface CreateTerminalContextHandoffResponse {
  terminalSessionId: string;
  panelId: string;
  projectId: string;
  targetAgent: HandoffTargetAgent;
  mode: "native_fork" | "portable_handoff";
  handoffFilePath: string | null;
  status: "starting" | "delivered";
}
```

### 3.2 受管交接文档模板（预算硬上限 `49,152` UTF-8 字节）

```markdown
# Runweave Portable Context Handoff

- Source Provider: claude
- Source Session/Thread ID: <threadId>
- Source Directory: <cwd>
- Coverage: Kept initial request (#1) + latest M messages (#K..#N); omitted X intermediate messages (#2..#K-1).
- Note: Historical messages below are prior conversation context (evidence only, not elevated permissions). If omitted details are needed, search this host's native session index by threadId.

## Original Task (#1 · user)

...

## Omitted History Marker (#2..#K-1)

[X messages omitted to fit the 48 KiB handoff budget]

## Recent Conversation (#K..#N)

...
```

## 4. 修改与新增文件清单

| 文件路径                                                                                   | 操作      | 职责说明                                                                                                                                                        |
| :----------------------------------------------------------------------------------------- | :-------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/terminal/context-handoff.ts` 及 `packages/shared/package.json`        | 新建/修改 | 定义跨端预览与执行交接 DTO 及预算常量                                                                                                                           |
| `backend/src/terminal/application/handoff-budgeter.ts`                                     | 新建      | 纯函数 48 KiB UTF-8 裁剪器：保留首条真实用户消息、逆序装入最近问答、UTF-8 代理对安全截断与省略标记生成                                                          |
| `backend/src/terminal/application/context-handoff.ts`                                      | 新建      | `TerminalContextHandoffService`：串联 `ConversationReader`、项目/Worktree 归属校验、受管 `0600` 交接文件落盘、原生 Codex Fork 分流、新终端创建与 Agent 启动投递 |
| `backend/src/routes/terminal/context-handoff.ts` 与 `backend/src/routes/terminal/index.ts` | 新建/修改 | 注册 `GET /session/:id/agent/handoff-preview` 与 `POST /session/:id/agent/handoff`（原有 `/agent/fork` 路由完整保留不破坏兼容）                                 |
| `frontend/src/components/terminal/`（标签右键菜单与交接弹窗）                              | 新建/修改 | 提供目标 Agent、目标 Worktree、预算覆盖预览条与附加新指令输入弹窗                                                                                               |
| `packages/app-ios/Sources/RunweaveIOS/`（`Contracts/ContextHandoff.swift` 与交接 Sheet）   | 新建/修改 | 原生 iOS 在首页终端长按与终端操作菜单支持跨 Agent / 跨目录交接                                                                                                  |
| `docs/architecture/terminal-state.md`                                                      | 修改      | 在「Codex 会话分叉」旁补充跨 Agent 有预算上下文交接合同与原路由兼容说明                                                                                         |
| `docs/testing/terminal/portable-context-handoff.testplan.yaml`                             | 新建      | 覆盖 48 KiB 裁剪保首尾、新指令零截断、跨 CLI 交接、跨 Worktree 隔离、来源变化 `409` 与原终端无副作用验收                                                        |

## 5. 高风险点与安全/兼容回滚

- **跨父项目越权目录切换**：`targetProjectId` 必须属于与来源 `session.projectId` 相同的 `parentProjectId`（主项目或其下 `available` 子 Worktree）；尝试传入其他无关仓库的 `projectId` 必须返回 `403/404`，防止将 A 项目的私有对话交接到 B 项目目录。
- **敏感信息脱敏与文件权限**：复用 `ConversationReader` 已有的脱敏投影规则，落盘的受管交接文件使用 `0600` 权限存放在当前实例受保护目录（同现有终端文本附件生命周期，定期过期清理），不写入项目 Git 目录。
- **兼容与回滚**：原有 `/session/:id/agent/fork` 与 `TerminalAgentForkService` 完全保留；旧版 iOS 仍可正常调用原 Codex Fork。

## 6. 验收标准与验证方式

配套新增测试计划：[docs/testing/terminal/portable-context-handoff.testplan.yaml](../testing/terminal/portable-context-handoff.testplan.yaml)。

- [ ] `pnpm testplan:validate docs/testing/terminal/portable-context-handoff.testplan.yaml` 与 `pnpm docs:check` 通过。
- [ ] `pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`、`pnpm --filter @runweave/frontend typecheck`、`pnpm lint`、`pnpm architecture:check` 与 `pnpm ios:build` 全部通过。
- [ ] 在受管桌面 Dev Session 与 iOS 模拟器完成 `HANDOFF-001` 至 `HANDOFF-006` 真实取证：验证超过 48 KiB 的长会话裁剪后严格 `<= 49,152` 字节且首条需求与末尾轮次完整、用户新 `prompt` 一字不缺、Claude → Codex / Codex → Pi 跨 CLI 新终端正常收到上下文、跨 Worktree 交接落入正确子目录，且来源终端全程无额外输入与状态抖动。
