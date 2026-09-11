# Mac 电量与手机提醒

Backend 负责所在 Mac 的电量事实，原生 iOS 负责前台展示和用户订阅，独立
[推送网关](../../packages/push-gateway/README.md)负责 APNs 传输。通过远程地址连接时仍采集目标 Backend，
没有手机后台轮询，也不要求为了电量读取启动完整桌面资源监控。

## 电量事实

[采样服务](../../backend/src/device-monitor/service.ts)在启动时和每 60 秒读取 `pmset -g batt`，
单次 3 秒、64 KiB 上限，并发读取共享一个采样任务。共享解析器与 Electron 复用，Backend 不执行进程、CPU 或内存采集。

鉴权后的 `GET /api/device/status` 返回 no-store 快照。使用现有 `/ws/terminal-events` 时，只有明确加
`deviceStatus=1` 的客户端才收到独立 `device-status` 帧；设备帧不进入终端事件日志，也不推进终端 cursor。
首次订阅和每次采样完成均发送快照，包括电量未变化的成功样本。广播前核对原登录会话仍有效。

合同位于 [shared/device-status](../../packages/shared/src/monitoring/device-status.ts)：

- hostId 是 `browserProfileDir/device-monitor/state.json` 中的安装 UUID，重启保持；新启动生成 streamId，revision 在流内递增。
- pending、ok、error、unsupported 分别表示未取得样本、成功、失败和平台不支持。无电池是成功的 absent，未知不是 0%。
- error 保留最后成功电量和 observedAt。sampleAgeMs 由单调时钟生成；超过 180 秒的值只能作为旧记录展示。
- AC 与正在充电独立，0% 是有效观测。未知续航时间保持 null，不显示估算为事实。
- 新目录和状态文件限制为 0700/0600；单实例锁与原子写保护安装身份。未知 schema 或初始化失败仅关闭监控能力。

[DeviceStatusStore](../../packages/app-ios/Sources/RunweaveIOS/State/DeviceStatusStore.swift)按连接生命周期隔离请求，
通过 generation、streamId、revision 和已收到的 WS 版本丢弃旧 GET。首页电脑选择器旁显示电量，连接列表显示供电详情；
非当前连接使用自己的凭据、最多 3 个并发请求，离开列表即取消，不切 activeID。前台重连读取当前快照，后台停止主动读取。
界面本地更新时间只判断新鲜度，不发网络请求。旧 Backend 的 404 降级为不支持监控。

## 提醒授权

每条连接默认关闭。iOS 主动启用时请求系统权限、注册 APNs token；token 和安装 UUID 存 Keychain。
普通提醒不使用 Critical Alerts 或后台静默推送。

[通知 API](../../backend/src/routes/device-notifications.ts)使用真实 Bearer 会话，要求 App 登录的 connectionId 匹配：

| API                                                                    | 行为                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/device/notifications/status`                                 | 能力和当前身份的最新绑定，不返回 device token                          |
| `PUT /api/device/notifications/subscriptions/:installationId`          | 注册或更新 token，返回绑定、版本、网关 origin 和撤销凭据               |
| `POST /api/device/notifications/subscriptions/:installationId/confirm` | 手机持久化撤销凭据后，按 subscriptionId/version 确认；此前不发送       |
| `DELETE /api/device/notifications/subscriptions/:installationId`       | 关闭当前连接绑定；远端未确认时返回不可用，由手机继续直接撤销或保留待办 |

注册输入为 connectionId、deviceToken、environment、displayName、enabled 和 explicitEnable。
后台 token 同步不能创建被撤销的绑定；只有用户主动启用传 explicitEnable 才可创建新的 subscriptionId。
同 host/installation/environment 的不同地址别名共用一次目标投递，关闭一个别名不关闭另一个。
正常认证刷新保留 sessionId；会话失效后不再提交提醒。旧会话缺少 connectionId 时，电量仍可查看，提醒需重新登录后启用。

手机先保存关闭意图，再联系 Backend；Mac 不可达时可凭单绑定 revokeToken 直接联系 HTTPS 网关。
手机也离线则保留 Keychain 待撤销记录，显示“远端提醒关闭尚未确认”，恢复前台后先撤销再同步。
直接撤销不携带 Backend 登录 token，不跟随重定向。已提交给 APNs 的通知不能保证撤回。

## 告警与投递

[告警规则](../../backend/src/device-monitor/alerts.ts)仅使用 180 秒内、成功且正在使用电池的样本：
20% 与 10% 各一个档位，首次观测为 8% 时仅创建 10% 档。同一轮每台手机每档一次，回升至 25% 才结束轮次；
临界抖动、重连、短暂接电和关闭再开启不重置去重。

Backend 持久化待发记录，再核对当前绑定、档位和时效后提交。接电、过期、授权失效或进入更低档位会取消待发旧档。
网关再保存发送 claim 后调用 APNs；相同 notificationId 并发最多一次外发，未知结果不盲目重试。
明确 429/5xx 最多 3 次重试，总期限 5 分钟；运维与 APNs 细节以网关 README 为准。
网关身份预检拒绝错误 host 凭据。缺少推送配置只降低提醒能力，不阻断电量与终端。

点击通知只按已保存 hostId 选择连接，不使用 payload URL，不发送终端输入。冷启动先初始化本地状态，再消费待定位电脑，
重新读取当前状态；连接已删除则提示，认证失效则进入该连接登录页。旧通知百分比不写入当前电量快照。
原生草稿按连接 scope 保存在设备受保护、排除备份的本地目录，连接切换或冷启动可恢复；注销、删除连接或终端清理所属草稿。

## 验证边界

协议驱动为 `node scripts/verify/device-monitor/run.mjs`，验收合同为
[电量展示](../testing/app/mac-battery-monitor.testplan.yaml)与[低电量推送](../testing/app/mac-battery-alerts.testplan.yaml)。
本地记录器不等于真实 APNs 接受，APNs 接受也不等于手机展示；当前原生运行证据与未完成项见
[iOS 验收状态](../../packages/app-ios/docs/validation-status.md)。
