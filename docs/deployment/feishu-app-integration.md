# 飞书应用通知与 Terminal 话题会话

本文说明如何配置飞书企业自建应用，使一个目标群中的一个 Runweave Terminal ID 对应一个
长期飞书话题。第一条真实 completion 通知是话题 root，后续 completion 都回复同一 root；
白名单用户在该话题内发送纯文本时无需 `@bot`，Bridge 会把输入投递回对应 Terminal。

Bridge 只确认 Backend 是否接受并入队输入，不等待 AI CLI 执行完成。成功时只在用户消息上
添加 `DONE`（✅）reaction；失败时在原话题回复原因。后续 AI completion 由现有 Hook 自然
回到同一话题。

## 工作方式

```text
AI CLI Stop Hook
  → runweave-hook-bridge
  → rw feishu notify
  → 无 topic：发送真实 completion 作为顶层 root
     有 topic：reply root + reply_in_thread
  → v2 state 保存 chat + Terminal → root

目标话题中的用户纯文本
  → 飞书长连接推送 im.message.receive_v1
  → 校验 user + allowlist + group + chat + text + root + thread
  → root 定位 Terminal，Backend 选择当前活动 Panel
  → Terminal Input API（prompt_replace + enter + confirm short）
  → 成功：DONE reaction；失败：原话题文字回执
```

飞书自定义机器人 Webhook 只能保留单向通知，不能参与话题会话或入站投递。

## 一、创建和授权飞书应用

在飞书开放平台创建企业自建应用，开启“机器人”能力并将机器人加入目标群。妥善保存 App ID
和 App Secret，不要写入仓库或日志。

应用至少需要以下权限：

| 用途                                           | 权限                                        |
| ---------------------------------------------- | ------------------------------------------- |
| 发送 completion、话题回复和失败回执            | `im:message:send_as_bot`                    |
| 接收目标群中未 `@bot` 的普通消息并读取消息关系 | “获取群组中所有消息” `im:message.group_msg` |
| 添加成功 reaction                              | `im:message.reactions:write_only`           |

在“事件与回调”中选择“使用长连接接收事件”，订阅“接收消息 v2.0”
`im.message.receive_v1`。权限或事件发生变化后必须重新发布应用版本；仅修改开发后台但未发布，
Bridge 不会收到无 `@bot` 的群消息。

群消息读取范围扩大后，安全边界由 Bridge 收紧：只有目标群、白名单用户、已绑定 Runweave
topic 内的纯文本才可能进入 Terminal。群外、非白名单、未知 root、群顶层、私聊和非文本消息
静默忽略，不写 processed、不查询 Terminal，也不回复权限信息。

## 二、准备 CLI 和 Hook

源码仓库先构建 CLI：

```bash
pnpm --filter @runweave/cli build
node packages/runweave-cli/dist/index.js --version
```

Bridge 使用正常 Runweave 登录态调用 Terminal Input API，不直接操作 tmux：

```bash
rw auth login \
  --base-url http://127.0.0.1:5001 \
  --username <Runweave 用户名>
rw auth status --json
```

Electron 会安装 completion launcher 与飞书脚本。CLI-only 环境可安装仓库运行副本：

```bash
install -d -m 0755 ~/.runweave/bin ~/.runweave/hooks
install -m 0755 electron/resources/hooks/runweave-hook-bridge.cjs \
  ~/.runweave/bin/runweave-hook-bridge
install -m 0755 electron/resources/hooks/feishu_stop_notify.sh \
  ~/.runweave/hooks/feishu_stop_notify.sh
```

仅复制脚本不够；AI CLI 还必须加载 Runweave Stop Hook。完整安装与身份门禁见
[`terminal-completion-hooks.md`](../architecture/terminal-completion-hooks.md)。

## 三、配置

```bash
FEISHU_NOTIFY_TRANSPORT=app
FEISHU_APP_ID=<飞书应用 App ID>
FEISHU_APP_SECRET=<飞书应用 App Secret>
FEISHU_TARGET_CHAT_ID=<唯一目标群 chat_id>
FEISHU_ALLOWED_OPEN_IDS=<允许投递的用户 open_id，多个用逗号分隔>
RUNWEAVE_BASE_URL=http://127.0.0.1:5001
RUNWEAVE_FEISHU_STATE_DIR=<topic 与幂等状态目录>
RUNWEAVE_CLI_BIN=<rw 可执行文件或 dist/index.js 的绝对路径>
```

| 字段                                  | 说明                                                                 |
| ------------------------------------- | -------------------------------------------------------------------- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 企业自建应用凭据，必须保密                                           |
| `FEISHU_TARGET_CHAT_ID`               | completion 和入站会话唯一允许的目标群；`notify`、`bridge` 都要求配置 |
| `FEISHU_ALLOWED_OPEN_IDS`             | Bridge 允许远程输入的非空用户白名单；不支持“允许所有人”              |
| `RUNWEAVE_BASE_URL`                   | Bridge 访问的 Backend；本机通常为 `http://127.0.0.1:5001`            |
| `RUNWEAVE_FEISHU_STATE_DIR`           | `bridge-state.json`、跨进程锁和 Bridge PID lease 所在目录            |
| `RUNWEAVE_CLI_BIN`                    | Hook 调用 `rw feishu notify` 使用的 CLI 路径                         |

配置文件和 `bridge-state.json` 权限应为 `0600`。state 只保存 topic 标识、Terminal ID 和
processed 状态，不保存 completion 或用户输入正文。`FEISHU_BINDING_TTL_HOURS` 已废弃且
CLI/Hook 均不再读取；active topic 跟随 Terminal 生命周期，processed 记录仍在 24 小时后清理。

不知道 chat ID 或 open ID 时，在 Bridge 未运行的机器上执行：

```bash
export FEISHU_APP_ID=<app-id>
export FEISHU_APP_SECRET=<app-secret>
rw feishu discover --json
```

随后让目标用户向机器人发送一条消息。`discover` 只输出首个用户消息的 `openId` 和 `chatId`
后退出，不创建 topic 或投递 Terminal。

## 四、启动唯一 Bridge

同一 App ID 只能运行一个 `rw feishu bridge` 消费者。飞书长连接是集群消费，不会把同一事件
广播给每台机器；第二个 Bridge 可能拿走事件，却没有第一台机器的本地 Terminal 和 state。

### Linux systemd

将配置保存为权限 `0600` 的 `/etc/runweave/feishu.env`，再创建：

```ini
[Unit]
Description=Runweave Feishu Bridge
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/runweave/feishu.env
ExecStart=/absolute/path/to/rw feishu bridge --json
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now runweave-feishu-bridge.service
sudo systemctl status runweave-feishu-bridge.service
```

### macOS LaunchAgent

将配置保存为 `~/.runweave/feishu_notify.env` 并执行 `chmod 600`。wrapper 只加载配置并
`exec` Bridge：

```bash
#!/usr/bin/env bash
set -a
source "$HOME/.runweave/feishu_notify.env"
set +a
exec /absolute/path/to/rw feishu bridge --json
```

LaunchAgent 使用 `~/Library/LaunchAgents/com.runweave.feishu-bridge.plist`，设置
`RunAtLoad=true` 和 `KeepAlive=true`。重启命令：

```bash
launchctl kickstart -k gui/$(id -u)/com.runweave.feishu-bridge
launchctl print gui/$(id -u)/com.runweave.feishu-bridge
```

## 五、话题与路由合同

### completion 通知

- `(chatId, terminalSessionId)` 没有 topic 时，第一条真实 completion 直接成为顶层 root；
  不发送占位、标题卡片或模拟消息。
- 后续 completion 回复 root，并设置 `reply_in_thread: true`。
- 同一 Terminal 的不同 Panel 共用 topic；不同 Terminal 或不同 chat 使用不同 topic。
- root 只绑定 Terminal；state 不保存或累计 notification 到 Panel 的映射。
- 多个独立 notify 进程并发首次通知时，以持久化 claim、30 秒 lease、飞书 UUID 幂等和 owner
  CAS 收敛到一个 root。SDK HTTP 请求超时为 10 秒；首次 create 遇到 timeout、reset、HTTP
  5xx 等传输结果未知错误时，在 lease 内用相同 UUID 最多重试一次，仍无法确认则保留
  creating，后续通知继续沿用原 UUID 恢复。等待者不会无限轮询，也不会用新 UUID 猜测创建结果。

### 用户输入

- 白名单用户在有效话题内发送纯文本即可，无需 `@bot`；显式 mention 会被删除。
- Terminal 只能由事件 `root_id` 对应的 active topic 决定。
- Topic 内所有文本都不指定 Panel，由 Backend 在投递时选择当前活动 Panel；回复非根
  completion 与直接在话题输入遵守相同规则。
- 输入上限为 256 KiB。空文本或超长文本在合法话题中记录 failed 并回复原因。
- 同 topic 按 SDK 回调顺序串行，不同 topic 可并行。每个入站 `message_id` 独立持久化去重；
  Bridge 重启时遗留 `processing` 转为 `unknown`，不会自动重投。
- Terminal API 的单条投递截止时间为 15 秒，并覆盖 401 后的 token refresh 和请求重试。send
  前超时落为 failed；send 已开始但响应未知时落为 unknown。两者都释放当前 topic 队列并
  保留 topic，相同 `message_id` 不自动重投。

### 生命周期和故障

- Bridge 启动后仅在完整 `listSessions()` 成功时清理已不存在 Terminal 的 active topics。
- Terminal 404 时先完成失败回执尝试，再清除该 topic；Terminal 只是 exited 时保留。
- 复用 root 前以及回复失败后，只有消息详情查询明确证明 root 已删除或不存在，才以
  expected-root CAS 清除并让当前真实 completion 建立新 root。网络、限流、权限和无法确认
  的错误保留旧 root。
- reaction 或失败回执异常不改变已落盘的 Terminal 投递结果，也不重投输入。

飞书 Topic 事件只提供 root/thread 关系，无法可靠给出用户正在回复的非根消息 ID，因此
Topic 路由只绑定 Terminal，不把通知消息当作 Panel 地址。

## 六、升级与回滚

升级前停止旧 Bridge，并备份现有 state，且不输出文件内容：

```bash
install -m 0600 "$RUNWEAVE_FEISHU_STATE_DIR/bridge-state.json" \
  "$RUNWEAVE_FEISHU_STATE_DIR/bridge-state.pre-topic-v2.bak"
```

无 `version` 的 v1 state 可读取其 processed 状态，但旧 `bindings` 不迁移为 topic。第一次 v2
mutation 写入 `version: 2`；升级后的第一条新 completion 才建立 root，不扫描、编辑或删除
历史飞书消息。

回滚时：先停止新 Bridge，恢复旧 CLI/runtime；另存当前 v2 state 后恢复升级前 v1 备份，再
启动旧 Bridge。升级期间产生的话题保留在飞书中。若撤销“获取群组中所有消息”权限，也必须
重新发布应用版本。

## 七、真实验收

唯一当前测试合同是
[`feishu-terminal-topic-conversations.testplan.yaml`](../testing/terminal/integrations/feishu-topic-conversations.testplan.yaml)。
真实验收至少准备两个 Terminal 和一个双 Panel Terminal，并逐 case 隔离 fixture：

1. 核对同 Terminal 只有一个顶层 root，后续 completion 的 `root_id` 相同。
2. 在真实飞书客户端的话题输入框发送一个不含 `@bot` 的唯一文本。
3. 核对用户消息的 DONE、`bridge-state.json` v2 topic/processed 和精确 Terminal/Panel history。
4. 覆盖并发首次通知、快速连续输入、Bridge 重启、活动 Panel 切换、root 删除和拒绝路径。

浏览器 API、静态代码或机器人自发消息不能证明飞书客户端的话题层级和无 `@bot` 用户事件。
飞书 UI 验收需使用 `$computer-use`；若权限、客户端或测试应用不可用，应把对应 case 标为
blocked，不得用 typecheck 代替动态通过。

## 八、排障

### 能通知，但无 `@bot` 消息没有事件

- 确认已申请“获取群组中所有消息”并发布新版本。
- 确认仍订阅 `im.message.receive_v1`，Bridge 长连接 ready。
- 确认消息位于目标群的 active Runweave topic，而不是群顶层或旧 v1 通知。
- 确认同一 App ID 没有第二个 Bridge 消费者。

### 有事件，但没有 Terminal 输入

- 核对 sender open ID、目标 chat、`root_id`、`thread_id` 和纯文本类型是否满足门禁。
- 检查 `rw auth status --json`、Backend 可达性和 Terminal running 状态。
- 确认目标 Terminal 存在、至少一个 Panel 仍运行，且预期 Panel 已设为当前活动 Panel。
- 查看脱敏 Bridge 日志中的 message ID、Terminal ID、活动 Panel 路由和错误分类；日志不应有正文或 token。

### 输入成功但没有 DONE

检查 `im:message.reactions:write_only` 及机器人是否仍在群内。reaction 失败不会导致输入重投。

### Hook 没有通知

检查 `FEISHU_NOTIFY_TRANSPORT=app`、`RUNWEAVE_CLI_BIN`、
`~/.runweave/feishu_notify.log`，以及 AI CLI pane 是否具有 Runweave Terminal/Hook 身份变量。

## 九、Webhook 兼容模式

```bash
FEISHU_NOTIFY_TRANSPORT=webhook
FEISHU_WEBHOOK_URL=<自定义机器人 webhook>
FEISHU_WEBHOOK_SECRET=<可选签名密钥>
```

Webhook 只发送单向通知，不创建 topic state、不接收入站消息。`app` 与 `webhook` 两种 transport
互斥，不支持双发；新接入使用 `app`。

## 参考

- [飞书接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [飞书回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)
- [飞书获取指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get)
- [飞书添加消息表情回复](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/create)
