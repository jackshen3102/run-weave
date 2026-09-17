# 随记复用内置浏览器：桌面实施计划

状态：代码已实现，静态门禁与核心交互已验证，完整 required 验收矩阵尚未完成（2026-09-17）。配套 [iOS 计划](2026-09-17-suiji-browser-ios-reuse.md)独立跟踪。

## 本轮验证记录

在当前工作区 Electron Dev Session `dvs-e9b975` 实测列表/详情链接进入现有 Browser、新分组、网页计数器真实点击、重开随记保持列表或详情，以及当前 Browser 2 路由；类型、lint、架构门禁通过。测试服务中原记录正文和版本保持不变。

HTTP 本机 fixture 证明桌面打开链路，不替代用例要求的 HTTPS、双 Profile 身份与长正文草稿完整前置。004～006 缺真实主进程 handler 故障/延迟装置，008 缺旧兼容壳；纯 Web 原生菜单与正文复制尚未完整执行。逐例状态和本地证据见 `.runweave/browser-reuse/verification.md`。

## 目标与边界

随记抽屉的列表和详情链接在当前 Runweave 桌面窗口的 Browser 面板打开，复用现有标签、Profile、Cookie 与主进程能力。打开后可从终端右上角重新进入原随记现场。

不创建第二个浏览器宿主，不将网页嵌入随记抽屉，不新增随记独立窗口；不改 Electron IPC、Profile 分区、持久化、CDP、代理或自动化协议。纯 Web 保持安全的新标签打开。旧壳缺少内置能力时保留用户可理解的外部打开路径。

## 实施前已核实的代码边界

- `frontend/src/features/suiji/record.tsx` 的 RecordBody 直接调用 `electronAPI.openExternal`，没有宿主注入点。
- `frontend/src/features/terminal/navigation/open-browser.ts` 已封装 URL 规范化、Profile 选择和 `terminalBrowserCreateTab`。
- `frontend/src/features/terminal/preview/store.ts` 的 activateBrowser 负责切换 Profile 并显式激活 Browser 面板；仅创建标签不足以保证可见。
- `frontend/src/features/suiji/drawer.tsx` 收起后保持 SuijiPage 挂载；`drawer-state.ts` 的 opened 保持为 true。必须利用这个能力保留页面状态。
- `frontend/src/components/terminal/browser/controller/tool.tsx` 在 suijiOpen 时抑制原生视图。IPC create-tab 会在主进程立即 attach WebContentsView，因此需协调抽屉退出和原生视图附着，不只改链接 handler。
- `connection.tsx` → `workspace.tsx` → RecordBody/SuijiRecordDetail 是回调传递链；纯内容组件不应导入终端全局 store。

## 确定的交互与接口合同

| 场景                     | 行为                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面普通左键点击         | 校验 URL、记录来源代次与当前 active Profile；收起抽屉，等待原生视图抑制解除，再用现有入口创建新分组标签并显式激活该 Profile                                       |
| Profile 与分组           | 使用点击时当前 activeBrowserProfileId；不偷偷应用当前项目默认值覆盖用户已选 Profile。随记每次明确打开创建新分组，不改已有终端/Agent 分组的归属                    |
| 回到随记                 | 从现有唯一入口重开；原环境、筛选、搜索、详情及滚动保留，现有编辑草稿不因收起丢失，不执行保存/任务状态操作                                                         |
| 同一请求未结束时重复点击 | 同一来源阻止重复提交；完成后再次明确点击允许新标签，不增加后台重放队列                                                                                            |
| 创建请求失败             | 恢复仍有效的原随记抽屉与可操作错误；不自动改用外部浏览器，不自动重试可能已创建的请求。用户可主动重试或选择外部打开                                                |
| 迟到结果                 | 检查窗口/路由、账户连接代次和本次操作身份。用户已离开或切换环境时，不强行恢复旧抽屉或激活旧 Profile；已经被主进程接受的标签不承诺取消，不为清理它关闭用户其他标签 |
| 纯 Web                   | 保留真实 `<a href target="_blank" rel="noopener noreferrer">` 默认行为，修饰键与复制链接不被普通左键 handler 吞掉                                                 |
| 旧 Electron 壳           | create-tab 能力缺失时，不先收起抽屉；通过现有 openExternal 处理明确点击。也缺少外部能力则保留安全链接默认路径或给出明确不可用提示，不留下无响应点击               |

新增只属于 renderer 的 `onOpenLink(url)` 宿主回调，由随记桌面入口注入并逐层传至正文；纯 Web 不注入桌面 handler。回调消费普通打开动作，内容层继续承担阻止卡片事件冒泡。异步处理使用 useMemoizedFn 与明确 pending/error 状态。modifier-click 不进入异步内置打开逻辑，保持宿主原有链接操作语义。

新增 `frontend/src/features/suiji/browser-navigation.ts`（或同职责 hook）作为装配层：调用现有 openTerminalBrowserUrl、activateBrowser 和抽屉控制，不复制 URL 规范化、IPC 或 Profile 算法。生命周期校验需涵盖 connection 中现有 generation/作用域，不只检查 mounted。

URL 和来源不附加随记凭据、正文或记录 token。网页使用用户当前 Browser Profile 已有的网站身份，这与随记业务账户独立；切换随记账户不清 Browser Profile，不声称两者隔离网站登录。

## 实施任务

### D1：内容层打开意图

- [x] 修改 `frontend/src/features/suiji/record.tsx`，为 RecordBody 和 SuijiRecordDetail 提供可选 onOpenLink，保留真实 href、选区、修饰键和卡片事件隔离。
- [x] 修改 `workspace.tsx` 与 `connection.tsx` 传递回调与当前连接有效性；通路覆盖列表和详情，不把电子壳逻辑塞入文本分词过程。
- [ ] 验证纯 Web 点击仍由原生 anchor 完成，不在异步 await 后调用 window.open 导致弹窗被拦。

### D2：桌面装配与恢复

- [x] 在 `drawer.tsx` 及新的 `browser-navigation.ts` 装配打开流程，复用现有导航入口与 preview store；能力检测先于抽屉变化。
- [x] 以受控顺序协调抽屉隐藏、nativeViewSuppressed 更新、IPC attach 与激活；不使用猜测性的固定延时。验证视觉层级和真实点击，必要时在现有宿主装配点增加明确完成信号。
- [x] 为失败提供随记内可见错误和主动操作入口；请求未知结果不自动再开一次，晚到回调不能抢用户新页面。
- [x] 保持 SuijiPage/workspace 挂载和稳定 key；只有真实账户作用域变化才走既有重置，不能通过重挂载来解决原生视图遮挡。

### D3：验收与文档

- [ ] 执行[桌面复用用例](../testing/suiji/desktop-browser-reuse.testplan.yaml)。环境准备使用 `$computer-use` 对应的原生 UI 能力，页面交互必须使用 `$toolkit:playwright-cli` 附着当前候选实例；外部浏览器降级由原生 UI 取证。
- [ ] 回归 `docs/testing/terminal/browser/core.testplan.yaml` 的 TBR-001 和 `docs/testing/terminal/browser/multi-profile-whistle.testplan.yaml` 中实际受影响的 Profile 选择路径，不默认重跑代理或 CDP 全套。
- [x] 更新 `docs/architecture/suiji.md` 的桌面链接打开行为，保留真实 Web 与 Electron 的差异。
- [x] 已将 `docs/testing/suiji/web-capture.testplan.yaml` 的 WEB-012 从旧独立窗口改为实际抽屉生命周期，保留其它用例范围。

本轮不用旧测试合同制造当前实现事实，也不新增单元测试。涉及实际 dev:session/status/open/stop 时必须先使用 `$toolkit:runweave-dev-session`，核对工作区、候选源码与目标实例，不能附着用户另一工作会话。

## 验证命令与完成标准

```bash
pnpm testplan:validate docs/testing/suiji/desktop-browser-reuse.testplan.yaml
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
git diff --check
```

命令退出 0；类型/lint 不得以静态通过替代 UI。若实际扩展到 Electron/shared，再增加对应包 typecheck/lint；首版目标不需要改这些包或打包 Windows。

全部新增 required 用例取得真实证据；保存候选源码、桌面版本、窗口、Profile、group/tab 身份、脱敏目标 URL、点击前后 UI 和业务只读比对。原生视图是否可见必须实际读取或交互，不能只看 renderer store。旧壳或故障环境缺失时标 blocked，不注入假的成功 bridge 冒充兼容验收。

## 失败边界与回滚

最大的风险是已创建标签却仍被抽屉遮挡、错误 Profile 被激活和异步结果抢占新环境。创建接口没有事务或返回新 tab ID，不在此任务中虚构可撤销保证；只能保证 renderer 迟到 UI 副作用不发生，报告主进程已接受结果的边界。

无需数据迁移，维持账户 safeStorage、业务草稿、Browser Profile 与标签持久化格式。回滚仅撤回内容回调及桌面适配，恢复现有外部打开路径，不删除用户标签、网站数据或随记记录。保留本工作区已有终端滚动与手势改动；不得 reset、顺手修复或纳入本任务提交。
