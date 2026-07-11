# 飞书应用通知与 Terminal 回复接入

本文说明如何为 Runweave 配置一个飞书企业自建应用，实现以下能力：

1. Runweave Terminal 中的 AI CLI 任务完成后，由飞书应用机器人发送通知。
2. 用户引用该通知回复文本，Runweave 将文本一次性投递回通知对应的 Terminal。

这不是持续聊天机器人。Bridge 只确认 Terminal 是否接受输入，不等待 AI CLI 的后续回复或执行结果。投递成功后，应用在用户原消息上添加 `DONE`（✅）表情；投递失败时才发送文字原因。

## 工作方式

```text
AI CLI Stop Hook
  → runweave-hook-bridge
  → rw feishu notify
  → 飞书应用机器人发送通知
  → 保存 message_id → terminalSessionId/panelId

用户引用通知回复
  → 飞书长连接推送 im.message.receive_v1
  → rw feishu bridge
  → 校验发送者、会话、引用关系和 message_id
  → rw terminal send（line + confirm short）
  → 成功：在用户消息上添加 ✅
  → 失败：回复具体错误文本
```

通知与回复都由同一个企业自建应用完成。飞书自定义机器人 Webhook 不是新接入的必要组件。

## 一、创建飞书应用

### 1. 创建企业自建应用

进入飞书开放平台开发者后台，创建一个企业自建应用，并记录：

- App ID
- App Secret

开启应用的“机器人”能力，并将机器人加入接收通知的群聊。应用需要发布版本后，新增能力、权限和事件订阅才会生效。

### 2. 配置权限

按实际会话类型申请最小权限：

| 用途                          | 飞书权限                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| 应用机器人发送完成通知        | `im:message:send_as_bot`（以应用的身份发消息）                |
| 接收群聊中用户 @ 机器人的回复 | `im:message.group_at_msg:readonly`（接收群聊中 @ 机器人消息） |
| 接收用户与机器人的单聊消息    | `im:message.p2p_msg:readonly`（按需启用）                     |
| 添加成功打钩表情              | `im:message.reactions:write_only`（发送、删除消息表情回复）   |

如果只在群聊中通过“引用通知 + @机器人”回复，不需要申请读取群内所有消息的敏感权限。

### 3. 配置事件订阅

在“事件与回调”中：

1. 订阅方式选择“使用长连接接收事件”。
2. 添加“接收消息 v2.0”事件，即 `im.message.receive_v1`。
3. 发布新的应用版本，使权限和事件配置生效。

长连接由本机主动连接飞书，不需要公网回调域名、固定公网 IP 或内网穿透。

## 二、准备 Runweave CLI

源码仓库环境先构建 CLI：

```bash
pnpm --filter @runweave/cli build
```

如果系统已安装 `rw`，可以直接使用。源码构建产物也可以这样执行：

```bash
node packages/runweave-cli/dist/index.js --version
```

Bridge 通过正常登录态调用 Runweave Terminal Input API，不直接操作 tmux，也不使用 Hook token。先完成登录：

```bash
rw auth login \
  --base-url http://127.0.0.1:5001 \
  --username <Runweave 用户名>

rw auth status --json
```

`auth status` 应返回 `authenticated: true`。

### 确认 completion Hook 已安装

Electron 启动时会安装 Runweave completion Hook 和飞书通知脚本。确认以下文件存在：

```bash
ls -l ~/.runweave/bin/runweave-hook-bridge
ls -l ~/.runweave/hooks/feishu_stop_notify.sh
```

源码或 CLI-only 的 Linux 环境如果没有运行 Electron，需要手工安装运行副本：

```bash
install -d -m 0755 ~/.runweave/bin ~/.runweave/hooks
install -m 0755 electron/resources/hooks/runweave-hook-bridge.cjs \
  ~/.runweave/bin/runweave-hook-bridge
install -m 0755 electron/resources/hooks/feishu_stop_notify.sh \
  ~/.runweave/hooks/feishu_stop_notify.sh
```

AI CLI 还必须加载 Runweave 的 Hook 配置。Codex/Trae 的安装与身份注入细节见
[`terminal-completion-hooks.md`](../architecture/terminal-completion-hooks.md)。仅复制脚本但没有注册 Stop Hook，不会产生完成通知。

## 三、配置飞书连接

### 配置字段

```bash
FEISHU_NOTIFY_TRANSPORT=app
FEISHU_APP_ID=<飞书应用 App ID>
FEISHU_APP_SECRET=<飞书应用 App Secret>
FEISHU_TARGET_CHAT_ID=<通知目标 chat_id>
FEISHU_ALLOWED_OPEN_IDS=<允许回复投递的用户 open_id，多个用逗号分隔>
FEISHU_BINDING_TTL_HOURS=24
RUNWEAVE_BASE_URL=http://127.0.0.1:5001
RUNWEAVE_FEISHU_STATE_DIR=<binding 与去重状态目录>
RUNWEAVE_CLI_BIN=<rw 可执行文件或 dist/index.js 的绝对路径>
```

字段说明：

| 字段                                  | 说明                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 企业自建应用凭据，必须保密                                          |
| `FEISHU_TARGET_CHAT_ID`               | 完成通知发送到的飞书会话 ID                                         |
| `FEISHU_ALLOWED_OPEN_IDS`             | 允许远程向 Terminal 投递输入的飞书用户白名单                        |
| `FEISHU_BINDING_TTL_HOURS`            | 通知与 Terminal 绑定有效期，默认 24 小时                            |
| `RUNWEAVE_BASE_URL`                   | Bridge 访问的 Runweave 后端地址；本机通常为 `http://127.0.0.1:5001` |
| `RUNWEAVE_FEISHU_STATE_DIR`           | 保存通知 binding、入站消息幂等状态和 Bridge PID lease               |
| `RUNWEAVE_CLI_BIN`                    | completion Hook 调用 `rw feishu notify` 时使用的 CLI 路径           |

配置文件权限必须为 `0600`。App Secret、Runweave access token 不应进入仓库、日志或聊天消息。

### 获取 chat ID 和 open ID

获得 App ID 和 App Secret 后，可以启动一次性发现连接：

```bash
export FEISHU_APP_ID=<app-id>
export FEISHU_APP_SECRET=<app-secret>

rw feishu discover --json
```

然后在目标会话中给应用机器人发送一条消息。命令收到首个用户消息后输出：

```json
{
  "discovered": true,
  "openId": "ou_xxx",
  "chatId": "oc_xxx"
}
```

将 `chatId` 写入 `FEISHU_TARGET_CHAT_ID`，将可信用户的 `openId` 写入 `FEISHU_ALLOWED_OPEN_IDS`。发现命令不进行 Terminal 投递，输出一次后退出。

## 四、启动常驻 Bridge

同一个飞书应用只应运行一个 Bridge。飞书长连接采用集群消费，同一应用在多台独立服务器同时连接时，一条事件只会随机交给其中一个连接，而不会广播；没有共享 binding 的另一台机器将无法定位原 Terminal。

### Linux：systemd

创建 `/etc/runweave/feishu.env` 保存本文“配置字段”列出的环境变量，并创建
`/etc/systemd/system/runweave-feishu-bridge.service`。服务至少需要包含：

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

将 `ExecStart` 替换为实际的 `rw` 安装路径，然后启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now runweave-feishu-bridge.service
sudo systemctl status runweave-feishu-bridge.service
```

查看日志：

```bash
journalctl -u runweave-feishu-bridge.service -f
```

Linux completion Hook 在用户级配置不存在时会回退读取 `/etc/runweave/feishu.env`，因此通知发送和 Bridge 可以共用该配置。

### macOS：LaunchAgent

macOS 不使用 systemd。将配置保存为：

```text
~/.runweave/feishu_notify.env
```

并设置权限：

```bash
chmod 600 ~/.runweave/feishu_notify.env
```

可以先在终端验证：

```bash
set -a
source ~/.runweave/feishu_notify.env
set +a
rw feishu bridge --json
```

需要登录后自动启动时，使用用户级 LaunchAgent 调用一个 wrapper 脚本。wrapper 只负责加载配置并 `exec` Bridge：

```bash
#!/usr/bin/env bash
set -a
source "$HOME/.runweave/feishu_notify.env"
set +a
exec /absolute/path/to/rw feishu bridge --json
```

LaunchAgent 的 plist 放在：

```text
~/Library/LaunchAgents/com.runweave.feishu-bridge.plist
```

plist 至少配置 wrapper 的绝对路径、`RunAtLoad=true` 和 `KeepAlive=true`。加载或重启：

```bash
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.runweave.feishu-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.runweave.feishu-bridge
```

同一用户只加载一个该 LaunchAgent。

## 五、通知与回复的使用方式

### 发送完成通知

Runweave Terminal 中的 AI CLI 触发 Stop/completion Hook 后：

1. Hook 收集 Terminal ID、panel、cwd 和任务摘要。
2. `rw feishu notify` 通过应用机器人发送完成通知。
3. 飞书返回的 `message_id` 与 `terminalSessionId/panelId` 保存为短期 binding。

只有带 Runweave Terminal 身份环境变量的 Hook 才会发送通知；普通系统终端中的 AI CLI 不会触发该链路。

### 从飞书回复 Terminal

在飞书中引用应用机器人发送的完成通知，并回复文本。群聊权限只允许 @ 机器人消息时，同时 @ 应用机器人。

Bridge 会：

1. 校验发送者 `open_id` 是否在 allowlist。
2. 校验引用消息是否为未过期的 Runweave 通知。
3. 校验回复和通知是否属于同一个 `chat_id`。
4. 删除飞书生成的 `@_user_1` 等机器人 mention 占位符。
5. 通过 `rw terminal send` 以 `line + confirm short` 投递到原 Terminal 或原 panel。
6. 以入站 `message_id` 去重，飞书重复推送不会造成重复输入。

成功只表示 Runweave 后端接受并入队输入，不表示 AI CLI 已经执行完成。

### 投递回执

- 成功：在用户原回复上添加 `DONE`（✅）reaction，不新增机器人消息。
- 失败：回复文字原因，例如 Terminal 不存在、Terminal 已退出、Runweave 认证失败或后端不可达。
- 回执失败不会重新投递 Terminal。

同一条完成通知可以被回复多次；每一条新的飞书回复都是独立的一次性调用。Bridge 不维护连续对话状态。

## 六、验证

### 1. 检查 Bridge

```bash
rw auth status --json
```

Linux：

```bash
systemctl is-enabled runweave-feishu-bridge.service
systemctl is-active runweave-feishu-bridge.service
```

macOS：

```bash
launchctl print gui/$(id -u)/com.runweave.feishu-bridge
```

### 2. 验证通知

在 Runweave Terminal 中让 AI CLI 完成一次任务。预期应用机器人发送一条包含 Terminal 信息的完成通知。

### 3. 验证回复

引用通知回复一个唯一文本，例如：

```text
FEISHU-DELIVERY-CHECK
```

预期：

- 原 Terminal history 中只出现一次该文本。
- 输入中不包含 `@_user_1`。
- 用户飞书消息出现 ✅。
- 没有额外的“已投递”机器人文本消息。

## 七、排障

### 能发送通知，但收不到回复事件

检查：

- 应用是否已发布最新版本。
- 是否选择“使用长连接接收事件”。
- 是否订阅 `im.message.receive_v1`。
- 群聊场景是否开通 `im:message.group_at_msg:readonly`。
- 用户是否引用通知并 @ 机器人。
- 是否误启动了同一应用的第二个 Bridge。

### 能收到消息，但没有投递 Terminal

检查：

- 发送者 `open_id` 是否在 `FEISHU_ALLOWED_OPEN_IDS`。
- 引用通知是否超过 binding TTL。
- 通知和回复是否在同一个 `chat_id`。
- `rw auth status --json` 是否已认证。
- 目标 Terminal 是否仍为 running。

### 投递成功但没有 ✅

检查是否开通 `im:message.reactions:write_only`，并确认应用机器人仍在该会话中。缺少 reaction 权限不会导致 Terminal 重复投递。

### Hook 没有发送通知

检查：

- `FEISHU_NOTIFY_TRANSPORT=app`。
- `RUNWEAVE_CLI_BIN` 是否指向可用的 `rw` 或 `dist/index.js`。
- `~/.runweave/feishu_notify.log`。
- AI CLI 是否运行在带 `RUNWEAVE_TERMINAL_SESSION_ID` 和 Hook 身份变量的 Runweave Terminal 中。

## 八、旧自定义机器人兼容模式

旧的飞书自定义机器人 Webhook 发送能力仍保留为兼容和回滚通道：

```bash
FEISHU_NOTIFY_TRANSPORT=webhook
FEISHU_WEBHOOK_URL=<自定义机器人 webhook>
FEISHU_WEBHOOK_SECRET=<可选签名密钥>
```

兼容模式只能发送单向通知，不能接收引用回复，也不会创建应用消息 binding。

`app` 和 `webhook` 两种 transport 互斥，不支持双发。新接入只使用 `app`；仅在旧环境回滚时使用 `webhook`。

## 九、安全边界

- 飞书回复最终会成为本机 Terminal 输入，应按远程控制能力管理。
- 必须设置最小 `FEISHU_ALLOWED_OPEN_IDS`，不能只依赖群成员身份。
- Bridge 只接受引用有效应用通知的纯文本，不按“最近 Terminal”猜测目标。
- 输入固定使用 `line` 模式，不开放 raw、interrupt、agent overwrite 或 Terminal 创建/删除。
- App Secret、Runweave token 和配置文件必须限制为 `0600`，不得提交到 Git。
- 如果 App Secret 曾出现在聊天、日志或代码中，应立即在飞书后台轮换。

## 参考

- [飞书接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [飞书发送消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [飞书添加消息表情回复](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/create)
- [飞书表情类型说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce?lang=zh-CN)
