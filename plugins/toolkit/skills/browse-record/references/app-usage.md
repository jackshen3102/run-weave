# App 使用时长接入

数据来自 ScreenJournal 的 `archive.py day`，按上海自然日查询已归档的跨设备前台焦点事件。
优先使用仓库同版工具；独立技能运行时使用 `/Applications/ScreenJournal.app/Contents/Resources/AppUsageTools/archive.py`。
ScreenJournal 的自动归档由其自身开关管理；本适配器只读已有归档，不建立或修改定时任务。

私有 JSON 配置沿用知乎配置的 `schemaVersion/timeZone/serverId/ownerId/connectionId/machine/stateDir/suijiConfig/tokenFile`；
新增 `transport:"app-usage"` 和绝对 `archivePath`（默认归档位置为 `~/Library/Application Support/ScreenJournalAppUsage/archive.sqlite`，配置需展开为绝对路径）。
`profile:"local-archive"`、`group:"app-usage"` 明确不使用浏览器；不配置 `sessionFile`。
`externalAccountId` 使用 `scripts/app_usage.py` 的 `source_identity(archivePath)` 生成，绑定本机用户的归档路径，不能称为 Apple 账号身份。
服务连接的 `provider` 固定为 `app-usage`，其余绑定须与配置一致。凭据必须为独立 `/mcp/browse` 领域。

prepare 默认查询昨天和今天，显式范围最多 31 天。按设备 ID 和日期导入一条 `app-usage`；
只存在设备映射、从无事件的设备不生成卡片；有事件但当日无可计算区间时显示“暂无可计算时长，不代表未使用”。
各 App 按时长降序，已知包名显示名称，其他保留包名；系统界面标识不冒充已安装 App。
卡片保留最新设备事件、归档时间、匹配/推断时长及超四小时区间，覆盖为 `partial/observed-only`，不承诺实时或全天完整。
重复导入使用已有设备日身份，不增加卡片；新事件重算同一张卡并保留版本和用户备注；回收站条目不会因重采恢复。

本链路不调用 read/publish-digest；App 使用记录不是阅读回顾，也不进入工作事实与日报输入。
