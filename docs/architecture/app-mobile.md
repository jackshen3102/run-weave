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

## 验证与文档归属

原生应用的构建、系统要求、数据存储和内部实验室约束统一维护在包内文档。
验收计划位于 `docs/testing/app/ios-native-*.testplan.yaml`，
当前问题与证据边界见 [验收状态](../../packages/app-ios/docs/validation-status.md)。
历史 Ionic/Capacitor 客户端已退役，其源码与迁移过程可从 Git 历史查阅。
App Server 是独立的桌面事件服务，名称中的 App 不表示旧移动客户端依赖。
