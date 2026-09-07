# iOS 架构与协议边界

Runweave iOS 是独立的原生客户端。Xcode host 装配 Swift package，Swift package 仅依赖 SwiftTerm，
业务数据通过 Backend HTTP/WS 获取。构建不读取其他客户端源码；协议兼容以真实接口和 Swift DTO 为准。

```text
ios/RunweaveNative → RootView → AppSession
                               ├─ APIClient → Backend HTTP
                               ├─ EventStream → terminal-events WS
                               └─ SessionController → terminal WS
                                      └─ SwiftTermSurface → UIKit / SwiftTerm
```

## 归属与生命周期

| 入口                                                        | 职责                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `App/RootView.swift`、`Features/Connections`                | 导航、连接管理和主题                                  |
| `State/ConnectionStore.swift`                               | 本地连接列表与当前连接，不保存明文凭据                |
| `State/AppSession.swift`                                    | 当前连接、认证、Home、草稿和 generation；丢弃过期响应 |
| `Services/APIClient.swift`                                  | 规范化 endpoint、认证、HTTP 错误分类与请求            |
| `Features/Terminal/SessionController.swift`                 | 终端连接、输入确认、事件与资源释放                    |
| `Features/Terminal/EventStream.swift`、`Rendering`、`Input` | 传输、解析显示和用户输入分别归属                      |
| `Features/Preview`、`Features/Media`                        | 只读审阅、上传与转写，业务错误由所属区域展示          |
| `State/DiagnosticStore.swift`、`ios/Diagnostics`            | 日常脱敏日志与内部验证入口，二者分开                  |

源码路径相对于 `Sources/RunweaveIOS`，host 及内部验证目录除外。
终端关闭释放本客户端资源，不结束远端 tmux；连接切换使旧请求、socket 和缓存失效。
设备 online/offline 与后端 TerminalState 分开管理；socket open 不等于业务已连接。

## 协议来源

Swift 不直接导入 TypeScript。修改接口时同时核对 Swift `Contracts/`、`Services/`、`Features/Terminal/`
与仓库的 `packages/shared/src`，并对真实 Backend 取证，不再维护依赖已删除客户端源码的迁移哈希。

| 能力       | Backend 合同                                                             |
| ---------- | ------------------------------------------------------------------------ |
| 认证与健康 | `/api/auth/*`、`/health`；`X-Auth-Client: app` 和 Bearer                 |
| 首页与事件 | `/api/app/home/overview`、`/ws/terminal-events`                          |
| 终端       | ticket、session metadata、terminal WS、input、interrupt、clipboard-image |
| 文件与变更 | `/api/terminal/project/:id/preview/*`，项目作用域与后端权限共同约束      |
| 语音       | `/api/voice/transcribe`，24 kHz WAV                                      |
| 诊断       | Backend diagnostic logs 的 start/stop/upload 合同                        |

`app` 是服务端认证与接口命名的一部分，删除旧客户端不重命名这些协议或改变权限。
Backend、Web/Electron 和 App Server 继续由仓库各自入口维护，iOS 不承担其进程生命周期。
