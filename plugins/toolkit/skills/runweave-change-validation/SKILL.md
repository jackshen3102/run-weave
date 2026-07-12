---
name: runweave-change-validation
description: 在 Runweave 仓库完成代码修改后，根据本次真实 diff 通过 Dev Session 规划、启动、发现并清理隔离验证环境。用于修复 Bug、实现功能或重构后的行为验收；当改动可能影响 frontend、backend、app-server、Electron、Beta、共享协议、运行时或 CDP surface 时必须使用。不要用于纯诊断、只读评审或纯文档改动。
---

# Runweave 变更验证

把 Dev Session 当作代码改完后的环境裁决器，而不是编码前猜测 profile 的工具。

## 不可变边界

- 始终从 Stable terminal 执行命令；所有 Dev Session profile 都只是被测面。
- 第一次 dry-run 不显式指定 profile。先让真实 diff 给出最低影响闭包。
- 可以因用户明确的安装态、跨版本或桌面验收目标提升 profile；禁止向下降级或绕过 planner。
- 未提交代码的验证环境只允许通过 `pnpm dev:session` 启动，并只用 `dev:status`、`dev:open`、`dev:stop` 管理生命周期。Agent 直接调用 Backend、App Server、Electron、Beta、手工 profile/端口或任何跳过 planner 的入口都视为绕过；Dev Session 内部调用的 adapter 不受此限制。
- 当前工作区有无关改动时，使用只包含本次 patch 的独立 worktree；禁止 stash、reset 或混入他人改动。
- 浏览器与桌面行为必须真实取证，静态检查不能代替行为验收。

## 与真实复现的交接契约

与 `$toolkit:reproduce-before-fix` 组合时，先接收并固定：

- `validationSessionId`：修复前后共用的 Dev Session 逻辑身份；
- `scenarioId`：需要原样重跑的用户场景；
- 修复前 revision、完整步骤、输入和 `before/` 证据路径；
- 修复前 `dev:status` / `dev:open` 关键身份；若来自既有用户现场，则接收 `sourceSessionId` 映射。

修复前 Dev Session 必须先 `dev:stop`，并在重用 ID 前归档 before manifest 关键字段，因为同 ID 再次启动会更新 manifest。修复后继续使用同一个 `validationSessionId`，不得另取随机 ID。service instance ID、PID 和 endpoint 可以变化，需分别记录以证明两轮都属于正确 target。

如果修复前来自不可替换的既有用户 session，保留原 `sourceSessionId`，修复后使用既定的 `validationSessionId`；最终明确说明不同 ID 的原因，不把它伪装成同环境复测。

## Session ID 生成规则

禁止自行使用 UUID、完整时间戳、问题标题或临时字符串作为 session ID。

- 默认：第一次实际执行 `dev:session start` 时不传 `--session`，从 JSON 结果捕获 `devSessionId`，立即保存为 `validationSessionId`；后续 `status`、`open`、`stop` 和修复后重启全部显式传入该 ID。
- 必须预先声明 ID：使用 `rcv-YYYYMMDD-<hash6>`。`hash6` 固定取 `SHA-256("<baselineRevision>\n<scenarioId>")` 前 6 位小写十六进制，例如 `rcv-20260712-a1b2c3`；禁止 `Math.random`、UUID、随意截 commit 或其它来源。只生成一次，并在第一次 start 前写入交接记录。
- 从 `$toolkit:reproduce-before-fix` 接收到 ID：直接复用，不重新生成。

创建证据根目录时使用最终捕获的 ID，不用“latest”、端口或 PID 代替。

## 执行流程

### 1. 固定本次 patch 边界

代码修改完成后读取 `git status --short`、任务开始前状态和当前 diff，区分本次文件与既有改动。

若工作区不干净且包含无关改动：

1. 从当前基线 commit 创建临时 worktree。
2. 只把本次任务文件的 patch 应用到该 worktree。
3. 在该 worktree 安装依赖并执行后续 Dev Session 命令。

无法可靠区分 patch 边界时停止，不把整个脏工作区当作本次影响范围。

### 2. 让 planner 裁决最低环境

在只包含本次 patch 的 source root 中先运行：

```bash
pnpm dev:session --dry-run --json
```

检查 `changedFiles`、`impacts`、`requiredProfile`、每项服务的 `ownership` 和目标 surface。

若结果高于预期，先反查实现是否无意修改公共契约、安装运行时或扩大消费者闭包。能收缩实现则修改代码并重新 dry-run；不能收缩则接受 planner 结果。不要用显式低 profile 压过影响闭包。

### 3. 启动并核对身份

按 Session ID 生成规则得到 `validationSessionId`，再按 planner 结果启动 Dev Session。与 `$toolkit:reproduce-before-fix` 组合时必须使用其交接的 ID；单独使用本技能时默认捕获 Dev Session 自动生成的 ID。用户明确要求更高环境时才显式提升 profile。

启动后执行：

```bash
pnpm dev:status --session <id> --json
```

将纯 JSON 状态保存为证据，并使用本技能的 `scripts/assert-dev-session-status.mjs` 做机器断言：

```bash
node ./scripts/dev-session/cli.mjs status --session <id> --json > <status.json>
node <skill-dir>/scripts/assert-dev-session-status.mjs \
  --file <status.json> \
  --session <id> \
  --source-root <patch-worktree> \
  --profile <profile> \
  --surface <surface>
```

脚本必须输出 `healthy: true`；失败时停止，不用人工目测覆盖脚本结论。

必须确认：

- `controlPlane.appChannel` 是 `stable`；
- source root、revision 和 dirty 状态对应本次 patch；
- target profile 与验收目标一致；
- dedicated/shared ownership 符合 planner；
- Backend、App Server、Electron/CDP 的 service identity 与 health 均匹配 manifest。

任一 dedicated 服务发生身份漂移、隐式 fallback 或能力退化时停止验收。比如 pane 归属用例要求 tmux，却实际退化为 PTY，不能继续把结果算作通过。

### 4. 只从 Dev Session 解析验收入口

根据行为所在层选择 surface：

- Web 主页面：`web`；
- Electron 主窗口和终端标签：`desktop`；
- 终端内嵌 Browser：`terminal-browser`。

运行：

```bash
pnpm dev:open --session <id> --surface <surface> --json
```

使用输出的 URL/CDP endpoint 和建议的 Playwright session。桌面启动、系统弹窗或菜单准备使用 `$computer-use`；页面 DOM、点击、输入、刷新和截图使用 `$toolkit:playwright-cli`。禁止从环境变量、默认端口、旧 tab 或最近实例猜目标。

### 5. 执行真实场景

按需求运行真实入口和生产代码路径。若本任务组合了 `$toolkit:reproduce-before-fix`，使用同一个 `scenarioId`，保持用户步骤、输入、数据规模和关键时序不变，原样重跑复现场景，再补受影响回归。

将运行前、运行中和运行后的关键状态写入与 `before/` 同级的 `after/`，包括必要的 session/pane、事件、manifest identity、DOM 和截图证据。只验证本次影响闭包，不顺手扩大验收范围。

### 6. 清理与交付

验收完成或失败后都执行：

```bash
pnpm dev:stop --session <id> --json
```

只停止 manifest 中由该 Session 拥有的 dedicated 服务；不停止 shared 服务。停止后最多等待 10 秒确认状态进入 `stopped` 且目标端口/CDP 不再监听，再移除临时 worktree。

10 秒后仍未清理完成时停止等待：重新保存 `dev:status --json`，用 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 记录占用进程并报告环境阻塞。不要无限轮询、按端口盲杀或移除仍被运行服务使用的 worktree。

最终报告必须包含：

- planner 的最低 profile 与影响原因；
- 实际使用的 target profile、ownership 和 surface；
- `dev:status` / `dev:open` 的关键身份；
- 真实验收结果与证据；
- 同一个 `validationSessionId` 下的 Before/After 对照；
- `dev:stop` 和资源清理结果；
- 未执行项及阻塞原因。

至少并列呈现以下字段：

| 字段            | Before                               | After                              |
| --------------- | ------------------------------------ | ---------------------------------- |
| revision        | 修复前 revision                      | 修复后 revision                    |
| session         | `validationSessionId` 或 source 映射 | 同一 `validationSessionId`         |
| target identity | profile、service identity、surface   | profile、service identity、surface |
| 场景            | `scenarioId`、步骤、输入             | 原样重跑结果                       |
| 可观察结果      | 原始症状                             | 修复后结果                         |
| 证据            | `before/` 路径                       | `after/` 路径                      |

## 例外

- 纯诊断、只读评审：不修改代码，也不创建 Dev Session。
- 纯文档改动：执行文档自身校验，不启动运行环境。
- Dev Session 明确不支持所需 target：报告环境阻塞，不自行搭建平行环境；需要扩大机制时先与用户对齐。
