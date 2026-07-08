# Agent Team Worker 串行执行测试计划

## 目标

验证 Agent Team 的所有 work 阶段都按串行门禁推进，不能出现多个 worker 同时开始工作。

核心契约：

1. 执行流程：`code -> code_review -> behavior_verify` 串行推进。
2. `code_review` 或 `behavior_verify` 失败时，必须回到 `code`。
3. 任意时刻只有一个 `activeWorkerRole`，非 active worker 不应收到工作 prompt。
4. `typecheck` / `lint` 只作为静态辅助，不能替代浏览器、run JSON、tmux pane、outbox 证据。

## 非目标

- 不验证 Agent Team 的所有历史回归用例，只验证 worker 串行语义。
- 不新增单测、Vitest、Node test 或 mock service 测试。
- 不把 CLI/API 返回值作为单独通过依据；CLI/API 只能辅助布置和读取状态。
- 不验证 Electron 桌面端，除非 Web 端无法覆盖目标行为。

## 测试环境

使用本地 Web 端和真实 backend：

```bash
pnpm dev
```

浏览器验证必须使用 `$playwright-cli`，建议清掉可能污染的 CDP 环境变量：

```bash
env -u PLAYWRIGHT_MCP_CDP_ENDPOINT playwright-cli open http://localhost:5175/terminal/<terminalSessionId>
```

静态预检：

```bash
pnpm typecheck
pnpm lint
```

静态预检通过不代表本计划通过。

## 证据要求

每个用例必须记录以下证据：

- Web URL：例如 `http://localhost:5175/terminal/<terminalSessionId>`。
- `projectId`、`terminalSessionId`、`runId`。
- run JSON 关键字段：`phase`、`status`、`activeWorkerRole`、`workers[].role`、`workers[].panelId`、`workers[].frozen`、`loop.round`。
- Playwright DOM 或截图：右侧 Agent Team 面板能看到当前门禁。
- tmux pane 证据：active worker pane 收到 prompt，非 active worker pane 没有收到当前 work prompt。
- outbox 证据：需要推进门禁时，记录对应 pane 级 `.runweave/outbox/*.json` 片段。

通过依据优先级：

1. 浏览器 UI 和真实 terminal pane 画面。
2. run JSON 和 pane 级 outbox。
3. backend 日志、completion 事件、CLI/API 返回。
4. typecheck/lint 仅作辅助。

## 通用准备步骤

1. 打开一个干净的 tmux-backed terminal session。
2. 用 Playwright 打开该 terminal URL。
3. 打开 Agent Team sidecar。
4. 创建一个任务，例如：`验证 worker 串行门禁，不允许 review/verify 提前执行`。
5. 记录初始 terminal 画面和 run JSON。

如果使用已有 terminal，必须先确认没有 active Agent Team run；否则该用例无效。

## 用例 1：普通执行启动后只激活 code

步骤：

1. 在 Agent Team 面板输入任务，不填写计划文件。
2. 确认拆分，进入 `executing`。
3. 用 Playwright 读取右侧面板。
4. 读取 run JSON。
5. 捕获 code、code_review、behavior_verify 三个 pane 的首屏内容。

期望：

- `phase=executing`。
- `status=running`。
- `activeWorkerRole=code`。
- `code.frozen=false`。
- `code_review.frozen=true`。
- `behavior_verify.frozen=true`。
- code pane 收到 worker prompt。
- code_review pane 和 behavior_verify pane 不应收到当前 work prompt。
- 右侧 UI 显示当前门禁为 `code`。

失败判定：

- 任一 review/verify pane 在 code 完成前收到审查或验收 prompt。
- `activeWorkerRole` 为空或不是 `code`。
- 多个 worker 同时 `frozen=false`。

## 用例 2：code completion 后才启动 code_review

步骤：

1. 执行用例 1，使 run 停在 `activeWorkerRole=code`。
2. 在 code pane 写入结构化 outbox，表示 code 已完成；如实现不要求 code 写 acceptanceResults，可以只写 completed summary。
3. 触发真实 completion hook。
4. 用 Playwright 观察右侧面板。
5. 读取 run JSON 和 code_review pane。

期望：

- `activeWorkerRole=code_review`。
- `code.frozen=true`。
- `code_review.frozen=false`。
- `behavior_verify.frozen=true`。
- code_review pane 此时才收到审查 prompt。
- behavior_verify pane 仍未收到验收 prompt。
- 日志出现 `code 完成，启动 code_review` 或等价文案。

失败判定：

- code 未完成前 code_review 已经收到 prompt。
- code completion 后直接启动 behavior_verify。
- code_review 与 behavior_verify 同时解冻。

## 用例 3：code_review 通过后才启动 behavior_verify

步骤：

1. 执行用例 2，使 run 停在 `activeWorkerRole=code_review`。
2. 在 code_review pane 写入 pane 级 outbox，`acceptanceResults` 中 code review gate case 为 `pass`。
3. 触发真实 completion hook。
4. 读取 run JSON、右侧 UI、behavior_verify pane。

期望：

- `activeWorkerRole=behavior_verify`。
- `code.frozen=true`。
- `code_review.frozen=true`。
- `behavior_verify.frozen=false`。
- behavior_verify pane 此时才收到验收 prompt。
- 日志出现 `code_review 通过，启动 behavior_verify` 或等价文案。

失败判定：

- behavior_verify 在 code_review pass 前收到 prompt。
- code_review pass 后没有切到 behavior_verify。
- 仍有多个 worker 解冻。

## 用例 4：code_review 失败必须回到 code

步骤：

1. 执行用例 2，使 run 停在 `activeWorkerRole=code_review`。
2. 在 code_review pane 写入 outbox，使 code review gate case 为 `fail`，证据说明阻断问题。
3. 触发真实 completion hook。
4. 观察 code pane、run JSON、右侧 UI。

期望：

- `activeWorkerRole=code`。
- `code.frozen=false`。
- `code_review.frozen=true`。
- `behavior_verify.frozen=true`。
- code pane 收到带失败 case 和证据的修复 prompt。
- behavior_verify 不启动。
- 失败 case 显示已抛回 code pane。

失败判定：

- code_review fail 后仍进入 behavior_verify。
- fail 后没有回到 code。
- behavior_verify 收到任何验收 prompt。

## 用例 5：behavior_verify 失败必须回到 code

步骤：

1. 执行用例 3，使 run 停在 `activeWorkerRole=behavior_verify`。
2. 在 behavior_verify pane 写入 outbox，使业务验收 case 为 `fail`。
3. 触发真实 completion hook。
4. 观察 code pane、run JSON、右侧 UI。

期望：

- `activeWorkerRole=code`。
- `code.frozen=false`。
- `code_review.frozen=true`。
- `behavior_verify.frozen=true`。
- code pane 收到验收失败修复 prompt。
- 下一次 code 完成后仍必须重新走 `code_review -> behavior_verify`，不能直接回 behavior_verify。

失败判定：

- verify fail 后仍停在 behavior_verify。
- verify fail 后直接重跑 verify。
- 下一轮 code 完成后跳过 code_review。

## 用例 6：behavior_verify 全部通过后 run 完成

步骤：

1. 执行到 `activeWorkerRole=behavior_verify`。
2. 写入所有非 review gate 验收 case 的 `pass` outbox。
3. 触发真实 completion hook。
4. 读取 run JSON 和右侧 UI。

期望：

- `status=done`。
- `activeWorkerRole=null`。
- 所有 worker `frozen=true`。
- 右侧 UI 显示完成。
- 不再自动注入任何 worker prompt。

失败判定：

- 全部通过后仍有 active worker。
- 完成后继续触发下一轮 worker。

## 用例 7：非 active worker completion 不推进 run

步骤：

1. 让 run 停在 `activeWorkerRole=code`。
2. 手动在 code_review 或 behavior_verify pane 写 outbox。
3. 触发该非 active pane 的 completion hook。
4. 读取 run JSON 和右侧 UI。

期望：

- `activeWorkerRole` 仍为 `code`。
- `loop.round` 不因非 active worker completion 推进。
- acceptance 不被非 active worker outbox 覆盖。
- 日志不出现启动下一门禁的记录。

失败判定：

- 非 active worker completion 推进了 run。
- 非 active outbox 改写了 acceptance。

## 用例 12：人工恢复不解冻所有 worker

步骤：

1. 通过连续失败让 run 进入 `need_human`。
2. 填写人工干预 note 并恢复。
3. 读取 run JSON 和右侧 UI。

期望：

- `status=running`。
- 只恢复一个 `activeWorkerRole`。
- 只有 active worker `frozen=false`。
- 其它 worker 保持 `frozen=true`。

失败判定：

- 恢复后所有 worker 都解冻。
- 恢复后多个 worker 同时收到 prompt。

## 建议执行顺序

最小冒烟集：

1. 用例 1。
2. 用例 2。
3. 用例 3。
4. 用例 4。
5. 用例 5。
6. 用例 6。

完整回归集：

1. 最小冒烟集。
2. 用例 7。
3. 用例 8-11。
4. 用例 12。

## 最终通过标准

本测试计划通过必须同时满足：

- `pnpm typecheck` 通过。
- `pnpm lint` 通过。
- 最小冒烟集全部通过。
- 每个执行过的用例都有 Playwright 证据和 run JSON 证据。
- 对涉及 prompt 注入的用例，必须有 tmux pane 画面证据。
- 对涉及门禁推进的用例，必须有 outbox 或 completion 事件证据。

如果缺少浏览器或 runtime 证据，只能判定为“静态检查通过，worker 串行行为未验收”。
