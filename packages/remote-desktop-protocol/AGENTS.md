# Native Remote Desktop Protocol

独立 Swift 原生合同与有界 TLS framing。仅依赖 Foundation、Security、CryptoKit 和 Network；不导入业务宿主、Backend 或 UI。

- 保持 iOS 15 API 可用性；macOS Host 15+。
- `RemoteTarget` 只存公开身份、端点与凭据引用；secret 仅出现于 TLS 内的瞬时认证消息，持久化到独立 Keychain service。
- 只有 exact certificate pin + 当前有效期 + 指定唯一 anchor + 系统 trust 成功才允许继续。
- 控制与媒体必须独立连接；媒体包含 session / display / revision。每条输入必须绑定同一身份，不能恢复或重放历史输入。
- framing 在分配大消息前检查长度；取消读取关闭底层连接，不能留下孤立接收任务。
- 不新增单元测试；遵循根规则用运行探针或既有验证，禁止以 `swift build` 代替 iOS UI 验收。
