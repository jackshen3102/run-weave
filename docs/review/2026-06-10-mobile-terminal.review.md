# Mobile Terminal 当前变更评审

日期：2026-06-10
模式：review-only，强力评审
范围：当前未提交 diff 与 untracked 文件，包括 App 终端触摸/键盘调整、iOS 工程变更、后端 CORS 默认 origin、诊断日志 recorder、移动端 tabs 计划文档。

## 架构 / 策略发现

### P1 - iOS 工程把最低系统版本和签名团队变成了本机状态

- 当前决策：为了接入 `@capacitor/keyboard`，当前 diff 同时提交了 iOS 工程生成物中的 `IPHONEOS_DEPLOYMENT_TARGET = 18.6`、`Package.swift` 的 `.iOS(.v18)`，以及 `DEVELOPMENT_TEAM = P9654G8Z76`。
- 为什么这是风险：这把一个移动端键盘行为修复升级成了发布/构建策略变更。项目 target 仍是 iOS 15.0，但 project/SPM 层被抬到 18.x，行为不一致；同时个人 Team ID 会让 CI 和其他开发者的签名环境被锁死到本机账号。
- 证据：`app/ios/App/App.xcodeproj/project.pbxproj:233`、`app/ios/App/App.xcodeproj/project.pbxproj:284`、`app/ios/App/App.xcodeproj/project.pbxproj:300`、`app/ios/App/App.xcodeproj/project.pbxproj:323`、`app/ios/App/CapApp-SPM/Package.swift:7`。
- 额外验证：本地 `@capacitor/keyboard` 8.0.3 自身声明 iOS 15：`node_modules/.pnpm/@capacitor+keyboard@8.0.3_@capacitor+core@8.4.0/node_modules/@capacitor/keyboard/Package.swift:7`、`node_modules/.pnpm/@capacitor+keyboard@8.0.3_@capacitor+core@8.4.0/node_modules/@capacitor/keyboard/CapacitorKeyboard.podspec:14`，所以 18.x 不是插件硬性要求。
- 更好的候选方案：
  - 推荐：保留 Keyboard 插件依赖和 Capacitor config，但重新同步/归一化 native 工程，保持 iOS deployment target 为 15.0；签名团队放到本地 Xcode 设置、未提交 xcconfig 或 CI secret，而不是提交到项目文件。
  - 可选：如果首版只为解决 keyboard resize，可先用 Capacitor/Ionic 已有 CSS/viewport 行为或页面级键盘事件做 App 专属适配，等 native 发布链路稳定后再引入插件。
  - 不推荐：把 Xcode 自动改出的 deployment target、SPM platform 和个人 signing team 一起提交。
- 迁移/过渡风险：回退这些 native 元数据后，需要重新执行一次 App sync/build 验证；已有本地 DerivedData/SPM 缓存可能要清理，但这是一次性成本，低于长期构建环境锁定风险。

### P2 - 后端默认 CORS 白名单把 App origin 从部署配置变成全局内置能力

- 当前决策：`createCorsMiddleware([])` 现在也默认允许 `capacitor://localhost` 和 `ionic://localhost`，新增测试也把“无部署配置即可放行”固化为预期。
- 为什么这是风险：`capacitor://localhost` / `ionic://localhost` 是框架级通用 origin，不是 Runweave 应用身份。把它们做成所有后端实例的默认值，会削弱 `FRONTEND_ORIGIN` 的部署边界；只要请求能到达后端，任意同 origin 形态的 WebView 都能通过预检访问 auth/API 面。
- 证据：`backend/src/server/cors.ts:3`、`backend/src/server/cors.ts:23`、`backend/src/server/cors.test.ts:102`。当前后端只从 `FRONTEND_ORIGIN` 解析显式配置：`backend/src/index.ts:361`。
- 更好的候选方案：
  - 推荐：恢复 CORS 中间件为“配置驱动”，在 `pnpm app:ios:local`、App dev 启动脚本或移动端部署环境里显式设置 `FRONTEND_ORIGIN=capacitor://localhost,ionic://localhost`。
  - 平台/工具链方案：如果移动端 App 需要长期直连后端，不要只靠 CORS 表达客户端身份，应复用已有 token/auth/tunnel 机制，并在 App bootstrap 中明确携带应用通道身份。
  - 不推荐：所有后端实例无条件内置通用移动 WebView origin。
- 迁移/过渡风险：显式配置需要补齐 App 启动脚本和文档；短期比默认放行麻烦，但能避免把开发便利变成生产默认。

### P3 - 计划文档目标和当前实现范围明显不同，容易把未完成能力误认为已落地

- 当前决策：新增计划文档描述 `Chat / Changes / Files` 三个 tabs、preview API、移动端 diff/files UI，但实际 diff 没有改 `use-app-terminal-connection.ts`、`app/src/services/terminal.ts`、tab bar 或 Changes/Files 组件。
- 为什么这是风险：如果这批变更以“mobile terminal detail tabs”语义合入，验收会错位；当前代码只解决终端触摸/键盘/CORS/native 配置的一部分问题，没有交付 tabs 计划中的主功能。
- 证据：计划目标在 `docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:7`、文件变更计划在 `docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:123`、验收标准在 `docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:371`；当前 `git diff` 对 `app/src/hooks/use-app-terminal-connection.ts`、`app/src/services/terminal.ts`、`app/src/components/TerminalCommandComposer.tsx` 为空。
- 更好的候选方案：
  - 推荐：把当前实现命名和提交范围收窄为“App terminal touch/keyboard fix”，tabs 计划作为独立后续任务。
  - 可选：如果本次目标就是 tabs，先补齐 metadata、preview service、tab UI 和验收验证，再合并。
- 迁移/过渡风险：拆分提交会增加一次 review，但能降低上线时把配置变化、CORS 策略变化和未完成 UI 能力混在一起的风险。

## 代码 / 实现发现

### P2 - App 终端完全关闭交互聚焦，硬件键盘和辅助访问路径会退化

- 为什么这是风险：App 侧把 `focusOnInteraction={false}` 传给共享 renderer，renderer 因此不再设置 `tabIndex`，点击/聚焦也不会让 xterm 获取焦点；同时 App 扩展在 capture 阶段拦截 `mousedown` 和 `click` 并主动 `terminal.blur()`。这能避免触摸时弹键盘，但也会让外接键盘、鼠标/触控板、可访问性焦点无法直接操作终端。
- 证据：`app/src/pages/AppTerminalPage.tsx:78`、`app/src/pages/AppTerminalPage.tsx:150`、`app/src/pages/AppTerminalPage.tsx:153`、`app/src/pages/AppTerminalPage.tsx:416`、`packages/terminal-renderer/src/TerminalRenderer.tsx:327`、`packages/terminal-renderer/src/TerminalRenderer.tsx:354`。
- 可执行修复方向：把“禁止触摸聚焦”和“禁止所有交互聚焦”拆开。触摸滚动可在 App extension 内只处理 touch/pointerType=touch；保留 mouse/keyboard/a11y 聚焦路径，或给 App composer/terminal 明确提供硬件键盘输入替代路径并补充手工验收。

### P3 - 新增 App 诊断日志 recorder 没有接入任何运行路径

- 为什么这是风险：`app/src/features/diagnostic-logs/recorder.ts` 创建了全局 `window.runweaveAppDiagnosticLogs` 并导出 `aiDiagnosticLog()`，但当前没有任何 import 或 stop/upload 集成。结果是它既不会捕获现有 App 日志，也不会随后端 `/api/diagnostic-logs/stop` 的 `frontendLogs` 上传；如果误以为已经有 App 侧诊断日志，会影响后续排障判断。
- 证据：`app/src/features/diagnostic-logs/recorder.ts:32`、`app/src/features/diagnostic-logs/recorder.ts:41`；全仓搜索只有该文件自身命中 App 侧 recorder，后端 stop request 支持 `frontendLogs`：`packages/shared/src/diagnostic-logs.ts:27`。
- 可执行修复方向：如果本次不做诊断日志，移出该变更；如果要做，就在 App 入口显式 import，并在诊断录制停止流程把 `window.runweaveAppDiagnosticLogs.dump()` 传给后端，同时补上清理和脱敏边界。

## 验证记录

- `git diff --check -- . ':(exclude)docs/review'`：通过，无输出。
- `pnpm --filter @runweave/app typecheck`：通过。
- `pnpm --filter ./backend test -- cors`：通过；实际运行了 backend Vitest 全量套件，60 个 test files / 383 tests passed。

未做浏览器/App 录屏验证：本轮是 review-only，且未执行页面复现；如后续需要浏览器操作验证，应按仓库约束使用 `$playwright-cli`。
