# Runweave 移动端方案一详细设计：项目优先 / 终端卡片

> **For Hermes:** 后续如进入实现，请使用 `subagent-driven-development` 或 TDD 流程按本文任务拆分执行。  
> **目标：** 用户在手机上先选择项目，再通过终端卡片快速判断“哪个终端需要处理”，一键把上下文交给 Hermes/飞书继续执行、监控和汇总。  
> **核心原则：** Runweave 负责“看见与选择终端”，Hermes 负责“理解、执行、监控与汇总”，飞书负责“移动端低摩擦对话入口”。

---

## 0. 关于 GPT Image2 / 图片交付说明

你提到“最重要的是用 GPT 的 Image2 生成更多草稿图、交互图”。当前这个 Hermes 工具环境里没有直接暴露 GPT Image2 的图片生成工具；为了不阻塞交付，我先生成了一组可直接放进飞书文档的本地 PNG 草稿图和 Excalidraw 交互图文件。后续如果接入 Image2，我也在本文末尾给了可直接复制的 Image2 Prompt。

本次新增图片目录：

```text
docs/superpowers/assets/runweave-mobile-hermes-scheme-a-v2/
```

新增 8 张页面/交互草稿：

1. `01-home-project-first.png`：首页 / 项目优先终端卡片
2. `02-project-switch-filter.png`：项目切换与状态筛选
3. `03-terminal-card-anatomy.png`：终端卡片字段结构
4. `04-terminal-detail-drawer.png`：终端详情与底部操作抽屉
5. `05-handoff-preview.png`：发给 Hermes 前的上下文预览
6. `06-state-detection.png`：状态推断逻辑图
7. `07-copy-success-feishu.png`：复制成功与飞书接力
8. `08-user-journey.png`：端到端用户旅程

另有可编辑交互图：

```text
docs/superpowers/assets/runweave-mobile-hermes-scheme-a-v2/scheme-a-flow.excalidraw
```

---

## 1. 选择方案一的产品结论

方案一是 **项目优先 / 终端卡片**。它最适合你的使用场景：

- 你通常先知道自己要操作哪个项目，例如 `run-weave`、`space-v3`、`hermes`。
- 手机上不适合直接输入复杂命令，更适合“找终端 → 判断状态 → 交给 Hermes”。
- 终端数量会越来越多，需要按项目聚合，否则在移动端很难定位。
- Codex / Claude / shell / pnpm 的状态不能只看 `running`，必须用卡片直接表达“是否需要处理”。

### 1.1 一句话体验

> 手机上打开 Runweave，点进 `run-weave`，看到几张终端卡片：黄色卡片代表 Codex 等待输入，蓝色代表正在执行，绿色代表空闲。点黄色卡片的「发给 Hermes」，飞书里补一句“继续推进并跑测试”，Hermes 自动观察、执行、监控并回传结果。

---

## 2. 信息架构

```text
/mobile/terminals
  ├─ 顶部：当前项目 / 搜索 / 筛选
  ├─ 项目切换区
  │   ├─ run-weave
  │   ├─ space-v3
  │   └─ hermes
  ├─ 状态筛选区
  │   ├─ 需要处理
  │   ├─ AI 执行中
  │   ├─ 等待输入
  │   ├─ 空闲
  │   └─ 失败/卡住
  ├─ 终端卡片列表
  │   ├─ Codex · 等待输入
  │   ├─ Codex · 正在执行
  │   ├─ zsh · 空闲
  │   └─ pnpm · 命令执行中
  └─ 终端详情抽屉
      ├─ tail 预览
      ├─ 状态判断依据
      ├─ 复制上下文
      ├─ 发给 Hermes
      └─ 总结终端
```

---

## 3. 页面一：首页 / 项目优先终端卡片

![首页 / 项目优先终端卡片](../assets/runweave-mobile-hermes-scheme-a-v2/01-home-project-first.png)

### 3.1 页面目标

让用户在 10 秒内回答三个问题：

1. 我现在在哪个项目？
2. 哪些终端需要我/Hermes 处理？
3. 下一步应该点哪个按钮？

### 3.2 页面结构

顶部：

- 标题：`Runweave 终端`
- 副标题：`项目优先 / 卡片列表`
- 搜索框：`搜索项目、终端、codex、typecheck`

项目 Tabs：

- `run-weave`
- `space-v3`
- `AI运行中`
- `等待输入`

项目摘要：

```text
run-weave · 5 个终端 · 2 个需要处理
```

终端卡片列表按优先级排序：

1. 需要处理：`agent_waiting_input` / `failed` / `possibly_stuck`
2. 正在执行：`agent_running` / `command_running`
3. 最近活跃
4. 空闲 shell

---

## 4. 页面二：项目切换与状态筛选

![项目切换与状态筛选](../assets/runweave-mobile-hermes-scheme-a-v2/02-project-switch-filter.png)

### 4.1 页面目标

当项目多、终端多时，用户不需要滚动找，而是先用“项目 + 状态”缩小范围。

### 4.2 筛选项

项目筛选：

```text
run-weave / space-v3 / hermes / 全部
```

状态筛选：

```text
需要处理 / AI执行中 / 等待输入 / 空闲 / 失败卡住
```

### 4.3 MVP 默认规则

默认进入页面时：

- 如果上次访问过项目，默认选上次项目。
- 否则默认选最近活跃项目。
- 如果有等待输入的 AI 终端，顶部显示“需要处理”。
- 筛选默认不隐藏空闲终端，但排序靠后。

---

## 5. 页面三：终端卡片字段设计

![终端卡片字段结构](../assets/runweave-mobile-hermes-scheme-a-v2/03-terminal-card-anatomy.png)

### 5.1 卡片必须包含的字段

```ts
interface MobileTerminalCardViewModel {
  terminalSessionId: string;
  shortId: string;
  projectId: string;
  projectName: string;
  cwd: string | null;
  sessionStatus: "running" | "stopped" | "exited";
  foregroundCommand: string | null;
  inferredWorkloadState:
    | "idle_shell"
    | "command_running"
    | "agent_running"
    | "agent_waiting_input"
    | "completed"
    | "failed"
    | "possibly_stuck"
    | "unknown";
  statusLabel: string;
  statusColor: "green" | "blue" | "yellow" | "red" | "gray";
  lastOutputAt: string | null;
  tailChangedRecently: boolean;
  promptDetected: boolean;
  confidence: number;
  stateReason: string[];
  tailPreview: string;
  primaryAction: "send_to_hermes" | "observe" | "run_command" | "summarize";
}
```

### 5.2 卡片视觉规则

| 状态                  | 颜色      | 文案               | 主操作      |
| --------------------- | --------- | ------------------ | ----------- |
| `agent_waiting_input` | 黄色      | `Codex · 等待输入` | 发给 Hermes |
| `agent_running`       | 蓝色      | `Codex · 正在执行` | 观察 / 监控 |
| `command_running`     | 蓝色      | `pnpm · 执行中`    | 监控        |
| `idle_shell`          | 绿色      | `zsh · 空闲`       | 跑命令      |
| `failed`              | 红色      | `失败`             | 总结 / 修复 |
| `possibly_stuck`      | 红色/橙色 | `可能卡住`         | 总结 / 询问 |
| `unknown`             | 灰色      | `未知`             | 先观察      |

### 5.3 卡片按钮

主按钮只保留一个，避免手机上误操作：

- 等待输入：`发给 Hermes`
- 正在执行：`监控`
- 空闲：`跑命令`
- 失败/卡住：`总结终端`

次按钮：

- `详情`
- `复制上下文`

---

## 6. 页面四：终端详情 / 底部抽屉

![终端详情与底部操作抽屉](../assets/runweave-mobile-hermes-scheme-a-v2/04-terminal-detail-drawer.png)

### 6.1 页面目标

在“真正交给 Hermes 前”让用户确认：

- 这个终端是不是目标终端；
- 最近输出是否符合预期；
- 状态判断是否可信；
- 是否应该发送下一步指令。

### 6.2 详情内容

```text
终端 ID: cdcbc9cd-71fd-4555-9436-146451300d56
项目: run-weave
路径: /Users/bytedance/Desktop/vscode/browser-hub/browser-viewer
前台程序: codex
真实状态: Codex · 等待输入
判断依据:
  - tail 末尾检测到 Codex prompt
  - 最近 3 分钟没有新增输出
  - sessionStatus 仍为 running
```

### 6.3 Tail 预览

Tail 默认显示最近 80 行，移动端折叠展示：

- 默认显示最后 12 行；
- 可点“展开最近 80 行”；
- 不在手机上提供复杂编辑；
- 不直接把命令输入框放在首屏，避免误操作。

---

## 7. 页面五：发给 Hermes / 上下文预览

![发给 Hermes 前的上下文预览](../assets/runweave-mobile-hermes-scheme-a-v2/05-handoff-preview.png)

### 7.1 页面目标

用户点击「发给 Hermes」后，不是立刻执行，而是生成一段可粘贴到飞书的上下文草稿。

### 7.2 草稿格式

```text
Hermes，接管这个 Runweave 终端。

项目：run-weave
终端：cdcbc9cd-71fd-4555-9436-146451300d56
状态：Codex · 等待输入
路径：/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer
前台程序：codex
判断依据：检测到 Codex prompt，最近 3 分钟无新增输出

最近输出：
<tail 最近 80 行>

请先读取最新状态。若仍在等待输入，则继续推进；
若正在执行，则继续监控；若状态未知或卡住，先总结并问我。
```

### 7.3 发送方式

MVP：

- `复制并打开飞书`
- `仅复制`

后续增强：

- 直接调用 Hermes Gateway webhook；
- 直接发到当前 Feishu 会话；
- 支持预设动作：`总结终端`、`继续任务`、`跑测试`、`修复失败`。

---

## 8. 页面六：状态判断逻辑

![状态推断逻辑图](../assets/runweave-mobile-hermes-scheme-a-v2/06-state-detection.png)

### 8.1 为什么不能只看 activeCommand

`activeCommand = codex` 只能说明 Codex 在前台，不代表它正在执行。它可能处于：

1. 正在执行工具/命令；
2. 等待用户输入下一条 prompt；
3. 卡住或长时间无输出；
4. 输出很慢但仍在执行。

### 8.2 MVP 推断算法

```ts
function inferTerminalState(input: {
  sessionStatus: string;
  activeCommand?: string | null;
  tail: string;
  lastOutputAt?: string | null;
  tailChangedRecently: boolean;
  now: Date;
}): InferredWorkloadState {
  if (input.sessionStatus !== "running") return "completed";

  const command = input.activeCommand ?? "";
  const isAgent = /codex|claude|opencode|coco/i.test(command);
  const isShell = /zsh|bash|fish|sh$/i.test(command);
  const hasAgentPrompt = /(^|
)\s*[›>]\s+/.test(input.tail)
    || /gpt-.*·\s*~\//i.test(input.tail);
  const hasShellPrompt = /[%$#]\s*$/.test(input.tail);

  if (isAgent && hasAgentPrompt && !input.tailChangedRecently) return "agent_waiting_input";
  if (isAgent && input.tailChangedRecently) return "agent_running";
  if (isShell && hasShellPrompt) return "idle_shell";
  if (!isShell && !isAgent && input.tailChangedRecently) return "command_running";

  return "unknown";
}
```

### 8.3 状态判断返回 reason

不要只返回枚举，必须返回可解释原因：

```json
{
  "inferredWorkloadState": "agent_waiting_input",
  "confidence": 0.82,
  "reason": [
    "activeCommand 是 codex",
    "tail 末尾检测到 Codex prompt",
    "最近 3 分钟没有新增输出"
  ]
}
```

---

## 9. 页面七：复制成功 / 飞书接力

![复制成功与飞书接力](../assets/runweave-mobile-hermes-scheme-a-v2/07-copy-success-feishu.png)

### 9.1 交互步骤

1. 用户点 `发给 Hermes`；
2. Runweave 生成上下文草稿；
3. 用户点 `复制并打开飞书`；
4. 手机跳到 Feishu；
5. 用户粘贴草稿，并补一句自然语言目标；
6. Hermes 收到后先观察终端；
7. Hermes 判断是等待输入 / 执行中 / 卡住；
8. Hermes 决定发送指令、继续监控或先总结询问。

### 9.2 Hermes 收到后的原则

```text
先观察，再操作。
```

具体规则：

- 如果 `agent_waiting_input`：可以发送用户补充的 prompt；
- 如果 `agent_running`：不要插入新指令，先监控；
- 如果 `idle_shell`：可以执行新命令；
- 如果 `unknown`：先总结状态，必要时询问用户；
- 如果 `possibly_stuck`：先提供判断和建议，不直接强杀。

---

## 10. 页面八：完整用户旅程

![端到端用户旅程](../assets/runweave-mobile-hermes-scheme-a-v2/08-user-journey.png)

### 10.1 标准流程

```text
1. 手机上打开 Tailscale Serve URL
2. 登录 Runweave
3. 进入 /mobile/terminals
4. 选择 run-weave 项目
5. 查看终端卡片，找到黄色“Codex · 等待输入”
6. 点卡片进入详情，确认 tail
7. 点“发给 Hermes”
8. 预览上下文并复制
9. 打开飞书粘贴给 Hermes
10. 补充自然语言目标：继续推进、跑测试、修复失败等
11. Hermes 读取终端最新状态
12. Hermes 执行 / 监控 / 汇总
13. 飞书收到完成结果
```

---

## 11. 后端接口建议

### 11.1 新增移动端 Overview API

```http
GET /api/terminal/mobile/overview?projectId=91e34928-d8ff-43ac-a6da-32f94209b28f
```

返回：

```ts
interface MobileTerminalOverviewResponse {
  projects: Array<{
    projectId: string;
    name: string;
    path: string | null;
    totalTerminals: number;
    needsAttention: number;
    runningAgents: number;
    idleShells: number;
  }>;
  selectedProjectId: string | null;
  terminals: MobileTerminalCardViewModel[];
}
```

### 11.2 新增上下文生成 API

```http
POST /api/terminal/session/:id/hermes-context
```

返回：

```ts
interface HermesContextResponse {
  terminalSessionId: string;
  projectName: string;
  cwd: string | null;
  inferredWorkloadState: string;
  foregroundCommand: string | null;
  tail: string;
  markdown: string;
  copiedText: string;
}
```

---

## 12. 前端组件拆分

建议文件：

```text
frontend/src/pages/mobile/MobileTerminalsPage.tsx
frontend/src/components/mobile/ProjectSelector.tsx
frontend/src/components/mobile/TerminalStatusFilter.tsx
frontend/src/components/mobile/TerminalCard.tsx
frontend/src/components/mobile/TerminalDetailDrawer.tsx
frontend/src/components/mobile/HermesHandoffPreview.tsx
frontend/src/lib/terminalStateInference.ts
frontend/src/lib/hermesContext.ts
```

组件责任：

| 组件                        | 职责                                  |
| --------------------------- | ------------------------------------- |
| `MobileTerminalsPage`       | 拉取 overview、维护项目/筛选/抽屉状态 |
| `ProjectSelector`           | 项目 chips，显示项目级摘要            |
| `TerminalStatusFilter`      | 状态筛选 chips                        |
| `TerminalCard`              | 单个终端卡片和主操作                  |
| `TerminalDetailDrawer`      | tail、判断依据、操作抽屉              |
| `HermesHandoffPreview`      | 预览/复制/打开飞书                    |
| `terminalStateInference.ts` | 状态推断纯函数，可单测                |
| `hermesContext.ts`          | 生成飞书/Hermes 文案                  |

---

## 13. 实现任务拆分

### Task 1：补充状态推断纯函数与单测

**文件：**

```text
frontend/src/lib/terminalStateInference.ts
frontend/src/lib/terminalStateInference.test.ts
```

**验收：**

- `activeCommand=codex + prompt + 最近无变化` => `agent_waiting_input`
- `activeCommand=codex + tail 最近变化` => `agent_running`
- `/bin/zsh + shell prompt` => `idle_shell`
- `pnpm + tail 最近变化` => `command_running`

### Task 2：实现移动端 Overview API

**文件：**

```text
backend/src/routes/terminal.ts
packages/shared/src/terminal-protocol.ts
backend/src/routes/terminal.test.ts
```

**验收：**

- 返回项目摘要；
- 返回当前项目终端卡片 VM；
- 每个终端带 `inferredWorkloadState`、`stateReason`、`tailPreview`。

### Task 3：实现 `/mobile/terminals` 页面骨架

**文件：**

```text
frontend/src/pages/mobile/MobileTerminalsPage.tsx
frontend/src/App.tsx 或路由配置文件
```

**验收：**

- 手机宽度 390-430px 可用；
- 项目 chips 可切换；
- 卡片列表可滚动；
- 默认排序符合规则。

### Task 4：实现终端卡片

**文件：**

```text
frontend/src/components/mobile/TerminalCard.tsx
```

**验收：**

- 不同状态显示不同颜色；
- 主按钮随状态变化；
- 卡片展示 state reason 的简短版本。

### Task 5：实现详情抽屉

**文件：**

```text
frontend/src/components/mobile/TerminalDetailDrawer.tsx
```

**验收：**

- 可查看 tail；
- 可查看判断依据；
- 可复制 terminal id / cwd / context。

### Task 6：实现 Hermes 上下文预览与复制

**文件：**

```text
frontend/src/components/mobile/HermesHandoffPreview.tsx
frontend/src/lib/hermesContext.ts
```

**验收：**

- 生成飞书可读 Markdown；
- 点击复制写入剪贴板；
- 成功后提示“已复制，可去飞书粘贴”。

### Task 7：接入 Feishu 打开动作

MVP 可以先用提示和复制；后续再做 deep link / webhook。

**验收：**

- iOS/Android 上点击后能打开飞书或给出明确复制提示；
- 不依赖公网暴露 Runweave。

---

## 14. MVP 验收标准

1. 手机打开页面后，用户能在 10 秒内找到 `run-weave` 的目标终端。
2. UI 能区分：
   - 终端 session 是否 alive；
   - 前台程序是什么；
   - 实际 workload 是等待输入、执行中、空闲还是卡住。
3. `activeCommand=codex` 不被直接显示为“正在执行”，而是进一步判断。
4. 点击 `发给 Hermes` 后，复制内容足够 Hermes 安全接管。
5. Hermes 收到后默认“先观察，再操作”，不会误打断正在执行中的 Codex。
6. 页面适配手机宽度，按钮足够大，不要求用户输入复杂命令。

---

## 15. GPT Image2 Prompt 草稿

如果后续接入 GPT Image2，可以用这些 prompt 生成更拟真的产品草图。

### Prompt 1：首页

```text
Create a clean mobile app UI mockup, iPhone 15 aspect ratio, for a developer tool called Runweave. The design is project-first terminal cards. Top dark header says "Runweave 终端". Search bar below. Project chips: run-weave selected, space-v3, hermes. List terminal cards with status: yellow "Codex · 等待输入", blue "Codex · 正在执行", green "zsh · 空闲". Each card has project path, last output time, reason, and buttons "发给 Hermes" and "详情". Modern minimal design, Chinese labels, high fidelity wireframe, white background, blue accent, readable text.
```

### Prompt 2：终端详情

```text
Create a mobile terminal detail drawer UI for Runweave. Show terminal id, project run-weave, cwd path, foreground command codex, inferred state "等待输入". Include a tail preview panel with monospace terminal output and a bottom action drawer with buttons "发给 Hermes", "复制上下文", "总结终端". Design should emphasize safe handoff to an AI assistant, Chinese text, modern developer tool style.
```

### Prompt 3：Hermes 交接预览

```text
Create a mobile UI screen showing a handoff preview from Runweave to Hermes via Feishu. Title "发给 Hermes". Show a message draft in Chinese with project name, terminal session id, status, cwd, tail summary, and instruction "请先读取最新状态，若等待输入则继续推进". Buttons: "复制并打开飞书" and "仅复制". Clean product design, iPhone mockup, high contrast, readable text.
```

### Prompt 4：状态判断图

```text
Create a visual interaction diagram explaining terminal state inference for a mobile developer tool. Flow: session running -> active command codex -> tail prompt detected -> no recent output -> state: Codex waiting input. Also show branch: tail changing -> Codex running; active command zsh + shell prompt -> idle shell. Use Chinese labels, simple cards, arrows, color coding yellow/blue/green/red, product documentation style.
```

---

## 16. 结论

方案一应该作为第一版移动端主路径实现：

```text
项目选择 → 终端卡片 → 详情确认 → 发给 Hermes → 飞书补指令 → Hermes 观察/执行/监控/汇总
```

它的关键不是“在手机上复刻完整终端”，而是把移动端最难的事情简化成：

```text
快速找到目标终端 + 判断真实状态 + 低摩擦交给 Hermes
```
