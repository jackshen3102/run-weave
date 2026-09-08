# 原生 iOS 客户端

Runweave 的移动应用位于 `packages/app-ios/`，由 SwiftUI/UIKit 与 SwiftTerm 构成。
其 Xcode host 和 Swift package 可独立构建，不依赖 Web/Electron UI 或前端构建产物。
使用、安装与诊断入口见 [iOS README](../../packages/app-ios/README.md)，
内部架构和状态生命周期见 [iOS 架构](../../packages/app-ios/docs/architecture.md)。

## 跨运行时边界

- iOS 通过 Backend 的 HTTP/WebSocket 获取认证、项目、终端与文件预览，不导入服务端实现。
- `/api/app/home/overview` 与认证头 `X-Auth-Client: app` 是当前原生客户端继续使用的协议，不能随旧 UI 一并删除。
- Backend 拥有远端 TerminalState、tmux/PTY 和项目权限；客户端关闭页面只释放自己的连接。
- 手机连接状态与终端运行状态分别管理，重连不能排队补发离线输入。
- 移动端提供命令输入、媒体草稿与 Files/Changes 只读审阅；不直接复用桌面布局、Monaco 或 Browser 控制面。
- Swift DTO 手动对照 `packages/shared` 的接口合同；协议变更需验证真实 Backend 与客户端兼容。

## 手机扫码登录

Electron 已登录连接的“当前连接 → 连接手机”入口与 iOS 连接管理的“扫码连接电脑”配合使用。
手机需直接访问该 Backend，手动地址和账号密码登录继续保留；本功能不提供公网中继或设备发现。
内置本地连接通过 Electron runtime report 取得当前局域网地址；自定义连接保留完整 HTTP(S)
地址及代理路径，不能把任意 localhost 转发猜成内置 Backend，也不修改监听地址、TLS 或 ATS。

协议入口是 [mobile-login 合同](../../packages/shared/src/auth/mobile-login.ts)，
服务端状态由 [MobileLoginService](../../backend/src/auth/mobile-login.ts) 独占。
二维码包含 180 秒有效的临时授权信息，不包含已有账号密码或登录 Token。一个请求只绑定一个
claimant，桌面确认绑定具体 claimId；批准后才通过现有 AuthService 签发独立的 app 会话。
签发前与持久化后均检查 owner 会话，持久化期间失效则撤销新会话且不交付凭据。

并发或重复 exchange 最多签发一个会话，原结果只在内存保留 120 秒供同一 claimant 重试。
只有手机携带该新会话 Bearer 发出 complete，桌面才显示“手机已登录”。回执缺失或旧请求到期
不撤销已经签发的普通手机会话；Backend 重启丢弃扫码临时状态，保留正常认证持久化。
临时秘密只存 SHA-256 摘要，完成时清除结果与 QR 摘要；接口禁止缓存，客户端不转发登录 POST 重定向。
活跃请求最多 64 条、含终态最多 256 条；创建限每 owner 每分钟 10 次，短期接口限每 IP 240 次、
每 requestId 180 次。到期清理请求与限流计数器，容量不足可淘汰最旧终态。

桌面控制器绑定连接 ID、完整地址和登录 sessionId，换码与退出用 generation 隔离迟到响应。
iOS 扫码使用独立临时客户端，不借用原连接 Bearer；相机只在主动扫码且前台时运行。
按规范化完整 URL 复用连接 ID 和用户命名，收到结果后先写 Keychain，再保存连接记录，发送完成
回执后才激活首页。连接保存失败时补偿恢复旧凭据，补偿失败明确报错；Keychain 与 UserDefaults
不构成原子事务，UserDefaults 仍遵循平台的异步持久化语义。完成回执失败保留已保存登录，允许重试
确认或进入首页；首页数据加载失败也不删除登录。

验收分为 [跨端交互](../testing/app/mobile-qr-login.testplan.yaml) 与
[协议和凭据](../testing/app/mobile-qr-login-protocol.testplan.yaml)，构建和模拟手机 HTTP 请求不能代替真实相机闭环。

## 验证与文档归属

原生应用的构建、系统要求、数据存储和内部实验室约束统一维护在包内文档。
验收计划位于 `docs/testing/app/ios-native-*.testplan.yaml`，
当前问题与证据边界见 [验收状态](../../packages/app-ios/docs/validation-status.md)。
历史 Ionic/Capacitor 客户端已退役，其源码与迁移过程可从 Git 历史查阅。
App Server 是独立的桌面事件服务，名称中的 App 不表示旧移动客户端依赖。
