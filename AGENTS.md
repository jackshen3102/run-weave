# AGENTS

面向编码智能体的高层路由与最小默认行为。

## 项目概览

- 项目名：Runweave
- 前端：React + Vite
- 后端：Express + WebSocket + Playwright 控制
- Electron 桌面客户端：electron/（多后端连接管理）
- 共享协议：packages/shared

## 公共包边界

- `packages/common`（包名 `@browser-viewer/common`）只服务 Web 和 App 的公共前端代码。这里的“公共”必须是 Web 与 App 都实际复用的浏览器端 helper、前端组件或共享样式资产。
- 用户或计划中写成 `packages/commom` 时，按拼写错误处理；实际目录始终使用 `packages/common`。
- `packages/shared`（包名 `@browser-viewer/shared`）负责前后端代码复用，主要是类型、协议、DTO、跨 backend / frontend / app / electron / CLI 的纯 TS 合约。
- 不要把 backend、Electron、CLI、协议、DTO、存储模型或跨运行时合约放进 `packages/common`；这类代码应进入 `packages/shared`。
- 不要因为“未来可能复用”把 App-only 或 Web-only 代码迁入 `packages/common`。新增 common 导出前，必须能指出 Web 与 App 两边的真实调用方，或同一个变更中补齐两边调用方。
- `@browser-viewer/common` 只允许显式子路径导入，例如 `@browser-viewer/common/terminal`；不要添加根导出，也不要从 `@browser-viewer/common` 根路径导入。

## 最小命令

- 开发：`pnpm dev`
- Electron 开发：`pnpm dev:electron`
- 构建：`pnpm build`
- Electron mac 打包：`pnpm dist:electron:mac`
- 类型检查：`pnpm typecheck`
- Lint：`pnpm lint`
- 测试：`pnpm test`

## 本地 URL 复现约束

- 打开页面复现或修复问题时，使用 `$playwright-cli`。

## App 架构与 UI 约束

- `app/` 是 Ionic React + Capacitor App，必须保留 `setupIonicReact()` 与 Ionic core/structure/typography CSS 作为 App 基础运行时。
- App 页面壳层优先使用 Ionic primitives：`IonApp`、`IonPage`、`IonContent`、`IonRefresher`、`IonModal`、`IonPopover`、`IonAlert`、`IonInput`、`IonTextarea`、`IonList`、`IonItem`。
- 高密度自定义区域不要直接混用 `IonButton` 做固定布局按钮，尤其是 terminal header、bottom tab、preview toolbar、file/diff action bar、composer action slot。这里使用原生 `<button type="button">` + 项目 CSS 控制尺寸、颜色、触摸态；图标可继续使用 `IonIcon`。
- 不要把 Ionic Web Component 直接作为 CSS grid/flex 的固定 action slot，除非该区域整体采用 Ionic toolbar/header 体系。若需要 Ionic overlay，触发器用原生按钮，overlay 仍可用 `IonPopover` / `IonModal`。

## Electron 打包约束

- 默认仅打包当前本地可用的 mac 客户端。
- 使用命令：`pnpm dist:electron:mac`
- 不要默认打包 Windows 客户端，也不要为了兼容性额外生成 Windows 安装包，除非用户明确提出。

## 前端测试约束

- 前端项目禁止使用 TDD，不使用 `test-driven-development` skill 为前端代码补单测。
- 前端 `src/` 下的 `*.ts`、`*.tsx` 与面向 UI 的 React hooks 均不新增单测，不新增 `*.test.ts`、`*.test.tsx`、`*.spec.tsx`、`*.ui.test.tsx`。
- 前端变更只保留 E2E 作为正式自动化验证手段；必要时可补充手工回归，但不再为前端逻辑维护 Vitest 覆盖。
- 如需调整前端测试配置，保持前端测试入口指向 Playwright E2E，不为前端设置 Vitest coverage 阈值。

## 文档路由（按需读取）

| 需求           | 阅读                                  |
| -------------- | ------------------------------------- |
| 架构/网络拓扑  | docs/architecture/network-topology.md |
| 质量体系概览   | docs/quality/quality-harness.md       |
| 测试层级与命名 | docs/testing/layers.md                |
| 测试命令选择   | docs/testing/command-matrix.md        |
| 终端回归       | docs/testing/runbooks/terminal-vim.md |
| 部署/环境概览  | docs/deployment/overview.md           |
| 文档总入口     | docs/README.md                        |

# 架构规范

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
