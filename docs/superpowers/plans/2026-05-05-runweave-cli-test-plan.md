# Runweave CLI 控制面测试计划

> **日期：** 2026-05-05
> **对象：** `packages/runweave-cli` / `rw` 终端控制面 CLI
> **测试视角：** Hermes / OpenClaw / 外部 agent 自动化调用方
> **目标：** 验证 CLI 是否能作为 Runweave backend 的可靠控制面：登录、确认 project、创建/读取 terminal、生成 handoff 上下文、向指定 terminal 投递输入、短确认、输出机器可读 JSON；同时通过测试暴露 CLI 能力不足或语义不可靠的地方。

---

## 1. 测试结论预期

本测试计划不只验证“命令能跑通”，还要回答下面几个产品/集成问题：

1. **Hermes 能不能只靠 `rw` CLI 接管 Runweave terminal，不再直接找 tmux socket？**
2. **`rw terminal send --confirm short --json` 返回的字段是否足够让 Hermes 判断“已投递 / 已提交 / 置信度 / 下一步”？**
3. **CLI 的 JSON stdout 是否稳定可解析，stderr 是否承载错误和诊断？**
4. **当 terminal 不存在、token 失效、backend 不可达、HTTPS input 失败时，CLI 是否有稳定 exit code 和可读错误？**
5. **如果 CLI 目前不能强保证任务执行完成 / hook correlation，测试是否能清楚暴露出来？**

最终测试报告建议分成三类：

```text
PASS：符合 Hermes 控制面使用要求。
WARN：能用，但语义弱，需要 Hermes 谨慎处理。
FAIL：不适合作为 Hermes 自动化默认路径，必须修复。
```

---

## 2. 测试范围

### 2.1 首期 MVP 必测命令

```bash
rw auth login --base-url http://127.0.0.1:5001 --username admin
rw auth status --json
rw project ensure --name browser-viewer --path "$PWD" --json
rw terminal create --project-id <projectId> --cwd "$PWD" --runtime auto --json
rw terminal list --json
rw terminal show <terminalSessionId> --json
rw terminal snapshot <terminalSessionId> --tail 120 --json
rw terminal snapshot <terminalSessionId> --tail 120 --plain
rw terminal handoff <terminalSessionId> --tail 120 --json
rw terminal send <terminalSessionId> --text "..." --enter --confirm short --json
rw terminal send <terminalSessionId> --stdin --enter --confirm none --json
```

### 2.2 非首期默认能力，只做探索性测试

如果 CLI 已经实现，可以探索；如果未实现，不算 MVP 失败：

```bash
rw terminal exec ...
rw terminal signal ...
rw project list/create/update/delete
rw terminal history/delete/overview
```

### 2.3 明确不测试

- 不测试前端 React UI 单测。
- 不要求 CLI 长时间等待 Codex 完成。
- 不要求 CLI 解析 Codex/Claude/Coco 输出语义。
- 不要求 CLI 直接操作 tmux。
- 不要求首期 completion event 强因果关联到本次 `operationId`。

---

## 3. 当前实现观察与重点风险

基于当前源码快速观察：

- CLI package 已存在：`packages/runweave-cli`。
- binary 名为：`rw`，dist 入口为 `packages/runweave-cli/dist/index.js`。
- 已实现主要命令组：`auth`、`project`、`terminal`。
- `terminal` 当前支持：`create`、`list`、`show`、`snapshot`、`handoff`、`send`。
- `send` 使用登录态 HTTPS input 接口：`POST /api/terminal/session/:id/input`。
- `send` 当前请求体是：

```json
{ "operationId": "...", "data": "..." }
```

需要重点验证/暴露的风险：

1. **HTTPS input 返回的是“已接受/已入队”，不是任务完成。**
   `inputAccepted=true` / `inputEnqueued=true` 只表示 backend 已鉴权、找到目标 terminal，并完成 runtime 写入或入队；tmux paced runtime 下不代表所有字节已经从 timer flush 完成，也不代表 TUI 已开始执行。

2. **`operationId` 只在 CLI 输出中出现。**
   如果没有写入 prompt / hook payload，后续 Codex completion hook 只能通过 `terminalSessionId + source + sendStartedAt` 弱关联。

3. **`handoff` 的 state 是弱推断。**
   需要验证它是否至少给 Hermes 足够上下文，而不是让 Hermes误判“Codex activeCommand = 正在执行”。

4. **JSON stdout 必须严格。**
   因为 Hermes/OpenClaw 会直接 parse stdout，任何非 JSON 内容都算控制面问题。

5. **配置文件安全。**
   `~/.runweave/config.json` 应为 `0600`；refresh token 不应泄露到 stdout/stderr。

---

## 4. 环境准备

### 4.1 进入项目

```bash
cd /Users/bytedance/Code/browser-hub/browser-viewer
```

### 4.2 安装依赖和构建 CLI

```bash
pnpm install
pnpm --filter ./packages/runweave-cli build
pnpm --filter ./packages/runweave-cli test
```

预期：

```text
build exit code = 0
test exit code = 0
```

### 4.3 启动 Runweave backend

优先使用默认本地 backend：

```bash
pnpm dev
```

或如果只需要 backend：

```bash
pnpm --filter ./backend start -- --host 127.0.0.1 --port 5001
```

验证：

```bash
curl -sS http://127.0.0.1:5001/api/health || true
```

> 如果 health endpoint 不存在，用 `rw auth status --json` / 登录接口验证 backend 可达即可。

### 4.4 使用隔离的 CLI profile 目录

为了不污染真实 `~/.runweave/config.json`，建议每次测试用临时 HOME：

```bash
export RW_TEST_HOME="$(mktemp -d /tmp/runweave-cli-test-home.XXXXXX)"
export HOME="$RW_TEST_HOME"
```

验收完成后可删除：

```bash
rm -rf "$RW_TEST_HOME"
```

### 4.5 CLI 调用方式

源码构建后用：

```bash
node packages/runweave-cli/dist/index.js <args>
```

如果后续 package linking 已配置，也可用：

```bash
rw <args>
```

本文统一写成：

```bash
RW="node packages/runweave-cli/dist/index.js"
```

---

## 5. 自动化单元/组件测试

### TC-U01：CLI package build/typecheck/test

命令：

```bash
pnpm --filter ./packages/runweave-cli typecheck
pnpm --filter ./packages/runweave-cli lint
pnpm --filter ./packages/runweave-cli test
pnpm --filter ./packages/runweave-cli build
```

验收：

- 全部 exit code 为 `0`。
- 无 TypeScript error。
- 无 ESLint error。
- Vitest 测试通过。

如果失败：

- 记录失败命令、stderr、失败测试名。
- 判断是否为 CLI 自身问题，而不是环境缺依赖。

### TC-U02：JSON output formatter

目标：验证 `--json` 输出只包含合法 JSON。

建议补/确认单测覆盖：

- `writeOutput(stdout, "json", payload)` 输出可被 `JSON.parse`。
- JSON 后只有一个换行，无额外 warning/progress。
- plain 输出不是 JSON 也没关系。

验收：

```text
stdout parseable as exactly one JSON value
stderr empty or只含测试框架输出
```

### TC-U03：profile-store 权限与 token 安全

目标：验证登录后配置文件权限和内容。

测试点：

- config 写到 `$HOME/.runweave/config.json`。
- 文件权限为 `0600`。
- 不保存 password。
- refresh token 不出现在 stdout/stderr。
- `RUNWEAVE_BASE_URL` / `RUNWEAVE_ACCESS_TOKEN` 能覆盖 profile。

命令示例：

```bash
stat -f '%Lp %N' "$HOME/.runweave/config.json"
```

预期：

```text
600 <path>
```

Linux 环境可用：

```bash
stat -c '%a %n' "$HOME/.runweave/config.json"
```

---

## 6. 真实 backend 集成测试：基础闭环

> 这一组是 MVP 主线，必须通过。

### TC-I01：auth login / status

设置：

```bash
export RW="node packages/runweave-cli/dist/index.js"
export BASE_URL="http://127.0.0.1:5001"
```

执行：

```bash
printf '%s\n' "$RUNWEAVE_TEST_PASSWORD" \
  | $RW auth login --base-url "$BASE_URL" --username admin --json \
  > /tmp/rw-login.json 2> /tmp/rw-login.err

echo $?
python3 -m json.tool /tmp/rw-login.json >/dev/null
cat /tmp/rw-login.err
```

如果不想依赖环境变量，可手动输入密码，或者用测试账号。

验收：

- exit code = `0`。
- stdout 是合法 JSON。
- JSON 包含：
  - `profile`
  - `baseUrl`
  - `authenticated: true`
  - `expiresAt`
- stderr 不包含 token / password。

继续验证：

```bash
$RW auth status --json > /tmp/rw-status.json 2> /tmp/rw-status.err
python3 -m json.tool /tmp/rw-status.json >/dev/null
```

验收：

- `authenticated: true`。
- `source` 为 `profile` 或 `env`。

能力暴露点：

- 如果 `auth login` 在非 TTY stdin 下卡住，说明自动化场景不稳定。
- 如果 password prompt 明文回显，记录为安全/体验问题。

---

### TC-I02：project ensure 幂等性

执行：

```bash
PROJECT_JSON_1=$($RW project ensure --name browser-viewer --path "$PWD" --json)
PROJECT_ID_1=$(printf '%s' "$PROJECT_JSON_1" | jq -r '.projectId')

PROJECT_JSON_2=$($RW project ensure --name browser-viewer --path "$PWD" --json)
PROJECT_ID_2=$(printf '%s' "$PROJECT_JSON_2" | jq -r '.projectId')

echo "$PROJECT_ID_1"
echo "$PROJECT_ID_2"
```

验收：

- 两次 exit code 都为 `0`。
- 两次 stdout 都是合法 JSON。
- `PROJECT_ID_1 == PROJECT_ID_2`。
- JSON 中 path 是规范化后的绝对路径。

能力暴露点：

- 如果同一路径重复创建 project，说明 `project ensure` 幂等失败。
- 如果不同大小写/符号链接路径导致重复创建，需要记录路径规范化策略不足。

---

### TC-I03：terminal create / list / show

执行：

```bash
TERMINAL_JSON=$($RW terminal create --project-id "$PROJECT_ID_1" --cwd "$PWD" --runtime auto --json)
TERMINAL_ID=$(printf '%s' "$TERMINAL_JSON" | jq -r '.terminalSessionId')

echo "$TERMINAL_ID"
$RW terminal list --json > /tmp/rw-terminal-list.json
$RW terminal show "$TERMINAL_ID" --json > /tmp/rw-terminal-show.json
```

验收：

- `terminal create` 返回合法 JSON。
- `terminalSessionId` 非空。
- `terminal list` 包含该 terminal。
- `terminal show` 包含：
  - `terminalSessionId`
  - `status`
  - `cwd`
  - `scrollback`
  - `activeCommand` 或可空字段
- 对 tmux 可用环境，metadata 应能显示 tmux 相关信息；如果是 pty fallback，应明确可诊断。

能力暴露点：

- 如果创建 terminal 成功但 `show` 立即 404，说明 session store/创建返回不一致。
- 如果 `cwd` 与传入路径不一致，记录为控制面定位风险。

---

### TC-I04：snapshot JSON / plain

执行：

```bash
$RW terminal snapshot "$TERMINAL_ID" --tail 120 --json > /tmp/rw-snapshot.json
$RW terminal snapshot "$TERMINAL_ID" --tail 120 --plain > /tmp/rw-snapshot.txt
python3 -m json.tool /tmp/rw-snapshot.json >/dev/null
```

验收：

- JSON 可解析。
- JSON 包含原始 session 字段和 `tail`。
- plain 输出只包含 tail 文本，不包含 JSON wrapper。
- `--tail 0` 返回空 tail，exit code 为 `0`。
- 非法 tail：

```bash
$RW terminal snapshot "$TERMINAL_ID" --tail -1 --json
```

预期：

- exit code = `2`。
- 错误走 stderr。

能力暴露点：

- 如果 tail 截取因 ANSI/wrapped lines 造成难读，记录为体验问题，不一定是 blocker。

---

### TC-I05：handoff JSON 是否足够给 Hermes 使用

执行：

```bash
$RW terminal handoff "$TERMINAL_ID" --tail 120 --json > /tmp/rw-handoff.json
python3 -m json.tool /tmp/rw-handoff.json >/dev/null
jq . /tmp/rw-handoff.json
```

最低验收字段：

```text
terminalSessionId
projectId
projectName
cwd
runtimeKind
tmuxSessionName
activeCommand
inferredAgent
inferredState
tail
suggestedCommands
```

Hermes 视角建议字段，如果没有也要记录为能力不足：

```text
sessionStatus
foregroundCommand
inferredWorkloadState
stateConfidence
stateReasons
hookStatus
```

验收：

- `terminalSessionId` 正确。
- `cwd` 正确。
- `tail` 行数不超过 120 行。
- `suggestedCommands` 不包含直接 `tmux` 命令。
- `tmuxSessionName` 只作为诊断字段出现。

能力暴露点：

- 如果只有 `inferredState=working/unknown`，但没有 `stateReasons`，Hermes 需要自己猜状态，记录为 P1 改进。
- 如果 `activeCommand=codex` 时直接推断 `agent_running`，需要进一步用 tail/prompt 验证是否误判。

---

## 7. 真实 backend 集成测试：send 短确认

### TC-S01：发送普通 shell 命令并短确认

执行：

```bash
MARKER="runweave-cli-ok-$(date +%s)"
$RW terminal send "$TERMINAL_ID" \
  --text "echo $MARKER" \
  --enter \
  --confirm short \
  --json \
  > /tmp/rw-send-shell.json 2> /tmp/rw-send-shell.err

SEND_EXIT=$?
python3 -m json.tool /tmp/rw-send-shell.json >/dev/null
jq . /tmp/rw-send-shell.json
cat /tmp/rw-send-shell.err
```

验收：

- exit code = `0`。
- stdout 是合法 JSON。
- stderr 不包含普通日志或 token。
- JSON 包含：
  - `operationId`
  - `terminalSessionId`
  - `transport`
  - `inputAccepted`
  - `inputEnqueued`
  - `runtimeKind`
  - `acceptedAt`
  - `submitted`
  - `confirmMode`
  - `confirmTimeoutMs`
  - `echoObserved`
  - `promptChanged`
  - `observedState`
  - `confirmConfidence`
  - `tailBefore`
  - `tailAfter`
  - `sendStartedAt`
  - `hook`
- `submitted=true`。
- `transport="http"`。
- `inputAccepted=true`。
- `inputEnqueued=true`。
- `tailAfter` 最终应该能看到 `$MARKER` 或命令回显/输出。

关键能力判断：

```text
如果 inputAccepted/inputEnqueued=true，但 tailAfter 完全没有命令或输出，记录为 WARN：HTTP input 投递成功，但短确认没有观察到执行证据。
如果 tailAfter 有 marker、submitted=true、echoObserved=true、confirmConfidence=high，则 TC-S01 通过；不要求旧 WebSocket 字段。
如果 HTTP input 返回 4xx/5xx 但命令实际执行了，记录为 P1：服务端投递状态与实际 runtime 行为不一致。
```

---

### TC-S02：`--confirm none` 快速返回

执行：

```bash
MARKER="runweave-cli-none-$(date +%s)"
$RW terminal send "$TERMINAL_ID" \
  --text "echo $MARKER" \
  --enter \
  --confirm none \
  --json \
  > /tmp/rw-send-none.json

python3 -m json.tool /tmp/rw-send-none.json >/dev/null
jq . /tmp/rw-send-none.json
```

验收：

- exit code = `0`。
- `confirmMode="none"`。
- `confirmTimeoutMs=0`。
- 不要求 `echoObserved=true` 或 `confirmConfidence=high`。
- 仍要求 `transport="http"`、`inputAccepted=true`、`inputEnqueued=true`。
- 仍应该包含 `operationId`、`tailBefore`、`tailAfter`。

能力暴露点：

- 如果 `confirm none` 仍等待 3 秒，说明 confirm mode 未生效。
- 如果 `tailAfter` 读取过早导致没有任何变化，不算失败，但应该记录为 expected behavior。

---

### TC-S03：stdin 多行中文输入

执行：

```bash
cat > /tmp/rw-stdin-message.txt <<'EOF'
echo "第一行中文 ✅"
echo "second line"
EOF

$RW terminal send "$TERMINAL_ID" \
  --stdin \
  --enter \
  --confirm short \
  --json \
  < /tmp/rw-stdin-message.txt \
  > /tmp/rw-send-stdin.json

python3 -m json.tool /tmp/rw-send-stdin.json >/dev/null
jq . /tmp/rw-send-stdin.json
```

验收：

- exit code = `0`。
- 中文/emoji 不导致 CLI 崩溃。
- `tailAfter` 可观察到至少部分输入或输出。
- JSON 不因 Unicode 破坏解析。

能力暴露点：

- 多行文本在 shell 中可能逐行执行；在 Codex TUI 中可能作为 prompt 输入。记录不同 runtime/TUI 行为。
- 如果 echo 检测只匹配前 32 字符，长文本可能 `echoObserved=false`，不一定失败。

---

### TC-S04：stdin 超过 256 KiB

执行：

```bash
python3 - <<'PY' >/tmp/rw-big-stdin.txt
print('x' * (257 * 1024))
PY

$RW terminal send "$TERMINAL_ID" --stdin --enter --json < /tmp/rw-big-stdin.txt \
  > /tmp/rw-big-out.json 2> /tmp/rw-big-err.txt

echo $?
cat /tmp/rw-big-err.txt
```

验收：

- exit code = `2`。
- stderr 包含类似：`stdin input exceeds 256 KiB limit`。
- stdout 为空或不包含伪成功 JSON。

---

### TC-S05：不存在 terminal id

执行：

```bash
$RW terminal show does-not-exist --json > /tmp/rw-show-missing.json 2> /tmp/rw-show-missing.err
SHOW_EXIT=$?
$RW terminal send does-not-exist --text "echo no" --enter --json > /tmp/rw-send-missing.json 2> /tmp/rw-send-missing.err
SEND_EXIT=$?
echo "show=$SHOW_EXIT send=$SEND_EXIT"
cat /tmp/rw-show-missing.err
cat /tmp/rw-send-missing.err
```

验收：

- 按 plan，terminal/session 不存在应 exit code = `4`。
- stderr 有明确错误。
- JSON stdout 不应伪装成功。

能力暴露点：

- 如果当前实现返回 `1` 而不是 `4`，记录为 FAIL/P1：exit code contract 未实现。
- Hermes 依赖稳定 exit code 区分“资源不存在”和“普通失败”。

---

### TC-S06：backend 不可达

执行：

```bash
RUNWEAVE_BASE_URL=http://127.0.0.1:59999 RUNWEAVE_ACCESS_TOKEN=TOKEN_PLACEHOLDER \
  $RW terminal list --json > /tmp/rw-backend-down.json 2> /tmp/rw-backend-down.err

echo $?
cat /tmp/rw-backend-down.err
```

验收：

- exit code 非 `0`。
- stderr 明确 backend/network 连接失败。
- stdout 不包含伪成功 JSON。

建议能力：

- 如果不能细分 network error，目前 exit code `1` 可接受；但文档应说明。

---

### TC-S07：认证失败 / token 失效

执行：

```bash
RUNWEAVE_BASE_URL="$BASE_URL" RUNWEAVE_ACCESS_TOKEN=bad-token \
  $RW terminal list --json > /tmp/rw-auth-fail.json 2> /tmp/rw-auth-fail.err

echo $?
cat /tmp/rw-auth-fail.err
```

验收：

- exit code = `3`。
- stderr 明确 Unauthorized/authentication failed。
- stdout 不包含伪成功 JSON。

能力暴露点：

- 如果返回 `1`，记录为 P1：auth failure 无法稳定区分。

---

## 8. Codex / AI CLI 场景探索测试

> 这组测试用于验证 Hermes/Feishu 实际 handoff 场景。它不是要求 CLI 等待任务完成，而是看投递和上下文是否足够。

### TC-A01：向 Codex TUI 投递“继续”类 prompt

前提：目标 terminal 已经运行 Codex/Coco/Claude TUI，并处于等待输入状态。

执行：

```bash
$RW terminal handoff "$CODEX_TERMINAL_ID" --tail 120 --json > /tmp/rw-codex-handoff-before.json

$RW terminal send "$CODEX_TERMINAL_ID" \
  --text "请总结当前仓库状态，不要修改文件；完成后通过现有 hook 通知。" \
  --enter \
  --confirm short \
  --json \
  > /tmp/rw-codex-send.json

$RW terminal snapshot "$CODEX_TERMINAL_ID" --tail 120 --json > /tmp/rw-codex-snapshot-after.json
```

验收：

- `handoff` 中能看到 `activeCommand` 或 tail 显示 Codex/Coco/Claude。
- `send` exit code = `0`。
- `send` 返回 `operationId`。
- `tailAfter` 或之后 snapshot 能看到输入进入 TUI，或看到 `Working` / 等价运行态。
- CLI 不阻塞等待 Codex 完成。

能力暴露点：

- 如果 `activeCommand=codex` 但实际是等待输入，`inferredState` 不能盲目说 `agent_running`。
- 如果输入只被粘贴但未提交，说明 `--enter` / `\r` 语义不可靠。
- 如果 Codex 完成通知没有携带 operationId，记录为已知弱关联。

---

### TC-A02：验证 completion hook 弱关联边界

目标：确认当前 CLI 不应把 completion event 当成强因果完成。

步骤：

1. 在同一 Codex terminal 连续投递两条不同 `operationId` 的 prompt。
2. 观察 completion event / 飞书完成通知。
3. 检查通知是否能区分对应哪一次投递。

验收：

- 如果 completion event 只能显示 `terminalSessionId/source/createdAt`，记录为 WARN：hook correlation 是弱关联。
- 如果通知能显示 operationId，则记录为 PASS，并建议把该能力写入 CLI/Hook 契约。

---

## 9. 并发与误投递风险测试

### TC-C01：两个 CLI 同时 send 同一 terminal

执行：

```bash
MARKER1="parallel-one-$(date +%s)"
MARKER2="parallel-two-$(date +%s)"

$RW terminal send "$TERMINAL_ID" --text "echo $MARKER1" --enter --confirm short --json > /tmp/rw-parallel-1.json &
PID1=$!
$RW terminal send "$TERMINAL_ID" --text "echo $MARKER2" --enter --confirm short --json > /tmp/rw-parallel-2.json &
PID2=$!
wait $PID1; E1=$?
wait $PID2; E2=$?
echo "exit1=$E1 exit2=$E2"

$RW terminal snapshot "$TERMINAL_ID" --tail 200 --plain > /tmp/rw-parallel-tail.txt
cat /tmp/rw-parallel-tail.txt
```

验收：

- CLI 不崩溃。
- JSON 都可解析，或其中一个明确失败。
- tail 中两条命令不应被拼接成损坏输入。

能力暴露点：

- 如果两条输入交错，记录为 P1/P2：需要 caller-side serialization 或 server-side write lock。
- 如果当前 MVP 不提供锁，文档必须明确：同一 terminal 的写入由 Hermes/OpenClaw 串行化。

---

## 10. 输出协议与 exit code 契约测试

### TC-O01：JSON stdout 严格性

对所有 `--json` 命令执行：

```bash
for file in /tmp/rw-*.json; do
  echo "checking $file"
  python3 -m json.tool "$file" >/dev/null || exit 1
done
```

验收：

- 所有成功命令 stdout 都能 parse。
- stderr 可以有错误，但成功路径最好为空。
- 不允许 stdout 混入 warning、progress、stack trace。

### TC-O02：exit code 表

测试并记录：

| 场景                       | 期望 exit code | 实际 exit code | 结论 |
| -------------------------- | -------------: | -------------: | ---- |
| 参数错误                   |              2 |            TBD | TBD  |
| 认证失败                   |              3 |            TBD | TBD  |
| terminal 不存在            |              4 |            TBD | TBD  |
| backend 不可达             |              1 |            TBD | TBD  |
| send 成功但 low confidence |              0 |            TBD | TBD  |
| stdin 超限                 |              2 |            TBD | TBD  |

如果实际 exit code 与 plan 不一致，需要明确是：

- 修改 CLI；或
- 修改 plan/文档，避免 Hermes 依赖错误契约。

---

## 11. 安全测试

### TC-SEC01：token 不泄露到 stdout/stderr

执行登录、status、terminal list/show/send 后：

```bash
grep -R "TOKEN_PLACEHOLDER\|refreshToken\|accessToken" /tmp/rw-*.json /tmp/rw-*.err 2>/dev/null || true
```

验收：

- `auth login` stdout 不应输出 accessToken/refreshToken。
- `terminal` 命令 stdout/stderr 不应输出 token。
- config 文件中可以保存 token，但权限必须 `0600`。

### TC-SEC02：profile 文件权限

执行：

```bash
ls -l "$HOME/.runweave/config.json"
```

macOS：

```bash
stat -f '%Lp %N' "$HOME/.runweave/config.json"
```

验收：

- mode = `600`。

### TC-SEC03：明确 agent token 能力缺口

当前若 CLI 只能使用完整登录态 refresh token，测试报告应记录：

```text
WARN：本地人类 CLI 可接受；Hermes/OpenClaw/CI 长期集成建议引入 scoped/capability token，限制 terminalId/projectId/scope/TTL。
```

这不是当前 MVP 必须失败项，但应作为上线前安全风险进入 backlog。

---

## 12. 测试中需要主动暴露的能力不足

测试报告中请专门列出下面能力是否存在：

| 能力                                 | 当前是否具备 | 如果不具备的影响                             |
| ------------------------------------ | ------------ | -------------------------------------------- |
| WS input ack                         | TBD          | 无法强证明 backend/runtime 已接收输入        |
| operationId 写入 prompt/context      | TBD          | Feishu/Codex completion 难以强关联本次投递   |
| hook event 回传 operationId          | TBD          | completion 只能 terminal/time/source 弱关联  |
| handoff stateReasons/stateConfidence | TBD          | Hermes 需要自己猜 workload 状态              |
| same-terminal write lock             | TBD          | 多 agent 并发 send 可能交错                  |
| scoped/capability token              | TBD          | 外部 agent 持有完整用户权限，blast radius 大 |
| stable exit code 3/4                 | TBD          | Hermes 无法稳定区分 auth/resource failure    |
| JSON stdout strict                   | TBD          | Hermes/OpenClaw parse 失败                   |

---

## 13. 推荐测试执行顺序

```text
Stage 0：静态和单元测试
  -> typecheck / lint / vitest / build

Stage 1：认证和配置
  -> auth login/status / config 权限 / token 不泄露

Stage 2：HTTP 控制面
  -> project ensure / terminal create/list/show/snapshot/handoff

Stage 3：HTTPS input send
  -> shell echo / confirm none / confirm short / stdin / unicode / oversized stdin

Stage 4：错误路径
  -> terminal missing / auth failed / backend down / invalid args

Stage 5：Hermes/Codex 实战探索
  -> handoff Codex terminal / send prompt / observe short confirm / wait for external hook notification

Stage 6：风险探索
  -> concurrent send / weak hook correlation / low confidence behavior
```

---

## 14. 最终验收标准

### 14.1 MVP 必须通过

- `pnpm --filter ./packages/runweave-cli build/test/typecheck` 通过。
- `auth login/status` 可用，配置文件权限正确。
- `project ensure` 幂等。
- `terminal create/list/show/snapshot/handoff` 可用且 JSON 可解析。
- `terminal send --confirm short --json` 能向 shell terminal 投递 `echo` 命令，并在 `tailAfter` 中看到证据。
- 所有 `--json` 成功输出 stdout 都是合法 JSON。
- token 不泄露到 stdout/stderr。
- 不存在 terminal、认证失败、参数错误有稳定 exit code。

### 14.2 Hermes 默认接入条件

满足下面条件后，Hermes 可以默认走 `rw` CLI，而不是直接操作 tmux：

- Hermes 能通过 `handoff` 获取 terminal/cwd/tail/agent 状态上下文。
- Hermes 能通过 `send --confirm short --json` 投递指令。
- `send` 返回 `operationId`、`tailBefore`、`tailAfter`、`confirmConfidence`。
- low confidence 不伪装成 high confidence。
- CLI 不长时间阻塞等待 Codex 完成。
- 完成通知仍由 Codex hook / Feishu 承担。

### 14.3 上线前建议修复项

如果测试暴露以下问题，建议上线前修：

1. JSON stdout 混入非 JSON 内容。
2. terminal missing/auth failed exit code 不稳定。
3. `send --enter` 不能可靠提交到 shell/TUI。
4. token 出现在 stdout/stderr。
5. config 文件权限不是 `0600`。
6. `project ensure` 非幂等。

### 14.4 可以进入 backlog 的非阻塞项

- WS `input-ack`。
- operationId 写入 prompt/context 并由 hook 回传。
- handoff 增加 `stateReasons` / `stateConfidence`。
- same-terminal write lock / expected-state guard。
- scoped/capability token。
- `exec --wait completion/idle/stream`。

---

## 15. 测试报告模板

建议测试后生成：

```markdown
# Runweave CLI 测试报告

日期：YYYY-MM-DD
测试人：...
commit：...
backend baseUrl：...
CLI invocation：node packages/runweave-cli/dist/index.js

## 总结

- 总体结论：PASS / WARN / FAIL
- Hermes 是否可以默认使用 rw CLI：是 / 否 / 有条件
- 主要风险：...

## 环境

- macOS / Linux：...
- Node：...
- pnpm：...
- backend port：...
- runtimeKind：tmux / pty

## 用例结果

| Case   | 结果 | 证据文件 | 备注                                          |
| ------ | ---- | -------- | --------------------------------------------- |
| TC-U01 | PASS | ...      | ...                                           |
| TC-I01 | PASS | ...      | ...                                           |
| TC-S01 | PASS | ...      | HTTPS input 字段符合预期，tailAfter 有 marker |

## 发现的问题

### P0

- ...

### P1

- ...

### P2

- ...

## 建议

- Hermes 接入策略：...
- CLI 修复建议：...
- 后端协议建议：...
```

---

## 16. 一键冒烟脚本草案

> 下面脚本是草案，真实密码/账号需要按本地环境替换。建议先手动跑前面的步骤，再固化成 `scripts/smoke-runweave-cli.mjs` 或 bash 脚本。

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /Users/bytedance/Code/browser-hub/browser-viewer
export RW="node packages/runweave-cli/dist/index.js"
export BASE_URL="${BASE_URL:-http://127.0.0.1:5001}"
export HOME="${RW_TEST_HOME:-$(mktemp -d /tmp/runweave-cli-test-home.XXXXXX)}"

pnpm --filter ./packages/runweave-cli build
pnpm --filter ./packages/runweave-cli test

printf '%s\n' "${RUNWEAVE_TEST_PASSWORD:?set RUNWEAVE_TEST_PASSWORD}" \
  | $RW auth login --base-url "$BASE_URL" --username "${RUNWEAVE_TEST_USERNAME:-admin}" --json \
  | tee /tmp/rw-login.json \
  | python3 -m json.tool >/dev/null

$RW auth status --json | tee /tmp/rw-status.json | python3 -m json.tool >/dev/null

PROJECT_ID=$($RW project ensure --name browser-viewer --path "$PWD" --json | tee /tmp/rw-project.json | jq -r '.projectId')
TERMINAL_ID=$($RW terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --runtime auto --json | tee /tmp/rw-terminal-create.json | jq -r '.terminalSessionId')

$RW terminal list --json | tee /tmp/rw-terminal-list.json | python3 -m json.tool >/dev/null
$RW terminal show "$TERMINAL_ID" --json | tee /tmp/rw-terminal-show.json | python3 -m json.tool >/dev/null
$RW terminal handoff "$TERMINAL_ID" --tail 120 --json | tee /tmp/rw-handoff.json | python3 -m json.tool >/dev/null

MARKER="runweave-cli-smoke-$(date +%s)"
$RW terminal send "$TERMINAL_ID" --text "echo $MARKER" --enter --confirm short --json \
  | tee /tmp/rw-send.json \
  | python3 -m json.tool >/dev/null

$RW terminal snapshot "$TERMINAL_ID" --tail 120 --plain | tee /tmp/rw-tail.txt
grep "$MARKER" /tmp/rw-tail.txt

echo "Runweave CLI smoke PASS: terminal=$TERMINAL_ID marker=$MARKER"
```

---

## 17. 最终建议

测试过程中不要只追求全部 PASS。这个 CLI 是给 Hermes/OpenClaw 作为控制面用的，测试的价值包括主动暴露能力边界。

特别是下面三类结果，即使命令 exit code 为 0，也应该记录：

1. **语义弱但可用：** 例如 `inputEnqueued=true` 只代表 backend 已写入或入队，不代表 AI CLI 已完成任务。
2. **Hermes 需要防御：** 例如 `confirmConfidence=low`，Hermes 应回复“已投递但无法确认执行态”。
3. **需要后续协议增强：** 例如 operationId 没进入 hook payload，completion 只能弱关联。

只要这些边界被清楚记录，CLI 就可以先作为 Hermes 的默认投递通道逐步 dogfood；后续再补 hook operationId、scoped token、并发锁和更强的 completion 关联。
