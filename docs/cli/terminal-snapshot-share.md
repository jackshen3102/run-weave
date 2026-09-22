# 终端快照分享

Terminal 顶部 `…` →「分享终端快照」捕获当前显式 Panel 的静态文本，上传到统一公网 Host，
成功持久化后复制 HTTPS 链接。所有业务 Backend（包括 AWS 自己的 Backend）只捕获和上传；
只有独立 Host 保存内容、管理签名密钥和提供只读页面。

## 创建与读取

创建仍通过当前 Backend 认证，沿用原 tunnel 门禁：

```text
POST /api/terminal/session/:sessionId/panels/:panelId/shares
Authorization: Bearer <backend-access-token>
```

返回 201 表示 Host 已持久化，响应必须包含 `shareUrl`、`sharePath`、`title`、`createdAt`、
`expiresAt`、`lineCount`。`shareUrl` 是公网 HTTPS origin 加签名路径；前端只使用此 URL，
不拼接 Backend 地址、不查询局域网 IP、不兼容缺失公网链接的旧响应。
合同见 [`snapshot-share.ts`](../../packages/shared/src/terminal/snapshot-share.ts)。

`sharePath` 形如 `/share/terminal/<snapshotId>?expires=<Unix毫秒>&signature=<签名>`。
Host 使用独立密钥进行 HMAC-SHA256 签名，绑定版本、只读用途、snapshotId 和 expires。
每次 GET/HEAD 都验签、检查到期时间并核对完整记录。参数缺失、重复、额外字段、非规范编码、
篡改、过期、损坏记录均返回 404；其他方法返回 405。不返回登录页或 SPA，不赋予终端控制权限。
业务 Backend 的 `/share/terminal` 直接返回 404，不提供快照读取，不迁移旧链接。

创建错误返回 `{message, code}`：目标不存在 404、不可捕获/非 tmux 409、捕获不可用 503、
未配置公网发布 503（`SNAPSHOT_PUBLISH_NOT_CONFIGURED`）、超过单份上限 413、并发满 429、
Host 存储满 507、其他上传失败 502（`SNAPSHOT_PUBLISH_FAILED`）。上传失败不保存本地副本或
退回内网链接；Host 端存储失败为 500，源 Backend 将其归为上传失败。

## 内容与 UI

- 仅捕获请求指定 Panel 的 tmux 当前屏幕及仍保留的历史，不合并分屏，不回退其他 Panel。
  已清理历史、全屏 TUI 的过去每帧和非 tmux Session 不在支持范围内。
- Host 持久化起固定 24 小时有效，不实时更新、不滑动续期、不可提前撤销。
  源终端输出、删除或源机器离线均不改变快照。
- 初始 HTML 包含完整正文与连续逻辑行号；Agent 不需要执行 JS 或另调接口。正文转义，不加载
  外部资源，不自动链接文本。CSP 仅允许固定 CSS/选行脚本，响应 no-store，无 ETag/304 捷径。
- 点击行号选单行，Shift 点击选范围，URL 如 `#L25-L28`；刷新恢复定位。折行不改变逻辑行号，
  无效或越界 hash 清除高亮，不隐藏正文。浏览器原生搜索、选取和复制照常可用。
- 一次创建绑定点击时的 Backend 和 Panel；进行中防止重复提交。切换连接后仍保留原结果，
  剪贴板失败保留手动复制/打开入口，不自动重试创建。签名链接只留页面内存，不写入持久存储。

## 存储与部署

Host 存储目录由 `RUNWEAVE_SNAPSHOT_HOST_DIR` 指定，目录 0700、记录及 `.signing-key` 0600。
独立 32 字节密钥和快照须一起备份；重启复用密钥，损坏时初始化失败，不静默替换。
业务 Backend 不初始化快照存储，也不清理历史版本遗留的文件。

单份正文最多 10 MiB；Host 全局最多 100 份、合计序列化后 100 MiB。容量不足明确失败，
不截断、不删除有效记录腾空间；每分钟清理过期记录，读取到期检查不依赖清理及时性。
上传并发上限 4，专用上传凭据与登录认证、只读签名完全分离。配置与部署见
[公网终端快照托管](../deployment/snapshot-share.md)。

完整签名 URL 是读取授权，不记录正文、签名、密钥或完整 URL 到日志。分享入口使用 HTTPS；
正文不自动脱敏，持有链接者可以保存或转发内容，到期不能收回已下载的数据。

验收入口：[终端快照分享计划](../testing/terminal/snapshot-share.testplan.yaml)。

历史本地存储版本的签名、匿名读取与 tunnel 隔离验证不能替代当前公网 Host 链路验收。
Host 重启持久化、源端离线、字节/并发上限、代理链路与真实剪贴板拒绝仍需按当前部署分别取证；
本轮文档整理没有重跑这些行为。
