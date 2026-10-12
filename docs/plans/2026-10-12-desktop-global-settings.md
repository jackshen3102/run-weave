# 桌面全局设置重构实施计划

日期：2026-10-12。状态：方案已落盘，生产实现尚未开始。基线：`5cd1e0ae0c75fb48aa53ab6c9716952a2d6ef6f4`；实施前检查新增变更并补充差异，不覆盖工作区已有修改。

设计依据：[当前可交互原型](../prototypes/global-settings/README.md)、[18 个功能分区保留清单](../prototypes/global-settings/feature-preservation.md)、[配置字段归属登记](../prototypes/global-settings/configuration-inventory.json)。原型的模拟成功不代表真实服务验收通过。

## 一、确定的交互边界

1. 全局设置占满桌面应用内容区域，保留原生标题栏；左上角返回工作区，左侧分类，右侧内容独立滚动。不是居中弹窗，也不是加宽的应用菜单。
2. **去掉全局设置搜索框和导航过滤功能**，10 个分类入口直接呈现。保留原有模型目录搜索、资源筛选等功能内部的查找能力。
3. **右上角快捷入口保持现状的图标方案**：复用快捷指令、Services、随记、定时任务、运行状态、更多操作的现有组件、图标、尺寸、顺序、提示、角标和禁用条件，不改为文字按钮。已有其他入口（例如当前源码中的“阅读会话”）不借此次重构改样式或删除。
4. 项目、终端、右侧工具区的大布局不变。进入/退出设置不得重建终端会话、清空输入、重置 Worktree 或切换 Browser Profile/Tab。
5. 全局设置只承接本台偏好、账户、所选电脑的实例级配置及诊断。终端历史、Team 运行、状态查询继续属于终端；定时任务、后台运行、快捷指令执行、随记业务、自进化、原型库、活动数据保留原业务入口。现有实例级四角色默认模型进入高级配置，已创建运行继续使用快照。
6. Browser 默认 Profile、Profile 端口/代理、Worktree 绑定、通道授权、终端绑定、打开网页路由保持现状。SSH 编辑不能丢弃未展示的 Browser 配置。
7. 此次面向桌面设置容器和入口整合；不改后端权限、配置格式、认证协议或原生 iOS 导航。共享组件改动仍需验证既有 Web/移动使用方。

## 二、菜单树与功能去向

页面 ID 沿用原型，生产路由使用 `/settings/:pageId`，页内分区及详情用 URL 参数表达；参数不含密码、令牌、二维码载荷。

| 分类       | 页面 ID / 名称              | 页面内容与作用域                                                                         |
| ---------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| 本台应用   | appearance / 外观           | 主题、右侧全部工具显隐/排序、至少保留一个；设备级偏好                                    |
| 本台应用   | notifications / 桌面通知    | 本台通知开关、系统授权、宿主能力和失败反馈                                               |
| 本台应用   | shortcuts / 快捷键          | 只读呈现已有快捷键；原生 File/Edit/View/Window 菜单原位保留                              |
| 连接与服务 | connections / 连接管理      | 普通连接、系统连接、SSH 主机/转发/Backend 入口、中转接入、RemoteDesk；本台连接与隧道存储 |
| 连接与服务 | suiji / 随记账户            | 正式/开发环境的服务地址、账号、登录、修改、退出与会话恢复                                |
| 所选电脑   | access / 登录与手机接入     | 当前电脑密码、重新登录、手机二维码与批准流程                                             |
| 所选电脑   | monitoring / 资源监控与提醒 | 后台采样、提醒规则、远端控制授权；授权仍只能在本机管理                                   |
| 所选电脑   | advanced / 高级配置         | 四角色默认模型；5 个领域、28 个现有 Web 可编辑字段                                       |
| 状态与诊断 | status / 电脑状态           | 运行状态、系统资源、开发资源、Codex 额度、日志；均明确所选节点                           |
| 状态与诊断 | desktop / 本台桌面诊断      | 本台环境、实例、版本、配置采用状态、导出及运行时重载                                     |

设置目标与工作区活动连接分离。默认首次进入采用当前连接；在设置内切换目标只影响电脑级页面。本台通知、连接管理、SSH、桌面诊断不能跟随远端目标变更归属；随记账户按环境隔离。

## 三、代码组织和关键接口

复用领域逻辑，分离外壳与内容，不把独立原型的 `app.js` 或模拟状态复制到产品。

| 文件范围                                                                                                                      | 职责与调整                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `frontend/src/App.tsx`                                                                                                        | 装配设置路由和保留工作区的布局；避免切设置目标改变现有工作区 Provider 的 key  |
| 新建 `frontend/src/pages/settings-page.tsx`                                                                                   | 全屏页面外壳、返回、内容滚动、标题和可访问性                                  |
| 新建 `frontend/src/features/settings/registry.ts`                                                                             | 10 页 ID、名称、分组、scope、能力条件和懒加载入口；不含搜索索引               |
| 新建 `frontend/src/features/settings/navigation.ts`                                                                           | 类型化页面/分区导航、返回地址校验、未知页回退外观页、无来源时返回 `/terminal` |
| 新建 `frontend/src/features/settings/target-context.tsx`                                                                      | 独立设置目标、目标认证和请求代次；复用连接服务，不复制工作区活动连接状态      |
| 新建 `frontend/src/features/settings/edit-session.tsx`                                                                        | 草稿离开保护、保存中防重入、焦点恢复；密码/扫码按既有专用状态机接入           |
| `frontend/src/components/terminal/workspace/app-menu.tsx`、`header.tsx`、`overlays.tsx`                                       | 增加/调整设置入口，保留业务入口；header 不重画快捷按钮                        |
| `frontend/src/features/settings/pages/` 下 10 个同 ID 的 `.tsx` 文件                                                          | 薄页面组合层，引用已有领域组件；不在此复制 service/store                      |
| `frontend/src/features/connection/`、`tunnels/`、`mobile-login/`、`configuration/`、`suiji/`、`system-monitor/`               | 从 Drawer/Dialog 中提取可复用内容；保留现有 hook、服务、校验和状态机          |
| `frontend/src/components/terminal/agent-team/model-config-dialog.tsx`、`runtime-status-panel.tsx`、`diagnostic-log-entry.tsx` | 拆容器与内容，由设置页和仍保留的快捷入口共用                                  |
| `frontend/src/pages/system-monitor-page.tsx`、`dev-resources-page.tsx`                                                        | 提取内容区，兼容原业务路由；避免嵌套两个全屏外壳                              |

新建前端类型建议：`SettingsPageId` 为上述 10 个 ID 的联合；`SettingsScope` 为 `local | account | computer`；导航参数包含 `pageId / section / detailId`；目标上下文包含 `connectionId / apiBase / authStatus / generation`。这些是前端组织接口，不新增跨运行时 DTO。

生命周期约束：

- 从工作区进入设置时记录 background location，背景工作区与其 Provider 保持同一挂载身份；设置覆盖内容区域并限制背景焦点。直接打开设置路由时不虚构终端，返回采用有效原路由或 `/terminal`。
- 全屏层按[现有浮层协调](../../frontend/docs/overlay-coordination.md)在实际可见节点接入 `useOverlayRef(..., "window")`。不能只提高 z-index，也不能由业务直接调用 Browser hide/show。退出恢复最新 Browser bounds 和当前 Tab。
- 切目标、切环境、重新认证时递增请求代次；响应同时校验目标身份与代次。旧目标的响应/保存结果不能覆盖当前页，也不能更改工作区连接。注销、连接删除等真实身份变化沿用既有恢复流程，不保持虚假的在线状态。
- 有草稿时切页、返回、切目标、浏览器后退统一保护；取消离开保留输入。保存只提交所属页/所属目标；失败保留草稿。提交中禁止重复和可能混淆归属的导航。敏感字段不进入通用持久化草稿。
- 页面内容使用现有 `components/ui`、主题 token 和图标。草稿/空态/错误/按钮/行距统一；领域校验不抽成复杂通用表单引擎。

## 四、实施步骤与阶段出口

### P1：入口基线和全屏外壳

- [ ] 对照 18 个分区及 36 项入口归属表记录旧入口、组件、scope、权限、操作和异常态；新增代码相对基线的功能也纳入清单。
- [ ] 完成 registry、settings-page、navigation 与工作区保活；全局设置无搜索；右上角快捷组件不替换。
- [ ] 以外观页接入首条真实路径，验证主题及工具显隐/排序沿用原设备存储，至少一个工具约束不丢失。原型“跟随系统”属于新增方案，若接入须兼容原深浅主题存储，不重置旧偏好。
- [ ] 阶段出口：真实 Electron 进入/返回、刷新/后退、窄窗口、原生 Browser 避让通过；终端输入/运行输出/工作树/工具布局保持。

### P2：本台与账户页面

- [ ] 迁入桌面通知和只读快捷键，保留能力检测与通知授权错误。
- [ ] 接入随记账户：环境隔离、会话恢复、修改/退出、401 清理、网络重试；保存失败不清空可恢复输入，密码不落入原型存储或日志。
- [ ] 阶段出口：外观、通知、快捷键、随记账户逐字段对照完成，原入口共用同一份业务逻辑。

### P3：连接、SSH 与手机接入

- [ ] 连接 CRUD 与系统只读/重连；SSH endpoint 引用和代次隔离；管理目标不隐式切工作区连接。
- [ ] 复用 SSH host-form 和共享校验：别名、自动连接、完整转发表单、Backend 入口、revision 冲突、端口错误/重试、中转访问、RemoteDesk 身份/指纹检查。保存做完整对象合并，保留 Browser 授权对象。
- [ ] 密码与手机接入复用真实状态机：403/401、成功后重新登录、可达地址、倒计时、扫码批准/拒绝、签发、完成、取消、过期、结果未确认、失败与重生成。结果未知时核实同一请求，不生成第二份凭据。
- [ ] 阶段出口：SSH、二维码协议和跨端流程既有用例通过；取消/切目标的迟到响应隔离通过。真实手机未参与时明确跨端项未验收，不用原型计数代替。

### P4：实例配置与模型

- [ ] 资源监控/提醒与远程控制授权保留独立 owner 和 revision；部分成功准确说明已保存与未保存项。
- [ ] 高级配置复用 `configuration/panel.tsx` 与字段状态：当前允许的 28 字段、5 领域、6 个密钥操作；空值恢复默认、来源、保存值与进程采用值、磁盘/摘要/版本/实例冲突及重读。其余 137 条元数据保留原 owner，不扩大 HTTP 允许列表。
- [ ] 四角色模型整组保存，显式选模型、目录搜索/重试、provider 可用性、reasoning/Fast/Max 能力约束；已有 Run 快照不受修改影响。
- [ ] 阶段出口：真实保存后读回和服务采用状态分别取证；冲突保持草稿，不丢字段/密钥。

### P5：状态与诊断

- [ ] 接入运行状态、组件版本/构建、系统资源、开发资源、额度和日志；保留原快捷入口使用方式，不把右上角图标强制导向新页面。
- [ ] 保留 PID/进程实例与保护原因、正常结束与强制结束两次确认、权限撤销；开发资源的归属版本、幂等键、释放与停止并释放分别处理，未知结果不宣称成功。
- [ ] 保留额度未知/陈旧/失败后最近成功记录；仅打开/刷新查询。日志开始/结束上报、正文/路径/复制/下载完整保留。
- [ ] 桌面诊断始终作用于本台；导出、磁盘错误、consumer 采用状态和重载确认保留。
- [ ] 阶段出口：18 分区逐项具有真实证据，不能以仍有旧入口替代新页面功能完整性。

### P6：入口收敛和回归

- [ ] 将迁移完成的菜单项指向统一内容；业务功能仍按原上下文打开。旧外链/资源提醒入口采用兼容适配，不直接删路由。
- [ ] 删除已无引用的重复设置容器；仍承接 Browser 通道等功能的容器继续保留，不能整块删掉隧道 Drawer。
- [ ] 更新改变了入口的旧用例（例如 AGT-MC-001 的“仅更多菜单/居中弹窗”）；保留其业务断言，避免旧导航要求与新方案冲突。
- [ ] 完成验证记录、截图及逐页清单；更新活文档，实施完成后按治理规则删除本临时计划。

## 五、接口、数据和回滚

所有操作继续调用已有 `frontend/src/services/`、领域 store 与 Electron bridge。Backend 配置 HTTP 的 `metadata.remote` 过滤对本地和远端都生效；不能因名称叫“全局设置”绕过权限。跨运行时协议确有变更需求时进入 `packages/shared` 并单独评审，本计划不预设新增协议。

不改变连接 ID、隧道文件格式、配置路径、账户环境键、设备偏好键或模型存储。读取失败不写空默认值覆盖磁盘；敏感值只显示已有的保留/替换/删除状态。SSH 删除只停止自身通道，不结束远端任务。资源释放仅操作用例或用户明确选中的实体。

分阶段提交，每阶段独立可回退；迁移期间旧容器可作为兼容适配层但共用一份内容/存储。阶段验收后再移除重复容器。回滚代码恢复入口，不回滚或重置用户配置；若实现发现必须变更存储，暂停该迁移并补独立迁移方案。发布、更新 Stable 和 PR 不属于本轮“原型修改 + 写计划”的执行内容。

## 六、验收与验证

新增[全局设置导航与隔离计划](../testing/platform/desktop-global-settings.testplan.yaml)，覆盖此次新增容器合同；领域流程沿用下表的已有用例。新增 YAML 本轮只做格式校验，生产用例待实现后执行。

| 验证范围            | 既有验证依据                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH 与 Browser 归属 | [隧道](../testing/platform/ssh-tunnel-manager.testplan.yaml)、[原生视图协调](../testing/terminal/browser/overlay-coordination.testplan.yaml)                                                            |
| 手机登录            | [协议](../testing/app/mobile-qr-login-protocol.testplan.yaml)、[真实跨端](../testing/app/mobile-qr-login.testplan.yaml)                                                                                 |
| 配置持久化及消费者  | [配置存储](../testing/platform/global-configuration-store.testplan.yaml)、[配置生命周期](../testing/platform/global-configuration-lifecycle.testplan.yaml)                                              |
| 默认角色模型        | [角色模型](../testing/agent-team/configuration/agent-team-role-model-config.testplan.yaml)                                                                                                              |
| 监控与控制          | [监控](../testing/platform/resource-monitor.testplan.yaml)、[进程操作](../testing/platform/resource-process-actions.testplan.yaml)、[开发资源](../testing/platform/development-resources.testplan.yaml) |
| 运行状态            | [面板](../testing/runbooks/runtime-status-panel.testplan.yaml)、[Provider](../testing/platform/runtime-status-providers.testplan.yaml)                                                                  |

每阶段运行受影响前端的类型与 lint 门禁；最终执行前端构建。文档和新增用例执行格式检查：

```bash
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm --filter @runweave/frontend build
pnpm testplan:validate docs/testing/platform/desktop-global-settings.testplan.yaml
pnpm docs:check
git diff --check
```

行为验收使用 `toolkit:runweave-dev-session` 规划隔离 Dev Session，按返回的 desktop surface 使用 `toolkit:playwright-cli`，原生合成窗口另观察 Browser 输入命中。不使用 Stable 配置或用户正在执行的进程做破坏性测试；不以无 tracked spec 的 `test:e2e` 成功作为门禁，不新增单元测试。

完成标准：10 页可达、18 分区的字段/操作/权限/异常状态均有真实覆盖记录；28 字段与当前源码允许列表一致；全局搜索为零；右上角原快捷图标组件保持；工作区与 Browser 状态不漂移；所有 required 用例有明确通过证据。类型/格式通过、截图、模拟断言、真实桌面和真实手机分别报告。存在缺功能、混写目标、覆盖配置、未确认的释放结果或原生视图遮挡即不能宣称完成。
