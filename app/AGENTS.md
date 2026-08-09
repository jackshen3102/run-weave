# 移动 App

`app/` 是 Ionic React + Capacitor 客户端，通过 Runweave Backend 管理项目、终端和文件预览。

## 先看哪里

- Ionic 应用装配：`src/App.tsx`
- 路由与页面入口：`src/routes/AppRoutes.tsx`
- 会话与连接生命周期：`src/hooks/use-app-session.ts`
- 页面：`src/pages/`
- Backend 调用：`src/services/`
- 本地凭据与 UI 状态：`src/store/`
- 移动端架构边界：`../docs/architecture/app-mobile.md`

## 边界

- 保留 `setupIonicReact()`、`IonApp` 和 Ionic core/structure/typography CSS 基础运行时。
- 页面壳层与 overlay 使用 Ionic primitives；高密度固定 action slot 使用原生
  `<button type="button">`，不要把 `IonButton` 或 Ionic Web Component 强塞进固定 grid/flex slot。
- 跨端协议进入 `packages/shared`；与 Web 当前共同使用的前端代码才进入 `packages/common`。
- 终端渲染优先复用 `@runweave/terminal-renderer`，不要在 App 内复制 xterm 生命周期。
- 不新增单元测试；真实 App 行为按 `docs/testing/app/` 的测试计划验收。

## 验证

```bash
pnpm --filter @runweave/app typecheck
pnpm --filter @runweave/app lint
pnpm app:build
```

涉及 iOS 或真实设备时，再按根 `README.md` / `README.zh-CN.md` 的 App 命令执行，不把设备构建当作
普通文档或 Web 改动的默认门禁。
