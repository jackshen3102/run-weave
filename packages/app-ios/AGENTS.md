# 原生 iOS 候选客户端

- 本目录是独立 Swift package 与 Xcode App host；旧 `app/` 保留对照。
- 只通过 Backend HTTP/WS 协议工作，不导入旧 App、Backend、Electron 实现。
- Swift DTO 对照 `packages/shared`，来源和差异记录在 `docs/legacy-map.json`。
- Bundle ID 固定 `com.runweave.app.native`，凭据不与旧 App 共享。
- `ios/Diagnostics` 仅编入 Debug/Profile；Release 不包含 Probe 或注入入口。
- 不新增单元测试；使用根目录原生 YAML 门禁，未获得真实证据不得标为 verified。
- 显式验证：`pnpm --filter @runweave/app-ios ios:doctor`、`mapping:check`、
  `ios:build -- --simulator <UDID>`；构建和证据输出均在根 `.runweave/`。
- 运行方式与当前完成范围见 [README.md](./README.md)，技术门禁见
  [decisions.md](./docs/decisions.md)。
