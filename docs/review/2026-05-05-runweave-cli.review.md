# Runweave CLI 变更评审

日期：2026-05-05

范围：当前工作区相对 `HEAD` 的已修改文件和未跟踪文件，重点包括 `packages/runweave-cli`、终端 WebSocket `input-ack` 协议、CLI 发布脚本、文档和默认质量门禁。

评审模式：强力模式。原因是变更跨后端 WebSocket、共享协议、新 CLI 包、发布脚本、依赖锁文件和文档，包含协议/运行时行为和工具链影响。

验证命令：

- `git status --short --branch`
- `git diff --stat`
- `pnpm --filter ./packages/runweave-cli typecheck`
- `pnpm --filter ./packages/runweave-cli test`

命令结果摘要：

- CLI typecheck 通过。
- CLI Vitest 通过：4 个 test files，10 个 tests。
- 未运行 build/pack/local install，避免在 review-only 模式下生成或安装产物。

## 架构 / 策略发现

### P1：CLI 投递闭环仍没有统一的“操作级”成功契约

当前决策：CLI 复用 `/ws/terminal` 直接发送输入，并在终端协议上新增 `input-ack` 来表达 runtime write 结果。`send --confirm short` 再用 tail、echo、activeCommand 和弱正则推断短确认。

为什么它在系统层面可能是错的：外部 agent 需要的是“投递操作是否成功”的机器契约，但现在契约被拆在三个地方：WebSocket transport、runtime `input-ack`、CLI 本地 tail/状态推断。服务端新增了协议字段，却没有把它提升成服务端拥有的 operation 状态；这会导致 CLI exit code、JSON 字段和真实 tmux 写入时机不一致。证据是 `terminal-ws-client` 收到失败 ack 也只是 `resolve()`，`terminal.ts` 把失败写进 JSON，`index.ts` 仍返回 0。

证据：

- `packages/runweave-cli/src/client/terminal-ws-client.ts:98`
- `packages/runweave-cli/src/commands/terminal.ts:365`
- `packages/runweave-cli/src/index.ts:41`
- `docs/superpowers/plans/2026-05-04-terminal-cli-control-plane.md:474`

更好的候选方案：

- 推荐：新增很薄的服务端 `POST /api/terminal/session/:id/input` 或等价 operation endpoint，由服务端统一负责 ticket、runtime enqueue/write、operationId、ack/error 和 exit-code 语义；CLI 只做 HTTP 调用和输出格式化。
- 次选：保留 WebSocket 发送，但把 `input-ack` 定义为“server accepted/enqueued”，另增单独字段或事件表示真实 runtime write/flush 结果，CLI 对失败 ack 必须抛错。
- 不推荐：继续在 CLI 内用 tail/regex/本地 operationId 拼装成功语义。短期快，但系统复杂度会散落在 CLI 与后端两边，后续 wait/idle/completion 更难收敛。

迁移/过渡风险：新增 HTTP 输入 endpoint 会和现有 WebSocket 输入形成短期双入口，需要明确只给外部自动化使用，或者让前端也复用同一个服务端 input operation，避免长期分叉。

### P2：CLI 测试被放在旁路脚本里，没有进入默认质量门禁

当前决策：新增 `packages/runweave-cli` 的 Vitest，但根 `test:default` 仍只跑 backend/shared/electron；文档里的预合并全量信心也仍是 `test:default && test:e2e`。

为什么它在系统层面可能是错的：CLI 是新的外部控制面，回归风险不低于 backend route/helper。把 `cli:test` 做成手动脚本会让 CI 和本地预合并默认路径漏跑 CLI 行为，特别是这次已经有 WebSocket ack、auth refresh、输出格式、exit code 等契约风险。

证据：

- `package.json:21`
- `package.json:22`
- `package.json:29`
- `docs/testing/command-matrix.md:16`
- `docs/quality/quality-harness.md:27`
- `packages/runweave-cli/vitest.config.ts:3`

更好的候选方案：

- 推荐：把 `pnpm --filter ./packages/runweave-cli test` 纳入 `test:default`，并在命令矩阵中加入 CLI/控制面变更的推荐命令。
- 次选：把根默认测试改为 workspace 选择式命令，例如显式列出 backend/shared/electron/runweave-cli，保持前端仍只走 E2E。
- 不推荐：只保留 `cli:test`。这依赖人工记忆，和新增 CLI 控制面的风险等级不匹配。

迁移/过渡风险：默认测试时间会增加约 0.5s 到 1s；这是可接受成本。需要注意不触碰前端 Vitest 禁令，范围只应限定 CLI package。

### P3：本地发布脚本把版本变更和全局安装绑定在一起

当前决策：`pnpm cli:publish:local` 会先执行 `cli:version:bump`，直接改写 `packages/runweave-cli/package.json`，然后 build、pack、`npm install -g`。

为什么它在系统层面可能是错的：本地试用和源码版本变更被绑定，任何一次本地安装都会制造源代码 diff，容易把“试装动作”误提交成版本发布。全局 `npm install -g` 也把可复现性转移到用户机器环境，不适合做默认发布路径。

证据：

- `package.json:26`
- `package.json:28`
- `scripts/bump-runweave-cli-version.mjs:35`
- `scripts/bump-runweave-cli-version.mjs:36`
- `scripts/publish-runweave-cli-local.mjs:43`

更好的候选方案：

- 推荐：拆成 `cli:pack`、`cli:install:local`、`cli:version:bump` 三个独立命令；默认本地安装不改 package version。
- 平台/工具链方案：使用 `pnpm --filter ./packages/runweave-cli link --global` 或固定 tarball 输出目录，让开发者显式选择是否安装。
- 不推荐：每次 local publish 自动 bump minor。它会制造无意义版本膨胀和 diff 噪声。

迁移/过渡风险：拆命令后需要更新文档和开发者习惯；但可以保留一个显式 `cli:release:local` 组合命令给确实要 bump 的场景。

## 代码 / 实现发现

### P1：runtime write 失败时 CLI 仍以 exit code 0 结束

为什么这是风险：实施计划要求“只有 WebSocket/runtime write 失败才视为发送失败”，但当前 CLI 收到 `runtimeWriteSucceeded=false` 后只是把错误放进 JSON，不抛错；`runCli()` 对 `terminal` command 成功返回固定 `0`。外部 agent/Hermes 以进程退出码判断投递结果时，会把失败投递当成成功。

证据：

- `packages/runweave-cli/src/client/terminal-ws-client.ts:98`
- `packages/runweave-cli/src/client/terminal-ws-client.ts:104`
- `packages/runweave-cli/src/client/terminal-ws-client.ts:106`
- `packages/runweave-cli/src/commands/terminal.ts:365`
- `packages/runweave-cli/src/commands/terminal.ts:394`
- `packages/runweave-cli/src/index.ts:41`
- `docs/superpowers/plans/2026-05-04-terminal-cli-control-plane.md:479`

可执行修复方向：当 `inputAckReceived && runtimeWriteSucceeded === false` 时，让 `sendWithConfirmation()` 抛 `CliError`，或返回结构化结果后由 command 层按该状态决定非 0 exit code。对应补 CLI command-level 测试，而不是只测 ws client。

### P2：`input-ack` 对 tmux paced runtime 的成功语义过强

为什么这是风险：tmux runtime 的 `write(data)` 可能只是把输入拆块并放入队列。特别是包含 Enter 的输入会被拆分并通过 timer 后续 flush；服务端当前在 `activeRuntime.write(parsed.data)` 返回后立即发 `runtimeWriteSucceeded=true`。这只能证明“调用 wrapper.write 没抛错”，不能证明底层 PTY 已经写入全部输入。后续 timer 内的真实 `runtime.write(next)` 抛错也无法反馈给已发出的 ack。

证据：

- `backend/src/ws/terminal-server.ts:613`
- `backend/src/ws/terminal-server.ts:614`
- `backend/src/terminal/runtime-launcher.ts:223`
- `backend/src/terminal/runtime-launcher.ts:242`
- `backend/src/terminal/runtime-launcher.ts:245`
- `backend/src/terminal/runtime-launcher.ts:248`
- `backend/src/terminal/runtime-launcher.ts:257`

可执行修复方向：把协议字段改名为 `inputAccepted`/`inputEnqueued`，或让 tmux paced runtime 暴露可等待的 enqueue/write 结果。不要把当前 ack 描述成完整 runtime write 成功。

### P2：默认测试命令不会运行 CLI 测试

为什么这是风险：新增 package 有自己的测试，但 `pnpm test` 走 `test:default && test:e2e`，其中 `test:default` 没有 CLI。当前变更的核心风险恰好在 CLI 命令层，而不是 backend/shared/electron 现有测试层。

证据：

- `package.json:21`
- `package.json:22`
- `package.json:29`
- `packages/runweave-cli/src/commands/terminal.test.ts:4`
- `packages/runweave-cli/src/client/terminal-ws-client.test.ts:6`

可执行修复方向：把 CLI tests 纳入 `test:default`，并为 `send` 的 runtime ack failure 增加 command-level 测试，验证 exit code。

### P3：plain 输出模式对对象结果不可用

为什么这是风险：CLI 默认输出模式是 plain；`writeOutput()` 对非 JSON payload 直接 `String(payload)`，大多数 command 返回对象或数组，因此用户会看到 `[object Object]` 或类似不可读输出。文档示例大量使用 `--json`，但 `auth login/status`、`project ensure`、`terminal list/show/create/handoff/send` 默认体验会退化，影响手工排错。

证据：

- `packages/runweave-cli/src/args.ts:72`
- `packages/runweave-cli/src/output/format.ts:14`
- `packages/runweave-cli/src/output/format.ts:23`
- `packages/runweave-cli/src/commands/auth.ts:51`
- `packages/runweave-cli/src/commands/project.ts:46`
- `packages/runweave-cli/src/commands/terminal.ts:75`

可执行修复方向：为对象类命令定义明确 plain renderer；或者把这些命令默认改为 JSON，只有 `snapshot --plain` 这类文本命令输出 raw text。

## 剩余风险 / 测试缺口

- 未运行 `pnpm --filter ./packages/runweave-cli build`，因为它会生成 dist 产物；build 风险仍需在实现修复后验证。
- 未运行真实 backend + CLI 的端到端投递，因为 review-only 不启动/改造流程；当前判断基于源码和 CLI package tests。
- 当前工作区在 `main...origin/main [ahead 1, behind 6]`，评审仅覆盖当前工作区 diff 和未跟踪文件，未评估与远端最新 main rebase 后的冲突。
