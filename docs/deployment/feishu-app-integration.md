# 飞书应用通知与 Terminal 话题会话

一个机器人服务一个目标群。机器人首次完成通知自动建立话题；用户只在已有绑定话题内回复，
输入进入原机器的原 Terminal 当前活动 Panel。DONE（✅）表示输入被 Backend 接收并入队，
后续回答由原 Hook 通知链返回，不表示 AI 已完成。

## 运行角色

| `services.feishu.role` | 运行方式                                                         | 凭据                                   |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `standalone`（默认）   | 一份 `rw feishu bridge` 对应一个 Backend，继续使用原 HTTP 登录态 | 本机保存飞书应用凭据                   |
| `hub`                  | 一份集中 `rw feishu bridge` 收发飞书消息，维护话题与投递记录     | 仅中心保存飞书应用凭据和每机独立 token |
| `node`                 | Backend 内置连接模块主动连中心，随 Backend 启停                  | 仅中心 HTTPS origin 和本机 token       |

集中模式无需访问远端 Backend IP、开放远端入站端口或逐机部署 Bridge。只有中心需要被三台机器访问。
不接受群顶层任务、私聊、未授权用户、未知 root、错误 thread 或非文本消息；没有选机器、新建终端、
手动认领话题、离线通知补发、负载均衡或 HA。

## 飞书应用准备

使用一个已有企业自建应用，开启机器人并加入目标群。所需权限为
`im:message:send_as_bot`、`im:message.group_msg`、`im:message.reactions:write_only`。
事件订阅选择长连接，订阅 `im.message.receive_v1`，修改权限后发布应用版本。
允许群内未 @ 机器人消息后，Bridge 仍执行自己的群、用户、root/thread 白名单校验。

同一应用的多个长连接客户端会竞争事件，而不是广播。切换 hub 前停止该应用的旧 Bridge。
可以在 Bridge 未运行时使用 `rw feishu discover --instance stable --json` 获取首次消息的 openId/chatId；
发现命令不投递终端。[飞书 SDK 说明](https://github.com/larksuite/node-sdk#subscribing-to-events-using-long-connection-mode)

## 配置与启动

业务配置以实例 `settings.yaml` 为准，不再 source 飞书 env 文件。按
[配置 CLI](../cli/configuration.md) 合并以下字段到正确实例，保留原配置其他域；不要把 token 写入命令行。
配置改变后重启对应 Backend/Bridge，保存成功不等于运行进程已采用。

中心配置片段（backendId 替换为真实 64 位十六进制身份，三台机器各配置一个条目）：

```yaml
services:
  feishu:
    role: hub
    appId: cli_xxx
    appSecret: <应用密钥>
    targetChatId: oc_xxx
    allowedOpenIds: [ou_xxx]
    notifyOpenIds: []
    hub:
      host: 127.0.0.1
      port: 7892
      backends:
        <backendId>:
          token: <该机器独立的32字节随机值的base64url编码>
```

backendId 使用各 Backend 已登录的 `GET /api/connection/identity` 返回的 `identityId`。
它来自本机持久 ConnectionIdentityService，不使用 IP、机器名或通用 stable 实例名。
克隆状态目录会复制身份，不能将同一身份用于两台机器；身份损坏时先修复原身份，不自动换 ID。
每机 token 必须不同，长度为 43–256 个 base64url 字符；可在私有文件中生成 32 字节随机 token。

每台机器配置片段：

```yaml
services:
  feishu:
    role: node
    node:
      url: https://bridge.example.com
      token: <仅该机器的token>
```

node 不需要 appId/appSecret，不启动 `rw feishu bridge`，也不能同时启用 legacyWebhook。
生产 origin 必须是 HTTPS，无用户信息、路径、query 或 fragment；Backend 转为 WSS 后通过
`/feishu/backends/<backendId>` 连接。TLS 由中心反向代理终止，代理需转发 WebSocket Upgrade、
Authorization，读超时至少 60 秒；Bridge 默认只监听 loopback。节点不跟随重定向。

构建并在中心绑定实例启动（中心不要求运行 Backend 或登录三个 Backend）：

```bash
pnpm cli:build
rw config validate --instance stable --json
rw feishu bridge --instance stable --json
```

Standalone 保持原 app 配置与 Backend 登录，使用相同启动命令，省略 role 或配置 standalone。
Hook 安装与绑定 runtime CLI 见 [完成 Hook](../architecture/terminal-completion-hooks.md)。三台 node 的
Backend 和 Hook 使用的 `rw` 都需更新到支持 node 的同一版本。

## 收发、状态与故障

- 本机仍负责 60 秒时长、30 秒宽限、已查看状态及飞书回复例外。Hook 的 `rw feishu notify`
  领取一次发送资格后，通过 Hook token 调用本机 `POST /internal/terminal-completion/feishu/notify`。
  显式手动 notify 使用 CLI 登录态访问 `POST /api/feishu/notify`，不会绕过认证。
- 中心按认证连接取得 backendId，统一添加通知 @ 用户与机器身份前 12 位。话题键为
  `(chatId, backendId, terminalSessionId)`；回复按 chat + root 查绑定，同话题串行。
- 连接内仅允许 terminal.get、terminal.input、notify、结果与运行状态报告，不代理任意 HTTP 或 shell。
  输入最多 256 KiB，帧最多 512 KiB，每连接最多 64 个在途请求；同身份存活连接不允许被另一连接抢占。
- WS 每 15 秒心跳，45 秒未回应清除；节点按 1–30 秒退避并加抖动重连。中心每 5 秒提供原有飞书状态报告，
  断连后 Backend 沿用来源 TTL 显示不可用。本地终端不依赖中心存活。
- 未尝试输入从飞书消息创建起最多等待 120 秒，只等原机器；过期提示失败。输入尝试后断连、超时或
  结果丢失转 unknown，提示检查终端，不自动重投。中心重启仅续投未尝试且未过期项。
- 通知转发最多等待 40 秒，不持久排队、不自动补发。原有 claim 后发送失败可能丢一次通知的限制保留。
  输入去重仍保留 24 小时，不承诺 exactly-once；话题绑定不因时间自动过期。
- 状态目录仍为 `storage.feishuDirectory`。Standalone 使用 v2，hub 使用 v3；版本不匹配拒绝启动，
  不把错误文件当空状态覆盖。文件权限 0600，包含待投递事件正文，应按凭据级别保护。

## 离线迁移与回滚

先备份各实例配置及 `bridge-state.json`，暂停 Hook 通知发送并停旧 Bridge，确认没有在途创建。
中心使用独立目录。只导入所选应用、目标群的旧话题；其他应用的话题不接管，其下一次正常通知
会由统一机器人自动建立话题，用户无需手工创建。

提供私有 JSON 清单后，从仓库执行 `pnpm --dir backend exec tsx ../scripts/feishu/migrate-state.ts /absolute/manifest.json`：

```json
{
  "mode": "import",
  "appId": "cli_xxx",
  "chatId": "oc_xxx",
  "sources": [
    {
      "appId": "cli_xxx",
      "backendId": "<真实64位身份>",
      "file": "/backup/node-a/bridge-state.json"
    }
  ],
  "output": "/new/hub/bridge-state.json"
}
```

清单需列齐同应用来源。脚本验证完再写新文件，拒绝覆盖已存在输出、重复 root、重复消息 ID、
未完成 creating 或不匹配群；不会修改源文件。切换窗口遗留 waiting 转 failed、processing 转 unknown，
不在迁移后意外执行旧输入。迁移完成后启 hub、再启三台 node。

回滚先停 hub/node、暂停通知，保存中心状态。清单改为 `mode: "rollback"`，增加
`hubFile: "/backup/hub/bridge-state.json"`，output 改为不存在的输出文件所在目录；sources 保留原 v2 备份。
脚本输出每机 `<backendId>.json`，将新绑定和去重记录合入各自旧格式，attempted/in-flight 保守转 unknown。
核对后恢复配置与这些合并后的状态，再启 standalone；不能直接恢复旧备份丢掉切换期间的去重记录。
不同应用的老实例按自己的备份恢复，不导入统一机器人消息。

## 验证

```bash
pnpm --dir backend exec tsx ../scripts/verify/feishu/central-bridge.ts
pnpm testplan:validate docs/testing/terminal/feishu-central-bridge.testplan.yaml
```

集成脚本使用三个真实节点进程、真实 WS/存储/消息处理器和 CLI→本机 Hook 鉴权通知入口，飞书服务与
终端执行适配器受控。真实部署还需按 [验收计划](../testing/terminal/feishu-central-bridge.testplan.yaml)
验证三台机器的实际网络/TLS、原话题输入、原终端执行和回答回传；脚本通过不能替代该闭环。
