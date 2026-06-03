# 终端任务完成通知链路

本文描述 Runweave 如何在 Codex、Coco/Trae、Claude 等 AI CLI 任务完成时，向用户发出**主动通知**（macOS 系统通知 + 声音、飞书消息）。

本文是 [terminal-completion-hooks.md](./terminal-completion-hooks.md) 的 **channel 细节补充**。canonical 的 hook 架构与 launcher 职责（含身份门禁、launcher 是否允许做通知副作用）以那篇为准；本文只展开通知 channel（桌面/声音/飞书）的实现、脚本与配置。两者共用同一条 hook 链路与同一个 launcher。

## 背景

绿点（completion marker）只在 Runweave 前端打开时可见。用户经常切走窗口、锁屏或在手机上等结果，此时需要更主动的提醒：

- macOS 系统通知 + 提示音：本机弹窗，离开 Runweave 窗口也能看到。
- 飞书消息：推到飞书群/机器人，手机上也能收到，并附带最后一条 AI 回复和终端 ID，便于用 `rw` CLI 远程接管。

这两类通知都挂在“任务完成”这个语义上，不针对普通命令结束。

## 单一实现：全部走 launcher

历史上存在两套实现（codex 走本机 `~/.codex/` 脚本，coco/trae 走 launcher 内联），导致逻辑分裂、重复通知、飞书脚本散落本机不归仓库管。现已统一为**唯一实现**：

> 所有来源（codex / coco / trae / claude）的桌面通知 + 声音 + 飞书，全部由 Runweave 的 launcher `~/.browser-viewer/bin/browser-viewer-hook-bridge` 负责，不再有任何 `source === "codex"` 特判。

```text
AI CLI 任务完成
  -> CLI hook 执行 browser-viewer-hook-bridge --source <src>
    -> launcher 确认是完成事件(STOP_EVENTS)
      -> 校验 RUNWEAVE_* 身份(endpoint/token/terminalSessionId)
         缺任一 -> 静默退出，不通知、不上报
      -> notifyDesktop(source)              # osascript 通知 + afplay 声音 (macOS)
      -> notifyFeishu(payload, source)      # 转调 ~/.browser-viewer/hooks/feishu_stop_notify.sh
      -> POST /internal/terminal-completion # 绿点上报
```

hook 安装进用户全局 Claude/Codex/Trae 配置，会覆盖所有 AI CLI（含 Runweave 之外的终端）。因此通知与上报都以 `RUNWEAVE_*` 身份为门禁：**只有从 Runweave terminal 启动、pane 带有 `RUNWEAVE_HOOK_ENDPOINT` / `RUNWEAVE_HOOK_TOKEN` / `RUNWEAVE_TERMINAL_SESSION_ID` 的完成事件才会触发桌面通知和飞书**；外部终端的 AI CLI stop 事件静默退出，不产生任何通知。这样隐私与噪声边界由已认证的 Runweave session 控制。

## 飞书脚本随仓库分发

飞书发送脚本是仓库源码的一部分，不再依赖本机 `~/.codex/hooks/`：

- **源文件**：`electron/resources/hooks/feishu_stop_notify.sh`，随 `resources/**` 打进 asar（与 app 图标同机制，无需改打包配置）。
- **安装拷贝**：Electron 启动时 `installNotifyAssets()` 把它 `copyFile` 到 `~/.browser-viewer/hooks/feishu_stop_notify.sh` 并 `chmod 0755`。
- **launcher 调用**：`notifyFeishu` 调 `~/.browser-viewer/hooks/feishu_stop_notify.sh`，存在才执行，stdin 传入原始 payload（注入正确 `source`）。

### 飞书脚本核心流程

1. 从 stdin 读 payload JSON，只处理 `Stop` / `SubagentStop` 事件，其它直接 `return 0`。
2. `source ~/.browser-viewer/feishu_notify.env` 加载敏感配置（见下）；env 缺失则静默 `return 0`。
3. 从 payload 取 `cwd`、`session_id`、`source`，按 `source` 映射 agent 名（codex→Codex，coco/trae→Coco，claude→Claude）。
4. 取最后一条 assistant 回复：优先 payload 的 `transcript_path`，否则按 `~/Library/Caches/coco/sessions/<session_id>/events.jsonl` 兜底，截断 2500 字。
5. 解析终端 ID：payload 的 `terminalId`/`terminalSessionId` 优先，否则 fallback 到 `RUNWEAVE_TERMINAL_SESSION_ID`/`RUNWEAVE_TMUX_SESSION_NAME`，再 fallback 到 `tmux display-message`。
6. 拼成文本，调飞书群机器人 webhook（支持 HMAC-SHA256 加签）。
7. 全程错误只写 `~/.browser-viewer/feishu_notify.log`，不影响 CLI。

### 敏感配置（env 控制、默认静默）

webhook 地址和密钥**不进仓库**，放在本机 `~/.browser-viewer/feishu_notify.env`，由脚本 `source` 进来：

```bash
FEISHU_WEBHOOK_URL=<飞书群机器人 webhook 地址>
FEISHU_WEBHOOK_SECRET=<加签密钥，可选>
FEISHU_NOTIFY_DEBUG_PAYLOAD="0"
```

未配置该文件（或缺 `FEISHU_WEBHOOK_URL`）时飞书静默跳过，不报错；桌面通知与绿点不受影响。

### 运行依赖

飞书脚本依赖 `jq` 解析 payload，依赖 `openssl`（默认 `/opt/homebrew/bin/openssl`，否则回退 `PATH`）做加签。**macOS 默认不带 `jq`**，缺失时脚本会在 `~/.browser-viewer/feishu_notify.log` 记录 `skip: jq missing` 并静默跳过——表现为 env 配好了却收不到飞书消息。需 `brew install jq`。排查飞书不发时，先看该日志。

## launcher 关键函数

launcher 由 `electron/src/hooks/hook-installer.ts` 的 `buildLauncherScript()` 生成（自包含 Node 脚本），改动入口在该函数，而非手改本机文件。

- **`notifyDesktop(source)`**：仅 macOS。按 source 映射标题（Codex/Claude/Trae），`osascript` 弹 “<Name> 完成了 / 回来接管终端”，`afplay` 播放 `Glass.aiff`。子进程 `detached` + `unref`，失败静默。**无 codex 特判**。
- **`notifyFeishu(payload, source)`**：调 `~/.browser-viewer/hooks/feishu_stop_notify.sh`，存在才执行，stdin 传 payload。**无 codex 特判**。

## codex 旧条目清理

早期接入曾在 `~/.codex/hooks.json` 注册过 `notify.sh` / `feishu_stop_notify.sh`，与现在 launcher 统一负责的通知重复。`installCodexHooks()` 安装时调用 `pruneSupersededCodexHooks()`，移除命令指向 `notify.sh` / `feishu_stop_notify.sh` 的旧条目（保留所有第三方 hook 与 launcher hook），避免双发。

> 边界：用户自带的 `~/.codex/config.toml` 的 `notify`（turn-ended → notify.sh）属用户自有配置，本方案不改它。若用户保留该项，codex 桌面通知可能仍叠加一遍；如需彻底只响一遍，由用户自行关闭 config.toml 的 notify。

## 关键代码路径

- launcher 生成 + 脚本拷贝 + codex 清理：`electron/src/hooks/hook-installer.ts`（`buildLauncherScript` / `installNotifyAssets` / `pruneSupersededCodexHooks`）
- 飞书脚本源文件：`electron/resources/hooks/feishu_stop_notify.sh`
- 安装入口注入 resourcesDir：`electron/src/main.ts`（`installHooksIfNeeded({ resourcesDir })`）
- 测试：`electron/src/hooks/hook-installer.test.ts`
- 前端绿点收到完成事件时的提示音：`frontend/src/components/terminal/terminal-workspace.tsx`、`frontend/src/features/terminal/bell.ts`

## 验证

单元层：

```bash
pnpm --filter ./electron test
```

端到端（macOS，需 `~/.browser-viewer/feishu_notify.env` 配好 webhook）：

1. `pnpm dev:electron` 启动，使 launcher 与脚本被重写/拷贝为最新。
2. 确认拷贝：`ls -l ~/.browser-viewer/hooks/feishu_stop_notify.sh`（存在且可执行）。
3. 模拟各来源完成事件，验证每次只通知一遍。launcher 受 `RUNWEAVE_*` 身份门禁保护，必须在**带身份的上下文**里执行，否则会静默退出（这是预期行为，见第 6 步）。

   方式 A（推荐，最贴近真实路径）：在一个 Runweave terminal pane 内直接执行——该 pane 已自带 `RUNWEAVE_*`：

   ```bash
   printf '{"hook_event_name":"Stop","source":"codex","cwd":"'"$PWD"'","last_assistant_message":"验证"}' \
     | ~/.browser-viewer/bin/browser-viewer-hook-bridge --source codex
   # 同样替换 --source trae / --source claude
   ```

   方式 B（在普通 shell 手动模拟）：显式导出身份再执行。`RUNWEAVE_HOOK_TOKEN` 是敏感值，请从目标 Runweave pane 里用 `env | grep '^RUNWEAVE_'` 读取真值，不要外泄或贴进公开日志：

   ```bash
   export RUNWEAVE_HOOK_ENDPOINT='http://127.0.0.1:<backend-port>/internal/terminal-completion'
   export RUNWEAVE_HOOK_TOKEN='<从目标 pane 的 env 读取>'
   export RUNWEAVE_TERMINAL_SESSION_ID='<目标 terminal session id>'
   printf '{"hook_event_name":"Stop","source":"codex","cwd":"'"$PWD"'","last_assistant_message":"验证"}' \
     | ~/.browser-viewer/bin/browser-viewer-hook-bridge --source codex
   ```

   预期：每次一条 “<Name> 完成了” 系统通知 + 一次 Glass 声音 + 一条飞书消息（env 配了的话）。

4. 确认 codex 不再双发：检查 `~/.codex/hooks.json` 已无 `notify.sh` / `feishu_stop_notify.sh` 条目。
5. 未配置飞书 env 时：通知与声音正常，飞书静默跳过、无报错。
6. 身份门禁负向验证（回归护栏）：在**不带任何 `RUNWEAVE_*`** 的普通 shell 里执行第 3 步的 `printf | launcher`，预期**完全静默**——无系统通知、无声音、无飞书、不向 backend 上报。若此时仍发出通知，说明门禁被放宽，是回归。

## 设计取舍

- 单一实现（全部走 launcher）：消除两套逻辑与 codex 特判，随 Runweave 发布统一更新。
- 飞书脚本纳入仓库 + 安装拷贝：脚本可版本管理、随应用分发；密钥仍只在本机 env，不进仓库。
- codex 自带 config.toml notify 属用户配置，不动；launcher + hooks.json 侧保证不重复。
- 桌面通知目前仅 macOS；其他平台不发系统通知，但绿点与飞书不受影响。
- 通知失败一律静默，绝不阻塞 AI CLI 的任务结束流程。
