# AGENTS

面向编码智能体的高层路由与最小默认行为。就近约束优先：`packages/common/AGENTS.md` 等子目录规范在其作用域内覆盖本文件。

## 项目概览

- 项目名：Runweave
- 前端：React + Vite
- 后端：Express + WebSocket + Playwright 控制
- Electron 桌面客户端：electron/（多后端连接管理）
- App：Ionic React + Capacitor（app/）
- 共享协议：packages/shared

## 最小命令

- 开发：`pnpm dev`
- Electron 开发：`pnpm dev:electron`
- 构建：`pnpm build`
- Electron mac 打包：`pnpm dist:electron:mac`
- 类型检查：`pnpm typecheck`
- Lint：`pnpm lint`

## 硬约束

超出常识默认、必须遵守的项目专属规则。分领域列出。

### 验收与改动约束

- 本仓库不写单测/TDD，不新增单元测试文件。验证靠 `pnpm typecheck`、`pnpm lint`、`frontend/tests/*.spec.ts` 的 Playwright E2E，以及实际行为核对。
- 新增或重写测试计划必须使用 `docs/testing/**/*.testplan.yaml`，严格遵循 `docs/testing/test-plan-format.md`；Agent Team 不接受 Markdown 测试案例文件。落盘后运行 `pnpm testplan:validate <path>`。
- 若计划或验收里承诺了 Playwright/浏览器验证，完成前必须实际执行 `$toolkit:playwright-cli` 并给出命令或关键证据；未执行则明确写「未执行 + 阻塞原因」，禁止用静态检查/代码阅读/截图冒充。
- 每一行改动都必须能追溯到本次需求来源；不顺手「优化」相邻代码、格式、注释，只清理自己改动产生的孤儿。

### 包边界（详情）

`packages/common`（`@runweave/common`）只放 Web 与 App 都实际复用的前端代码，且只允许子路径导入（如 `@runweave/common/terminal`），不加根导出。新增/移动导出前必须写出 Web 与 App 两个真实调用方；backend/Electron/CLI/协议/DTO/存储/跨运行时合约一律进 `packages/shared`。完整规则见 `packages/common/AGENTS.md`。

`packages/shared`（`@runweave/shared`）是前后端共享合约包，放类型、协议、DTO、跨 backend/frontend/app/electron/CLI 的纯 TS 合约；不要因为「未来可能复用」把 App-only 或 Web-only 代码迁进 `packages/common`；计划里写成 `packages/commom` 按拼写错误处理。

### App 架构与 UI

- `app/` 是 Ionic React + Capacitor App，必须保留 `setupIonicReact()` 与 Ionic core/structure/typography CSS 作为 App 基础运行时。
- App 页面壳层优先使用 Ionic primitives：`IonApp`、`IonPage`、`IonContent`、`IonRefresher`、`IonModal`、`IonPopover`、`IonAlert`、`IonInput`、`IonTextarea`、`IonList`、`IonItem`。
- 高密度自定义区域不要直接混用 `IonButton` 做固定布局按钮，尤其是 terminal header、bottom tab、preview toolbar、file/diff action bar、composer action slot。这里使用原生 `<button type="button">` + 项目 CSS 控制尺寸、颜色、触摸态；图标可继续使用 `IonIcon`。
- 不要把 Ionic Web Component 直接作为 CSS grid/flex 的固定 action slot，除非该区域整体采用 Ionic toolbar/header 体系。若需要 Ionic overlay，触发器用原生按钮，overlay 仍可用 `IonPopover` / `IonModal`。

### Electron 打包

- 默认仅打包当前本地可用的 mac 客户端，使用 `pnpm dist:electron:mac`。
- 不要默认打包 Windows 客户端，也不要为了兼容性额外生成 Windows 安装包，除非用户明确提出。

### 操作与验证技能

- `$computer-use` 和 `$toolkit:playwright-cli` 都是本项目高价值技能；遇到真实桌面端、浏览器页面、终端页面联动的场景时，优先把两者结合使用，而不是停留在代码阅读或命令行猜测。
- 分工：`$computer-use` 管本机桌面端、系统弹窗、应用启动/重启、菜单、安装器，以及进入 Runweave 桌面端具体页面；`$toolkit:playwright-cli` 管打开 Web/App 页面、点击、输入、截图、读 DOM 和浏览器自动化验收。
- 涉及浏览器页面复现、修复或验收时，必须用 `$toolkit:playwright-cli`，不要用 `$computer-use` 或其它方案替代。两端都涉及时，先用 `$computer-use` 把环境准备到目标状态，再用 `$toolkit:playwright-cli` 做页面级验证与取证。

### Runweave 变更验证门禁

- 任何任务只要需要实际执行 `pnpm dev:session`、`pnpm dev:status`、`pnpm dev:open` 或 `pnpm dev:stop`，必须使用 `$toolkit:runweave-dev-session` 管理准确 worktree、Session ID、profile、surface 与清理；纯概念说明或只读代码分析不触发。
- `$toolkit:runweave-dev-session` 是 Dev Session 生命周期技能，不自动扩大为完整代码变更验收。若显式调用 `$toolkit:runweave-change-validation`，两者组合使用：前者负责 Session 操作，后者负责 patch 边界、真实行为验收和证据合同。
- `$toolkit:runweave-change-validation` 仅在用户当前请求中显式点名时触发；不因普通代码修改、Bug 修复、功能实现、重构、运行行为、共享协议、服务生命周期或 UI/CDP 验收自动使用，也不跨请求延续触发状态。
- 未显式调用该技能时，按当前任务执行范围相称的验证，不默认启动完整 Dev Session。显式调用后，才应用以下全部门禁。
- 顺序固定为：完成最小代码修改 → 固定本次 patch 边界 → 在只包含本次 patch 的 source root 首次执行无显式 profile 的 `pnpm dev:session --dry-run --json` → 检查影响闭包 → 启动、验收并停止 Dev Session。
- planner 给出的范围高于预期时，先检查是否误改公共契约或扩大消费者闭包；禁止显式向下降级。用户明确要求安装态、跨版本或桌面目标时可以提升 profile。
- 未提交代码的验证环境只允许通过 `pnpm dev:session` 启动，后续只通过 `dev:status`、`dev:open`、`dev:stop` 管理；其余直接启动 Backend、App Server、Electron、Beta、手工 profile/端口或跳过 planner 的入口一律视为绕过。目标入口只从 `dev:status` 和 `dev:open` 解析。
- Runweave UI/浏览器验收必须先用 `pnpm dev:open --session <id> --surface <surface> --json` 解析目标，再用 `$toolkit:playwright-cli` 的 `attach --cdp=<endpoint>` 显式附着该实例；禁止用 `playwright-cli open`、系统浏览器、headless 浏览器、默认 endpoint、环境变量或既有无关 Playwright session 替代。附着失败或目标 profile 不提供所需 CDP surface 时必须停止并报告环境阻塞。
- Electron 主窗口和终端标签使用 `desktop` CDP；终端右侧内嵌 Browser 使用 `terminal-browser` CDP。需要在右侧验收 Web 页面时，分别从 `web` surface 取得 URL、从 `terminal-browser` surface 取得 CDP endpoint，附着后只在本次新建的 Browser tab 中导航。验收结束必须关闭本次新建的 tab 并 `detach`；不得关闭桌面窗口、外部 Browser 或用户已有 tab。
- 当前工作区包含无关改动时，使用独立 worktree 仅应用本次 patch，不 stash、reset 或混入他人改动；验收结束必须 `dev:stop` 并确认 dedicated 资源已清理。
- `validationSessionId` 不允许任意命名：默认让第一次 `dev:session start` 自动生成并从 JSON 结果捕获；必须预先声明时使用 `rcv-YYYYMMDD-<hash6>`，其中 `hash6` 固定取 `SHA-256("<baselineRevision>\n<scenarioId>")` 前 6 位小写十六进制。与 `$toolkit:reproduce-before-fix` 组合时修复前后复用该 ID；第二次启动前先停止 Session 并归档 before manifest/证据，最终按 Before/After 并列呈现。同一 ID 因既有用户现场无法复用时，必须记录原 session ID、验证 session ID 和不能复用的原因。

## 编码约定

- 前端与 App 代码优先使用 `ahooks` 的 `useMemoizedFn` 处理稳定函数引用；如需使用 `useCallback` / `React.useCallback`，先说明原因与替代方案，不要静默引入。

## 通用工作准则

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

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

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Define the invalid inputs, then verify each is rejected via typecheck/lint + actual behavior (Playwright E2E if it's a browser path)"
- "Fix the bug" → "Reproduce it first (steps or a Playwright E2E case), then confirm the fix makes it pass"
- "Refactor X" → "Ensure `pnpm typecheck`/`pnpm lint` pass and behavior is unchanged before and after"

> 本仓库不写单测/TDD。验证靠 `pnpm typecheck`、`pnpm lint`、`frontend/tests/*.spec.ts` 的 Playwright E2E，以及实际行为核对——不要用「写单元测试」作为验收手段。

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## 去哪查更多

需要具体架构、部署、CLI、质量或测试细节时，`docs/README.md` 是唯一完整索引，按需读取，不要在本文件重复维护路由表。
