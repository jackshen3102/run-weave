# 2026-06-03 Terminal Completion Notifications Review

评审范围：当前工作树相对 HEAD 的整体变更，覆盖 terminal completion event 合约、Electron hook installer、launcher 通知链路、飞书脚本、前端绿点/E2E 变更和新增/更新文档。

评审模式：强力模式。原因：变更跨 shared 协议、backend 内部接口、Electron 全局 hook 安装、用户本机配置、前端行为和 E2E。

验证证据：

- `git status --short --branch`：当前分支 `codex/daily-refactor-20260520-0100`，14 个 staged 文件，另有 4 个 tracked 文件存在 unstaged 修改，`docs/review/` 为评审报告目录。
- `git diff HEAD --check -- . ':(exclude)docs/review'`：无 whitespace 错误。
- 已阅读当前工作树 diff、相关现有文档和测试。
- 已用飞书开放平台官方文档核对自定义机器人签名算法。

上一轮 P1 复核结果：

- “全局 AI CLI hook 在非 Runweave 终端也会发通知”已在当前代码中修正：launcher 现在先检查 `RUNWEAVE_HOOK_ENDPOINT`、`RUNWEAVE_HOOK_TOKEN`、`RUNWEAVE_TERMINAL_SESSION_ID`，缺任一则不通知、不上报。
- “Codex 旧 hook 清理按子串误删用户配置”已明显收窄：当前只匹配 `~/.codex/hooks/feishu_stop_notify.sh` 与 `~/.codex/notify.sh` 两个已知旧路径，并补了第三方同名脚本保留测试。
- “hook 架构文档职责冲突”已缓解：`terminal-completion-hooks.md` 现在成为 canonical 文档，并同步了通知副作用和身份门禁。

## 架构 / 策略发现

### P2 - 文档里的端到端验证命令会被新身份门禁静默拦截

当前决策：launcher 的所有副作用都被 `RUNWEAVE_*` 身份门禁保护，缺少 endpoint/token/terminalSessionId 时直接返回；但通知文档仍提供一个直接 pipe 到 `~/.runweave/bin/runweave-hook-bridge --source codex` 的模拟命令，并预期会产生系统通知、声音和飞书消息。

为什么系统层面可能是错的：当前手工验收步骤验证不到真实系统行为。它会在缺少 `RUNWEAVE_*` 的普通 shell 中静默退出，用户按文档执行会以为通知链路坏了；更糟的是，这个验收步骤无法覆盖刚修复的身份门禁边界，后续回归时可能重新放宽门禁而文档测试仍看不出来。

证据：

- `electron/src/hooks/hook-installer.ts:269` 到 `electron/src/hooks/hook-installer.ts:278`：launcher 缺少 `RUNWEAVE_HOOK_ENDPOINT`、`RUNWEAVE_HOOK_TOKEN` 或 `RUNWEAVE_TERMINAL_SESSION_ID` 时直接返回。
- `docs/architecture/terminal-completion-notifications.md:100` 到 `docs/architecture/terminal-completion-notifications.md:102`：文档示例直接 pipe 到 launcher，没有设置任何 `RUNWEAVE_*`。
- `docs/architecture/terminal-completion-notifications.md:106`：文档预期该命令会触发通知和飞书。

更好的候选方案：

1. 推荐：把手工验收改成“在 Runweave terminal pane 内执行”，或显式导出 `RUNWEAVE_HOOK_ENDPOINT`、`RUNWEAVE_HOOK_TOKEN`、`RUNWEAVE_TERMINAL_SESSION_ID` 的完整模拟命令。
2. 更稳妥：提供 backend/API 层诊断命令，先确认当前 pane 有身份，再模拟 stop payload。
3. 平台默认方案：让 Runweave UI/CLI 暴露一个“发送测试完成事件”动作，由系统自己补齐身份上下文，而不是让用户手拼环境变量。

迁移/过渡风险：仅修改文档/诊断入口风险低。若提供手工 env 示例，要避免把真实 hook token 粘贴进公开日志。

### P3 - 当前架构没有真正验证 launcher 运行时门禁，只验证字符串存在

当前决策：新增测试主要检查生成脚本文本包含 `RUNWEAVE_*`、`notifyDesktop`、`notifyFeishu` 等字符串；没有实际执行生成后的 launcher，验证“缺 Runweave 身份不通知、不上报”和“有身份才通知/上报”的行为。

为什么系统层面可能是错的：launcher 是一个由 TypeScript 拼接生成的自包含 Node 脚本，关键边界在运行时分支顺序。字符串包含测试不能证明通知一定在身份门禁之后，也不能证明非 stop 事件、缺 token、缺 terminal id 的副作用为零。这类全局 hook 安装代码一旦回归，影响的是用户全局 AI CLI 配置。

证据：

- `electron/src/hooks/hook-installer.test.ts:216` 到 `electron/src/hooks/hook-installer.test.ts:235`：测试只做字符串匹配。
- `electron/src/hooks/hook-installer.ts:259` 到 `electron/src/hooks/hook-installer.ts:301`：关键行为全在生成脚本运行时分支中。

更好的候选方案：

1. 推荐：把生成后的 launcher 写到临时文件，用 fake `RUNWEAVE_*`、fake endpoint 和 fake Feishu script 做行为测试；至少覆盖缺身份不执行通知、非 stop 不执行通知、有身份会 POST。
2. 更简单：把 launcher 逻辑拆成可测试的小 JS 模块，再由 `buildLauncherScript()` 嵌入。
3. 平台默认方案：用 Electron hook installer 的集成测试跑临时 HOME + 临时 backend，验证安装后真实 hook 命令行为。

迁移/过渡风险：真实执行测试需要避免触发 macOS `osascript` / `afplay`；可以通过 PATH/环境变量注入 fake 可执行文件或把通知 command 做成测试可替换。

## 代码 / 实现发现

### P2 - 飞书加签算法实现与官方自定义机器人算法不一致

风险：配置 `FEISHU_WEBHOOK_SECRET` 后，脚本会用 secret 作为 HMAC key、用 `timestamp + "\n" + secret` 作为消息体计算签名。飞书自定义机器人签名校验要求把 `timestamp + "\n" + 密钥` 作为 HMAC key，对空字符串计算 HMAC-SHA256 后 Base64。当前实现会导致开启签名校验的 webhook 返回签名失败，飞书通知不可用。

证据：

- `electron/resources/hooks/feishu_stop_notify.sh:167`：当前 `openssl dgst -sha256 -hmac "$FEISHU_WEBHOOK_SECRET"` 的 key 是 secret，stdin 是 `timestamp\nsecret`。
- `electron/resources/hooks/feishu_stop_notify.sh:185` 到 `electron/resources/hooks/feishu_stop_notify.sh:188`：脚本只记录非 0 code，功能层面会表现为静默失败。
- 飞书开放平台《自定义机器人使用指南》签名校验部分说明：将 `timestamp + "\n" + 密钥` 作为签名字符串，使用 HmacSHA256 计算空字符串签名结果，再 Base64。

修复方向：把签名 key 改为 `timestamp + "\n" + FEISHU_WEBHOOK_SECRET`，对空 payload 做 HMAC；同时为签名函数加最小可执行验证，避免只靠字符串包含断言。

### P2 - 飞书脚本硬依赖 `jq`，但文档和安装器没有暴露运行前提

风险：macOS 默认不带 `jq`。当前脚本在缺少 `jq` 时会直接跳过飞书通知，但新文档的配置说明只要求 webhook env，没有说明还需要 `jq`。这会让用户完成 env 配置后仍然收不到飞书消息，只能去隐蔽日志里排查。

证据：

- `electron/resources/hooks/feishu_stop_notify.sh:18` 到 `electron/resources/hooks/feishu_stop_notify.sh:20`：没有 `jq` 时 JSON 读取只能返回 fallback。
- `electron/resources/hooks/feishu_stop_notify.sh:203` 到 `electron/resources/hooks/feishu_stop_notify.sh:206`：加载配置后发现没有 `jq` 直接跳过。
- `docs/architecture/terminal-completion-notifications.md:53` 到 `docs/architecture/terminal-completion-notifications.md:63`：配置说明没有列出 `jq` 依赖。

修复方向：优先用 launcher 的 Node 运行时完成 JSON 解析、消息体生成和签名，避免 shell 脚本依赖外部 `jq`。如果保留 bash 脚本，文档和安装诊断必须明确检查 `jq`，并在配置缺依赖时给用户可见提示。

### P3 - E2E 的“普通命令结束不点绿点”断言可能假阳性

风险：测试输入 `sleep 2` 后切到另一个 project，只固定等待 2.5 秒就断言没有绿点。慢机器或 CI 抖动时，`sleep` 可能尚未完成或前端尚未收到 `activeCommand=null` metadata，测试仍会通过，因此它不能稳定证明“普通 shell command exit 不会点亮绿点”。

证据：

- `frontend/tests/terminal.spec.ts:608` 到 `frontend/tests/terminal.spec.ts:618`：只确认 `sleep` active command 出现。
- `frontend/tests/terminal.spec.ts:632` 到 `frontend/tests/terminal.spec.ts:635`：固定等待后直接断言没有绿点，没有先等待 `sleep` 结束状态被前端观察到。

修复方向：先等待 project A 的 tab label 从 `cwd(sleep)` 回到 cwd/project 名，或等待对应 session API 中 `activeCommand === null`，再断言没有 emerald marker。这样才覆盖被删除的 `activeCommand -> null` 回归路径。

## 剩余风险 / 测试缺口

- 未运行完整 `pnpm typecheck`、`pnpm lint` 或 Playwright E2E；本次是只读评审，验证以 diff、源码、文档、官方文档和现有测试阅读为主。
- `TerminalCompletionEvent` 新字段兼容路径基本合理，但后续如果旧前端/旧后端混跑，需要明确兼容窗口和删除 `hookEvent` 的时间点。
- `import.meta.url` 的 CJS shim 看起来是为 `fileURLToPath(import.meta.url)` fallback 服务；当前 main.ts 已显式传 `resourcesDir`，建议后续确认 backend bundle 不会被 shim 影响其它模块，但本轮未发现直接回归证据。
