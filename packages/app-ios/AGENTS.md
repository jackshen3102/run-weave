# Runweave iOS

- 本目录是可独立构建的 Swift package 与 Xcode App host；构建只需要 Xcode、Swift 依赖和可选的 Node 命令包装，不依赖 React、Capacitor 或 pnpm workspace。
- 仅通过 Backend HTTP/WS 协议工作，不导入 Backend、Electron 或 Web 实现。
- Swift DTO 位于 `Sources/RunweaveIOS/Contracts`；修改协议时核对仓库 `packages/shared` 中的 HTTP/WS 合同及实际 Backend 响应，见 [架构边界](docs/architecture.md)。
- 保持 Bundle ID `com.runweave.app.native` 及现有 Keychain、UserDefaults 标识，避免升级变成新安装或丢失登录态。
- `ios/Diagnostics` 仅在 Debug/Profile 启用；Release 不启用实验室或注入入口。
- 不新增单元测试。构建成功不代表原生 UI 或真机验收通过；测试合同和当前限制见 [验收状态](docs/validation-status.md)。
- 需要操作或验收真机时，统一使用 Xcode 构建、devicectl 安装及既有 XCUITest 执行器交互取证，见 [真机操作与取证](README.md#真机操作与取证)。
- 在本目录执行 `node scripts/ios.mjs doctor`、`node scripts/ios.mjs build --simulator <UDID>`；产物在本目录 `.build/ios/`，不提交个人签名设置或构建输出。
- 开发、安装、连接与诊断操作统一从 [README](README.md) 进入。
