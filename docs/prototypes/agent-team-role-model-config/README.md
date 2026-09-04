# Agent Team 全局模型配置原型

可运行 HTML 交互原型。入口复用 Runweave 工作区右上角现有 `...` More 菜单，以居中弹窗配置主 Agent、实现、代码评审、行为验收四个角色的 Codex / TraeX 模型与参数。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/agent-team-role-model-config
```

打开 `http://127.0.0.1:6188/`。

## 文件

- `index.html`：Runweave 工作区、More 菜单、全局配置弹窗与视觉样式。
- `app.js`：弹窗草稿、角色切换、CLI / 模型能力约束、取消与保存交互。
- `mock-state.json`：全局角色初始值，以及 Codex / TraeX 的本机模型能力快照。
- `prototype-preview.png`：浏览器验收后的弹窗截图。

## 原型简报

- 目标：给当前 Runweave 连接定义一套跨 Project 复用的 Agent Team 角色默认配置。
- 全局边界：当前连接下所有 Project；不是单个 Project，也不是单个 Run。
- 生效时机：保存后新启动的 Agent Team；运行中和历史 Run 保持原配置。
- 主要用户：维护本机或远程 Runweave 连接、启动多个 Project Agent Team 的开发者。
- 用户动作：右上角 `...` → `Agent Team 模型配置` → 逐角色选择 CLI、模型与能力参数 → 保存全局配置。
- 非目标：不在右侧 Agent Team 面板配置，不连接真实后端，不执行 CLI，不修改 Agent Team 协议。

选择“当前连接级全局”而不是跨设备账号级全局，是因为 Codex / TraeX 的安装版本、登录账号和模型目录属于运行它们的 backend。把一台机器探测出的组合直接同步到另一台机器，会产生不可用配置。

## 当前代码现状

现有顶部入口已经存在，不需要再造一套导航：

- `frontend/src/components/terminal/terminal-workspace-header.tsx` 已使用 `MoreHorizontal` 和 `DropdownMenu`，按钮的 `aria-label / title` 为 `More actions`。
- 该菜单已有 Preview、Open Prototypes、Terminal History、Recover Codex、日志上报、状态查询。
- `frontend/src/components/terminal/terminal-workspace-shell.tsx` 挂载这个 workspace header。
- `frontend/src/components/ui/dialog.tsx` 已提供 Radix Dialog，可承载居中弹窗。

Agent Team 当前不是“完全没有 Codex / TraeX 支持”，而是配置粒度停留在整个 Run：

- `packages/shared/src/agent-team/run-contract.ts` 的 `AgentTeamTerminal` 只有 `command / args / cwd / runtimePreference`。
- `packages/shared/src/agent-team/worker.ts` 的 worker 只有 `role / intent / panelId / tmuxPaneId / frozen`。
- `frontend/src/components/terminal/terminal-agent-team-panel.tsx` 创建 Run 时没有提交 `terminal`，后端因而使用缺省 Codex。
- `backend/src/agent-team/service-run-policy.ts` 将缺省命令解析为 `codex`。
- `backend/src/agent-team/runtime/agent-launch.ts` 启动主 Agent 和 worker 时接收同一个 `AgentTeamTerminal`。
- `backend/src/agent-team/service-worker-dispatch-support.ts` 恢复 worker thread 时仍以 Run 级 `terminal.command` 判断 provider。

因此需要新增的是：

1. 当前连接级的角色默认配置。
2. 新建 Run 时解析全局默认值并持久化一份不可变快照。
3. 主 Agent和各 worker 按自己的 provider / model config 启动、恢复。

## CLI 与模型能力核对

核对时间：2026-07-25。模型目录是当前机器、当前账号的实时结果，不应作为永久枚举写死在前端。

```bash
codex --version
codex --help
codex debug models
traex --version
traex --help
traex models --json
traex debug models
```

结果：

- Codex CLI `0.144.6`：原型快照收录 7 个模型；真实目录随当前版本和账号动态变化，reasoning effort 及 Fast 能力也随模型变化。
- TraeX CLI `0.200.19`：原型快照收录 26 个模型；reasoning effort、context window、Max 能力以及 Beta 状态各不相同。
- 两个 CLI 都支持 `-m / --model` 和 `-c / --config key=value`。
- 模型配置不混入 sandbox、approval、permission mode，这些不是模型能力参数。

Codex 官方资料：

- [Codex Models](https://learn.chatgpt.com/docs/models)
- [Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)

TraeX 为当前机器上的 internal edition，原型以本地 CLI 返回为准。

## 方案探索

### 1. 继续使用 Run 级单一配置

只给整个 Team 选一次 CLI / 模型，无法满足逐角色配置。

### 2. 每个角色直接填写 CLI args

最灵活，但要求用户理解两套 CLI 语法，参数校验、迁移与审计成本高。

### 3. 前端写死模型和参数表

交互直接，但模型目录和能力变化后会快速过期。

### 4. 只提供角色预设或自动策略

操作简单，但失去显式模型控制；相同配置名在目录变化后也可能产生不同结果。

### 5. 能力驱动的结构化配置

backend 从 CLI 获取模型目录和能力，产品保存 `cli + model + supported params`，界面按 provider 和 model capability 展示字段。

原型采用方案 5，四个角色保持独立配置。

## 最终交互

1. 用户点击 workspace header 右上角现有 `...`。
2. More 菜单保留既有条目，在底部增加带“全局”标识的 `Agent Team 模型配置`。
3. 点击后关闭菜单，打开居中 modal；标题仅保留 `Agent Team 模型配置` 和“全局”标识。
4. 左侧在四个角色之间切换，持续展示每个角色的 CLI / 模型 / reasoning 摘要。
5. 右侧切换 Codex / TraeX；切换时清空模型和不兼容参数，必须显式选择该 CLI 的可用模型。
6. 模型选择器支持搜索；未选择模型时禁止保存，reasoning effort 只显示当前模型支持的档位。
7. Codex 高级参数只展示 Fast；TraeX 展示 Max，模型不支持时禁用。
8. `取消`、关闭按钮、点击遮罩均丢弃当前草稿；`保存全局配置` 才提交并关闭弹窗。

## 验证点

- 入口位于现有右上角 `...`，页面没有 Agent Team 右侧配置面板。
- 弹窗只显示“全局”标识，不显示连接、Project 或 Run 范围说明。
- 四个角色可保存不同 CLI、模型和参数。
- 切换 CLI 后不会自动选择目录第一项；模型为空时禁止保存。
- 切换 CLI / 模型后不会保留不兼容参数。
- 模型搜索、reasoning、Fast、Max 的能力约束有效。
- 取消不写入已保存配置；重新打开恢复已保存值。
- 保存后再次打开能看到新配置。

## 功能分类

### 产品核心功能

| 元素 / 行为         | 产品价值                           | 备注                           |
| ------------------- | ---------------------------------- | ------------------------------ |
| 现有 More 菜单入口  | 全局能力不挤占任务侧栏             | 复用 `TerminalWorkspaceHeader` |
| 当前连接级作用域    | 跨 Project 复用且符合 CLI 运行位置 | 不做跨连接盲同步               |
| 四个角色独立配置    | 满足逐角色模型选择                 | 包括隐式主 Agent               |
| CLI 能力探测与刷新  | 避免模型目录静态过期               | 由 backend 执行                |
| 能力约束的参数编辑  | 避免提交无效组合                   | provider + model 双重约束      |
| 模型搜索            | TraeX 当前有 26 个模型             | 不平铺完整目录                 |
| 新 Run 固化配置快照 | 保证历史审计和恢复一致             | 不跟随全局配置漂移             |

### 原型辅助功能

| 元素 / 行为                | 辅助验证什么       | 生产替代                       |
| -------------------------- | ------------------ | ------------------------------ |
| `mock-state.json` 能力快照 | 动态字段和模型目录 | backend 实时探测、规范化和缓存 |
| 静态工作区终端背景         | 验证真实入口层级   | 生产已有 workspace             |
| 保存成功 toast             | 验证提交反馈       | 接真实持久化结果               |
| 页面刷新重置               | 重复演示           | 生产读取已保存全局配置         |

## 调整记录

| 轮次 | 调整内容                               | 原因                           | 结果                                         |
| ---- | -------------------------------------- | ------------------------------ | -------------------------------------------- |
| 1    | 从 Run 级 CLI 选择改为四个角色独立配置 | 主 Agent 也是实际执行角色      | 覆盖完整 Team                                |
| 1    | 模型目录改为能力驱动                   | Codex / TraeX 参数能力不同     | 无效参数隐藏或禁用                           |
| 2    | 作用域从单 Run 改为当前连接全局        | 用户要求跨 Project 复用        | 新 Run 继承全局默认值                        |
| 2    | 从右侧面板迁移到居中弹窗               | 配置是低频全局操作             | 不占用 Agent Team 任务空间                   |
| 2    | 入口复用右上角现有 More 菜单           | 与当前产品信息架构一致         | 无新增顶层入口                               |
| 2    | 增加草稿 / 取消 / 保存语义             | 全局修改需要明确提交边界       | 避免误改                                     |
| 3    | 移除批量角色覆盖操作                   | 用户判断使用价值不足           | 每个角色只在自己的编辑页修改                 |
| 4    | 移除标题下的连接与生效范围说明         | 用户要求精简标题栏             | 仅保留标题和全局标识                         |
| 5    | 移除 Codex 输出详细度                  | 用户判断无需暴露该参数         | Codex 高级参数仅保留 Fast                    |
| 6    | 切换 CLI 后不再自动选目录第一项        | CLI 没有稳定可信的默认模型标记 | 用户必须显式选择模型，四个角色完整后才可保存 |

## 冻结记录

- 最终交互：右上角 `...` → More 菜单 → 全局 Agent Team 模型配置 modal。
- 全局定义：当前 Runweave 连接下所有 Project 的新 Agent Team Run。
- 放弃方向：右侧面板、Project 级、Run 级单选、原始 args、纯预设、纯自动策略、前端静态枚举。
- 客户端范围：本期只实现 Web / Electron Workspace，不新增 App 入口。
- Provider 范围：只实现 Codex / TraeX 两个显式 adapter，不建设通用插件系统。
- 新 Run 规则：没有全局配置、角色配置不完整、CLI 不可用或模型已失效时，在创建 pane 前阻止启动。
- 缓存规则：探测成功更新磁盘缓存；探测失败直接使用旧缓存，首次无缓存才阻止配置和启动。
- 生命周期规则：新 Run 固化四角色快照；retry、resume、recheck、framework repair 继续使用原快照。
- 兼容规则：历史 Run 不迁移，继续读取原 Run 级 `terminal`；旧 API 的显式 `terminal` 创建入口保留。
- 产品核心与原型辅助能力已在上表区分。
- 最终截图：`prototype-preview.png`。
- 冻结时间：2026-07-25。

## 实施计划衔接

- 前端入口：在 `terminal-workspace-header.tsx` 现有 More dropdown 增加菜单项，并复用 `ui/dialog.tsx`。
- 全局存储：由当前 connection 的 backend 保存角色默认配置；不能只写浏览器 localStorage。
- 创建 Run：解析当前全局配置并把四个角色的结构化配置快照写入 Run。
- 调度与恢复：主 Agent、split worker、resume、recheck、framework repair 均使用对应角色快照，不能回读最新全局值。
- 能力目录：backend adapter 探测 Codex / TraeX，返回规范化 capability catalog 与 revision。
- 验收：类型检查、lint、More → modal 的 Playwright E2E、真实 Codex / TraeX 混合 worker 启动与 resume 行为。

## 边界

- 原型不连接真实 backend API，不执行 CLI，也不导入生产源码。
- 原型不能证明全局存储、角色级协议、混合 provider 生命周期或 thread resume 已经存在。
- 模型快照只代表 2026-07-25 当前机器和账号；模型可用性、额度和参数会变化。
- 产品画面没有 prototype helper；所有辅助说明只存在于本 README。
