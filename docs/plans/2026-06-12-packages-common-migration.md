# packages/common 公共包迁移计划

## 背景与目标

本计划用于新增 `packages/common`，但准入标准必须严格：只有 App 和 Web 都实际复用的前端组件、样式或浏览器端纯逻辑才放进 common。不能因为代码“看起来纯”或“未来可能复用”就迁移。

当前仓库已经有 `packages/shared`，它负责协议、DTO、跨 backend / frontend / app / electron / CLI 的纯 TS 合约；`packages/common` 只服务 App 和 Web 的前端公共层，不替代 `shared`。

推荐包名：`@runweave/common`。用户提到的 `commom` 按拼写错误处理，落地目录使用 `packages/common`。

## Common 准入标准

代码进入 `packages/common` 必须满足下面至少一条：

1. 当前 App 和 Web 已经都有调用方，迁移后两个调用方都会从 `@runweave/common` 引入。
2. 当前只有一边在用，但同一个实施阶段会补齐另一边调用方，且有明确接入文件和验收方式。
3. 是 App 和 Web 都 import 的共享样式资产，迁移后两边样式入口都会改到 common。

不满足以上条件的代码保留原地。后续出现真实第二个调用方时再迁。

## 当前代码事实

- `pnpm-workspace.yaml` 已包含 `packages/*`，新增 `packages/common` 不需要调整 workspace glob。
- `packages/terminal-renderer` 当前是独立包，导出 `TerminalRenderer` 组件和 `./terminal-renderer.css`。
- App 当前实际使用 `TerminalRenderer`：`app/src/pages/AppTerminalPage.tsx` 和 `app/src/hooks/use-app-terminal-connection.ts` 从 `@runweave/terminal-renderer` 引入类型/组件。
- Web 当前没有使用 `TerminalRenderer` 组件；Web 只在 `frontend/src/index.css` import 了 `@runweave/terminal-renderer/terminal-renderer.css`。
- Web 主终端仍在 `frontend/src/components/terminal/use-terminal-emulator.ts` 里直接初始化 xterm，并绑定 SearchAddon、WebLinksAddon、tmux wheel、粘贴图片、IME、性能探针等 Web 专属行为。
- `frontend/src/components/terminal-page.tsx` 还有一条旧的直接 xterm 初始化路径，也重复了 auto-response 过滤和 Shift+Enter 处理。
- App 和 Web 都有实际调用的重复纯逻辑目前主要是 `fileToBase64`、`shellQuote`。
- `isTerminalAutoResponse`、`isShiftEnterLineFeed` 当前被 Web 直接使用，也被 `packages/terminal-renderer` 内部使用；如果 `terminal-renderer` 仍服务 App，则可通过让 `terminal-renderer` 依赖 common 来形成 App/Web 双边复用。

## 候选项结论

| 候选                                                 | 当前使用情况                                                                                                   | 是否进首批 common                               | 结论                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `fileToBase64`                                       | App: `app/src/lib/terminal-input-assets.ts`；Web: `frontend/src/components/terminal/terminal-surface-utils.ts` | 是                                              | 两边已有真实调用，迁入 `common` 后两边改 import。                                   |
| `shellQuote`                                         | App 和 Web 同上                                                                                                | 是                                              | 两边已有真实调用，迁入 `common` 后两边改 import。                                   |
| `isTerminalAutoResponse`                             | Web 直接使用；`terminal-renderer` 内部使用，App 通过 renderer 间接使用                                         | 是，但必须让 `terminal-renderer` 从 common 引入 | 迁移后 Web 与 App renderer 共用同一过滤逻辑。                                       |
| `isShiftEnterLineFeed`                               | Web 直接使用；`terminal-renderer` 内部使用，App 通过 renderer 间接使用                                         | 是，但必须让 `terminal-renderer` 从 common 引入 | 以 Web 更严格的 modifier 判断为准，避免 Shift+Alt/Ctrl/Meta+Enter 被误判。          |
| `TerminalRenderer` 组件                              | App 实际使用；Web 未使用组件，只使用 CSS                                                                       | 否，除非同阶段让 Web 接入组件                   | 不能只因为它是公共包候选就移动到 common。                                           |
| `terminal-renderer.css`                              | App 和 Web 都 import                                                                                           | 可进，但只作为共享样式资产                      | 如果组件暂不迁，CSS 可迁到 `common` 的 styles subpath，或暂留旧包，避免拆散 owner。 |
| `createResizeScheduler`                              | Web only                                                                                                       | 否                                              | 当前没有 App 调用方；不为了“可能复用”迁移。                                         |
| `shouldSuppressWheelInput`                           | Web only                                                                                                       | 否                                              | Web terminal 专属滚轮策略，保留 Web。                                               |
| `DEFAULT_TERMINAL_PREFERENCES` / renderer preference | Web only                                                                                                       | 否                                              | App 没有偏好设置调用方。                                                            |
| `formatRelativeTime`                                 | App only                                                                                                       | 否                                              | App home/terminal UI 专属，保留 App。                                               |
| `buildMobileDiff` / `MobileDiffView`                 | App only                                                                                                       | 否                                              | 当前只服务 App changes tab，保留 App。                                              |
| `terminal-file-format.ts`                            | App alias 到 `packages/shared` helpers                                                                         | 否                                              | 真实 owner 已在 `shared`，不搬到 common。                                           |

## 推荐实施路线

### 阶段 1：只建立真正双边复用的 common utilities

文件范围：

- 新增 `packages/common/package.json`
- 新增 `packages/common/tsconfig.json`
- 新增 `packages/common/src/index.ts`
- 新增 `packages/common/src/terminal/input-assets.ts`
- 新增 `packages/common/src/terminal/key-events.ts`
- 新增 `packages/common/src/terminal/output-filter.ts`
- 新增 `packages/common/src/terminal/index.ts`

导出建议：

```json
{
  "name": "@runweave/common",
  "exports": {
    ".": "./src/index.ts",
    "./terminal": "./src/terminal/index.ts"
  }
}
```

迁移内容：

- `fileToBase64`
- `shellQuote`
- `isTerminalAutoResponse`
- `isShiftEnterLineFeed`

调用方改造：

- `app/src/pages/AppTerminalPage.tsx` 从 `@runweave/common/terminal` 引入 `fileToBase64`、`shellQuote`。
- `frontend/src/components/terminal/use-terminal-emulator.ts` 从 `@runweave/common/terminal` 引入 `fileToBase64`、`shellQuote`、`isTerminalAutoResponse`、`isShiftEnterLineFeed`。
- `frontend/src/components/terminal-page.tsx` 从 `@runweave/common/terminal` 引入 `isTerminalAutoResponse`、`isShiftEnterLineFeed`。
- `packages/terminal-renderer/src/TerminalRenderer.tsx` 从 `@runweave/common/terminal` 引入 `isTerminalAutoResponse`、`isShiftEnterLineFeed`，从而让 App 的 renderer 路径也复用同一逻辑。

依赖要求：

- `app/package.json` 添加 `@runweave/common: workspace:*`。
- `frontend/package.json` 添加 `@runweave/common: workspace:*`。
- `packages/terminal-renderer/package.json` 添加 `@runweave/common: workspace:*`。

验证：

- `pnpm --filter @runweave/common typecheck`
- `pnpm --filter @runweave/terminal-renderer typecheck`
- `pnpm --filter @runweave/app typecheck`
- `pnpm --filter @runweave/frontend typecheck`

### 阶段 2：处理 terminal CSS owner

当前 `terminal-renderer.css` 被 App 和 Web 都 import，但它挂在 `@runweave/terminal-renderer` 包下。这里有两个可选方案，只选一个：

方案 A：暂不迁 CSS。

- 保持 `app/src/main.css` 和 `frontend/src/index.css` 继续 import `@runweave/terminal-renderer/terminal-renderer.css`。
- 优点：不拆散 CSS 与 renderer 组件 owner。
- 缺点：Web 仍依赖 renderer 包只是为了 CSS。

方案 B：只迁共享 CSS 到 common。

- 新增 `packages/common/src/styles/terminal-renderer.css`。
- `@runweave/common` 导出 `./terminal-renderer.css`。
- App/Web CSS 入口都改为 `@runweave/common/terminal-renderer.css`。
- `packages/terminal-renderer` 如仍保留组件，可删除自身 CSS export 或改成兼容转发，但不要长期双维护两份 CSS。

推荐：如果阶段 3 不会马上让 Web 接入 `TerminalRenderer`，优先选方案 A，避免为了 common 拆 package。

验证：

- `rg -n "terminal-renderer.css|@runweave/terminal-renderer" app frontend packages package.json pnpm-lock.yaml`
- 如果选择方案 A，预期只有 App/Web CSS 和 renderer 包本身保留旧 CSS 引用。
- 如果选择方案 B，预期 App/Web CSS 都改到 `@runweave/common/terminal-renderer.css`，且没有两份 CSS 内容。

### 阶段 3：terminal-renderer 是否迁入 common 的决策

`TerminalRenderer` 不能单独迁入 common，因为当前 Web 没有使用该组件。要迁入 common，必须同阶段完成 Web 接入，否则保留 `packages/terminal-renderer`。

可选路线：

路线 A：暂不迁 `TerminalRenderer` 组件。

- 保留 `packages/terminal-renderer` 独立包。
- 只让它复用 `@runweave/common/terminal` 的 key/output helpers。
- 后续等 Web terminal 有明确接入方案时再迁。

路线 B：迁 `TerminalRenderer` 进 common，并同阶段让 Web 使用。

必须同时完成：

- 将 `packages/terminal-renderer/src/*` 移到 `packages/common/src/terminal-renderer/*`。
- `@runweave/common` 导出 `./terminal-renderer` 和 `./terminal-renderer.css`。
- App import 改为 `@runweave/common/terminal-renderer`。
- Web 至少一条真实 terminal surface 接入 `TerminalRenderer`，不能只改 CSS 或 package dependency。
- Web 专属能力通过 `onTerminalReady` 或新增稳定扩展点注入，包括 SearchAddon、WebLinksAddon、tmux wheel、copy-on-select、paste image upload、IME mobile beforeinput、performance probe。

路线 B 风险较高，不建议和阶段 1 混在同一个提交里。它需要独立设计 Web adapter，否则容易回归 Web 终端行为。

验证：

- 自动：`pnpm --filter @runweave/common typecheck`、`pnpm --filter @runweave/app typecheck`、`pnpm --filter @runweave/frontend typecheck`
- 浏览器：如做 Web/App terminal 行为回归，必须使用 `$playwright-cli`。覆盖 Web terminal 打开、输入、resize、搜索、链接打开、粘贴图片、tmux 滚轮；覆盖 App terminal 打开、输入、滚动。

## 本次明确不迁移

- `frontend/src/features/terminal/resize-scheduler.ts`：Web only。
- `frontend/src/features/terminal/wheel-input.ts`：Web only。
- `frontend/src/features/terminal/preferences.ts`：Web only。
- `app/src/lib/terminal-home-view-model.ts` 的 `formatRelativeTime` 和 `buildTerminalHomeGroups`：App only。
- `app/src/lib/mobile-diff.ts` 与 `app/src/components/MobileDiffView.tsx`：App only。
- App/Web 的 HTTP service、认证、support logs、Ionic 页面组件、Electron bridge、Zustand preview store。
- `packages/shared` 中已有的协议、DTO、terminal preview core helper。

## 验收标准

- `packages/common` 中的每个导出都能指出 App 和 Web 两边的实际调用方。
- 不存在“当前只有一边调用，但因为未来可能复用所以先进 common”的代码。
- `fileToBase64`、`shellQuote`、`isTerminalAutoResponse`、`isShiftEnterLineFeed` 的重复实现被收敛，且 App/Web 路径都使用 common owner。
- 如果迁移 `TerminalRenderer` 组件，Web 必须在同阶段真实接入该组件；否则组件继续留在 `packages/terminal-renderer`。
- `pnpm --filter @runweave/common typecheck`、`pnpm --filter @runweave/terminal-renderer typecheck`、`pnpm --filter @runweave/app typecheck`、`pnpm --filter @runweave/frontend typecheck` 通过。

## 建议提交拆分

1. 新增 `packages/common`，只迁 App/Web 已双边复用的 terminal utilities。
2. 让 `packages/terminal-renderer`、App、Web 都改用 common terminal utilities。
3. 视阶段 3 决策，单独处理 terminal CSS owner。
4. 如要迁 `TerminalRenderer`，单独提交 Web adapter 接入和组件迁移；否则不迁。
