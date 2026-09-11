# Runweave 推送网关

独立的 APNs provider，只发送已授权 Mac 的电量告警。私钥留在网关，Mac 保存按安装隔离的发送凭据，
手机保存本连接的撤销凭据。它不依赖 App Server 或 Suiji，不提供通用通知正文或 URL 代理。
跨端行为见 [设备监控合同](../../docs/architecture/device-monitor.md)。

## 部署

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

正式分发使用 `production`，两种环境分别授权。命令仅显示一次新发送凭据；把它放入对应 Mac 的
Backend 服务环境，配置 `RUNWEAVE_PUSH_GATEWAY_URL`（HTTPS origin，无路径、query 或用户信息）和
`RUNWEAVE_PUSH_SENDER_TOKEN`，随后启动网关并重启该 Backend。

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

- 20%/10% 告警由 Backend 根据新鲜电池供电样本决定，网关只接受固定模板。HTTP 200/APNs accepted 只表示 Apple 接受。
- 每个 host 最多 100 条活跃绑定，每条每分钟最多 4 次提交；相同 host/安装/环境/轮次/档位共享稳定 notificationId。
- SQLite 事务先保存 sending，再进行 HTTP/2 请求。并发重复请求不重复发送；重启残留 sending 转为 unknown。
- 明确 429/5xx 可按 5、30、120 秒有限重试，遵守更长的 Retry-After。超时或断线结果记为 unknown，不盲目重发。
- APNs 使用 alert、priority 10、固定 topic、同 host 的 collapse-id、expiration 0。过期事实与已结束轮次被拒绝。
- token 永久失败只标记提交时的 token 版本；迟到响应不会作废刚更新的新 token。
- 撤销记录保留墓碑，迟到 PUT 返回 409。用户再次启用需要新绑定，目标级去重仍有效。
- Backend 通知轮次结束后，网关在后续轮次退休请求中清理已结束超过 7 天的投递明细；活跃轮次不因 TTL 重新发送。
  轮次结束标记与撤销墓碑继续保留。长期不产生新轮次时明细可能保留更久。

备份前停止服务，备份整个数据目录；恢复到独占目录后先执行脱敏状态检查，再开启正式发送。
未知 schema 拒绝覆盖原数据。回滚前先停发并撤销订阅，保留状态目录；不要通过删除状态“清理”去重。

## 验证

在仓库根执行 `node scripts/verify/device-monitor/run.mjs`。驱动创建自己的 HTTPS 证书、Backend/网关状态和登录，
验证真实 HTTP/WS、SQLite、阈值、撤销、并发与恢复。provider 检查使用本地 HTTP/2 TLS 服务核对 ES256、headers 和响应处理；
不会向 Apple 发通知，也不更改系统证书信任。
`node scripts/verify/device-monitor/run.mjs --cadence` 单独执行 130 秒、3 个客户端的采样频率检查。

真实 sandbox/production 锁屏横幅、前台 APNs 与点击路由仍必须在正确签名的专用手机上取证。
Apple 依据：[请求与 expiration](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)、
[token 注册](<https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:didregisterforremotenotificationswithdevicetoken:)>)。
