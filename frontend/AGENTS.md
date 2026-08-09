# Web 前端

`frontend/` 是 React + Vite 的 Web UI，也是 Electron 主窗口加载的 renderer。

## 先看哪里

- 应用装配、路由和 Electron bridge 类型：`src/App.tsx`
- 页面级入口：`src/pages/`
- 按能力聚合的状态与 UI：`src/features/`
- 后端 HTTP 调用：`src/services/`
- 端到端测试允许位置：`tests/`（当前无 tracked spec，实际清单以 Git 为准）
- 终端与跨端共享 UI：`@runweave/terminal-renderer`、`@runweave/common/terminal`

## 边界

- 页面和组件不反向被 `src/services/` 导入；服务层只处理协议调用与数据转换。
- 跨 backend/frontend/electron/app 的 DTO 或协议进入 `packages/shared`，不要在前端复制。
- 只有 Web 与 App 当前共同使用的前端代码才进入 `packages/common`；完整规则见
  `../packages/common/AGENTS.md`。
- Electron 能力通过 `window.electronAPI` / `window.companionAPI` bridge 使用，不从前端直接导入
  Electron 主进程模块。
- 不新增单元测试；浏览器行为按 `../docs/testing/README.md` 选择 YAML 计划并使用真实
  Playwright 验证。不要引用不存在的历史 spec。

## 验证

```bash
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
```

`pnpm --filter @runweave/frontend test:e2e` 是保留的 Playwright 入口，但当前会因无 tracked spec
返回 `No tests found`；它不是通过证据。涉及浏览器页面验收时继续遵守根 `AGENTS.md` 的
Playwright 与 Dev Session 门禁。
