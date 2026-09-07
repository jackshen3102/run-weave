# 随记原生库与宿主

`SuijiIOS` 为独立 SwiftUI 功能库，`ios/Suiji` 只装配根视图与签名。
不导入 RunweaveIOS、SwiftTerm、SwiftUIX，不复制已有 App 的团队标识。

- `APIClient` 固定端点，无 Cookie；切换连接必须取消旧 client 并隔离响应。
- `DraftStore` 作用域包含 endpoint/serverId/ownerId；正文与附件不写 UserDefaults。
- 请求意图先落盘再发送；联网、前台恢复、登录和进程启动不能触发业务写重试。
- 不用新的幂等键绕过未知保存结果；任务状态操作单独持久化。
- 纯展示组件不读凭据、不发网络；主题集中在 `DesignSystem`。

构建与真实 HTTP DTO 验证见 [README](./README.md)。原生 UI 必须实际操作 Simulator 或设备取证。
