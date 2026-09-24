# Runweave 推送网关

独立的通用 APNs 通知服务，业务通过统一接口提供事件类型、标题和正文。私钥留在网关，
调用方保存按 hostId 隔离的发送凭据，手机保存本连接的撤销凭据。当前 provider 固定为 Runweave iOS App；
不是任意 App、Android 或邮件的推送平台。它不依赖 App Server 或 Suiji，不接受 URL 跳转或终端命令。
跨端行为见 [设备监控合同](../../docs/architecture/device-monitor.md)。

## 接入其他通知业务

合同从 `@runweave/shared/push-notifications` 导入。所有业务统一调用 `POST /v1/notifications`，
共用[投递引擎](./src/delivery.ts)和 APNs provider。电量提醒由 Backend 生成 `battery.low` 事件，
阈值、轮次、取消条件和文案都由 Backend 决定；网关不含电量专用接口或业务逻辑。
所有注册、发送请求都带 `Authorization: Bearer <该 host 的发送凭据>`；凭据不下发给手机。

先由业务端在用户明确订阅后调用 `PUT /v1/subscriptions/:subscriptionId`：

```json
{
  "installationId": "PHONE_INSTALLATION_UUID",
  "environment": "sandbox",
  "deviceToken": "APNS_HEX_DEVICE_TOKEN",
  "displayName": "我的电脑",
  "version": 1,
  "categories": ["task.completed", "task.failed"]
}
```

返回 `{ "revokeToken": "..." }`。业务端负责鉴权、用户授权、保存撤销凭据后的确认，确认前不发送；
现有电量业务的两阶段确认继续由 Backend 执行。新业务应使用独立绑定，不覆盖电量业务拥有的订阅。
手机可凭本绑定 revokeToken 调用 `DELETE /v1/subscriptions/:subscriptionId`；发送方也可用自己的凭据撤销。

`categories` 必填，必须是 1–32 个不重复的类型名，无通配符、默认类别或字段省略兜底。
它是完整替换列表；修改类型/token/displayName 必须递增 version，
相同版本仅接受相同内容，已撤销 ID 不能重新注册。
手机连接设置保留“低电量提醒”开关。已登录的连接默认独立订阅定时任务事件
`task.completed`、`task.failed`，无需开关；开启低电量不会改变任务订阅。

发送示例（用真实绑定 ID 和事件发生时间替换占位值）：

```json
{
  "subscriptionId": "SUBSCRIPTION_UUID",
  "eventId": "TASK_EVENT_UUID",
  "category": "task.completed",
  "title": "任务完成",
  "body": "代码修改已完成，可以查看结果了。",
  "occurredAt": "2026-09-20T00:00:00.000Z"
}
```

- ID 为 8–128 位字母、数字、下划线或连字符；类别为最多 64 位小写字母/数字，可用点、下划线、连字符分段，首字母必须小写。
- `battery.low` 和 `task.completed` 使用完全相同的接口与订阅校验，没有保留的业务类别。
- title/body 非空，分别不超过 120/2000 个 UTF-16 code units；最终 APNs JSON 按 UTF-8 计不超过 4096 字节，超限返回 413。
- `occurredAt` 是可解析日期字符串，建议 ISO 8601 UTC；超过 5 分钟或超前服务时钟超过 30 秒返回 422。
- 业务端为每个事件生成稳定 eventId；重试保持 eventId、category、正文和时间不变。相同 host/安装/环境/category/eventId
  共享 notificationId，地址别名不会重复通知；同一身份改变标题、正文或时间返回 409。
- 返回 `{ "notificationId": "64位十六进制ID", "state": "accepted|unknown|retry|failed", "retryAfterMs": 5000 }`，
  retryAfterMs 仅在需要重试时出现。HTTP 200 需继续检查 state；accepted 只表示 Apple 接受，不证明手机显示。
  仅 retry 按返回间隔重试；unknown 不自动重发。HTTP 429/503 可退避后重试原请求，其余 4xx 应修正原因。

通知 payload 包含 protocolVersion=1、hostId、notificationId、category 和 occurredAt。
点击仍只定位已保存的电脑连接。业务 category 是应用自定义字段，不是 `aps.category` 的交互按钮配置。

## 部署

AWS Lightsail Docker Compose 部署、Caddy 配置及本机调试见[部署操作指南](../../docs/deployment/push-gateway.md)。

需要 Node.js 22、可写的持久目录、到 Apple 的 HTTP/2 出站网络，以及对手机和 Mac 可达的 HTTPS origin。
服务默认只监听 `127.0.0.1:8092`，由运营者配置反向代理 TLS。不要把默认 HTTP 监听直接暴露到公网。

| 环境变量                                 | 说明                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| `PUSH_GATEWAY_DATA_DIR`                  | 必填，SQLite、WAL 和单实例锁的独占持久目录           |
| `APNS_PRIVATE_KEY_FILE`                  | 必填，运营者保管的 `.p8` 文件绝对路径                |
| `APNS_KEY_ID`、`APNS_TEAM_ID`            | 必填，与私钥和 App ID 对应                           |
| `PUSH_GATEWAY_BIND`、`PUSH_GATEWAY_PORT` | 默认 `127.0.0.1`、`8092`                             |
| `PUSH_GATEWAY_ADMIN_TOKEN`               | 可选，启用脱敏管理员状态接口；独立高熵密钥           |
| `PUSH_GATEWAY_ADMIN_URL`                 | 管理 CLI 的目标 origin，默认 `http://127.0.0.1:8092` |

配置通过受限权限的服务环境文件装载，不提交私钥、token 或个人配置。首次安装在仓库根执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @runweave/push-gateway typecheck
pnpm --filter @runweave/push-gateway start
```

`GET /health` 只返回进程活性，不证明 APNs 凭据有效或手机已收到提醒。持有管理员凭据时可执行
`pnpm --filter @runweave/push-gateway admin status`，查看发送结果计数，不输出 device token。

## 给一台 Mac 授权

先通过该 Mac 已鉴权的 `GET /api/device/status` 获取 `hostId`。暂时停止网关，再执行：

```bash
pnpm --filter @runweave/push-gateway admin add-host <hostId> sandbox
```

正式分发使用 `production`，两种环境分别授权。命令仅显示一次新发送凭据；把网关 HTTPS origin、
发送凭据与 hostId 保存到对应 Backend profile 的 `device-monitor/push.json`（权限 0600），
随后启动网关并重启 Backend。文件格式和配置优先级见[持久配置](../../docs/deployment/push-gateway.md#6-授权-mac-和启用手机)。

Backend 会核对凭据绑定的 hostId，不能将正式安装的凭据复用到新的 Dev/Beta profile。没有配置时只关闭提醒能力，
电量和终端仍可用。同一 profile 重启保持 hostId；复制状态目录会复制安装身份，因此新安装必须使用独立目录。

轮换时停止网关，执行 `admin revoke-host <hostId>` 撤销该 host 的全部发送凭据，再 `add-host` 并更新该 Mac，最后重启网关。
其他 host 的凭据不受影响。撤销发送凭据后，手机仍可用本绑定的
revokeToken 撤销记录。管理员写操作要求停止服务，避免与在线进程共享写入生命周期。

## iOS 签名和启用

原生远程推送需要具备 Push Notifications 能力的 Apple Developer Program 团队；免费 Personal Team 无法签发该权限。
保留 Bundle ID `com.runweave.app.native`，在 Apple Developer 的对应 App ID 启用 Push Notifications，
使用包含该能力的签名 profile。工程 Debug/Profile 配置 `aps-environment=development`、API 环境 `sandbox`；
Release 配置 `production`。导出或重新签名时须再次检查实际产物，不能仅凭构建配置推断最终 entitlement：

```bash
codesign -d --entitlements :- /path/to/RunweaveNative.app
```

仅安装电量展示版时，可给本地 `xcodebuild` 传入 `CODE_SIGN_ENTITLEMENTS=/absolute/path/Personal.entitlements`，
该文件使用空 plist 字典，并同时设置 `RUNWEAVE_APNS_ENVIRONMENT=disabled`；不要修改或提交个人签名配置。
这类构建不支持远程提醒，不能用于 APNs 验收。

手机在连接管理主动打开“低电量提醒”，此时才请求系统权限。旧手机会话若缺少连接标识，先重新登录该连接。
Backend 注册成功后，手机先将撤销凭据写入 Keychain，再确认订阅；没有确认的绑定不会发送。
模拟器构建不自动开启真实 APNs 注册。实体设备验收步骤见 [推送计划](../../docs/testing/app/mac-battery-alerts.testplan.yaml)。

## 投递与恢复

- 业务调用方决定何时提醒和通知内容。电量 Backend 负责 20%/10% 阈值和轮次，在第一次发送前持久化标题、正文和发生时间，
  重试复用同一事件；样本变化仍参与取消判断，不改写已提交的事件内容。
- 每个 host 最多 100 条活跃绑定；同 host/安装/环境的所有类别与地址别名共用每分钟最多 4 次提交的额度。
  网关统一按 category/eventId 去重；电量 Backend 将轮次/档位编码为稳定的 eventId。
- SQLite 事务先保存 sending，再进行 HTTP/2 请求。并发重复请求不重复发送；重启残留 sending 转为 unknown。
- 明确 429/5xx 可按 5、30、120 秒有限重试，遵守更长的 Retry-After。超时或断线结果记为 unknown，不盲目重发。
- APNs 使用 alert、priority 10、固定 topic、expiration 0（不要求 Apple 离线存储），
  collapse-id 统一使用 notificationId，独立事件不会互相覆盖。网关拒绝过期事件。
- token 永久失败只标记提交时的 token 版本；迟到响应不会作废刚更新的新 token。
- 撤销记录保留墓碑，迟到 PUT 返回 409。用户再次启用需要新绑定，目标级去重仍有效。
- 网关只保留内容摘要，不保存标题正文；投递明细在 7 天后的下一次有效投递请求中清理。
  7 天是事件 ID 去重窗口，业务仍须给新事件生成新 ID。
- 当前网关状态 schema 为 2，不提供旧电量服务的数据迁移或接口适配。首次部署使用新数据目录，
  Backend 与网关使用同一版本；开发试运行数据如需保留，应先离线备份，不直接覆盖。

备份前停止服务，备份整个数据目录；恢复到独占目录后先执行脱敏状态检查，再开启正式发送。
未知 schema 拒绝覆盖原数据。回滚前先停发并撤销订阅，保留状态目录；不要通过删除状态“清理”去重。

## 验证

通用接口验收合同见[通用推送计划](../../docs/testing/app/push-notifications.testplan.yaml)。
在仓库根执行 `node scripts/verify/device-monitor/run.mjs`。驱动创建自己的 HTTPS 证书、Backend/网关状态和登录，
验证真实 HTTP/WS、SQLite、阈值、撤销、并发与恢复，以及通用接口的类别授权、内容冲突、超限、别名限流与重试。
provider 检查使用本地 HTTP/2 TLS 服务核对 ES256、两种 payload、headers 和响应处理；
不会向 Apple 发通知，也不更改系统证书信任。
`node scripts/verify/device-monitor/run.mjs --cadence` 单独执行 130 秒、3 个客户端的采样频率检查。

真实 sandbox/production 锁屏横幅、前台 APNs 与点击路由仍必须在正确签名的专用手机上取证。
Apple 依据：[请求与 expiration](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)、
[payload 大小](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html)、
[token 注册](<https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:didregisterforremotenotificationswithdevicetoken:)>)。
