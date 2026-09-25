# 桌面代理配置持久化、恢复与环境隔离计划

日期：2026-09-25。状态：主体实现完成；在自有 Beta fixture 完成重启与故障验证，已完成恢复及双 Beta 并行隔离；完整 YAML 验收仍有未覆盖项，未更新或重启用户正式桌面。与[独立隧道管理计划](2026-09-25-independent-ssh-tunnel-manager.md)共同实施，但使用独立验收结果。

## 目标和范围

用户确认：右侧 Browser 的代理配置和隧道配置都属于桌面用户数据，不属于当前项目、当前连接或远端数据库。切换连接/项目不能修改同一 Browser Profile 的代理开关、规则或目标；重启桌面应恢复已保存意图。正式版和 Dev Session 必须隔离。

保留 Browser 1/2/3 独立 Cookie、规则与 Profile 身份。用户主动选不同 Browser，自然读取该 Browser 的配置；这不等于切换连接覆盖配置。项目首选 Browser 可以继续作为选择偏好，但不能写代理目标。

本轮处理存储与恢复，不重写 Whistle 控制台/规则引擎，不改用户规则正文，不把规则自动改为开发机 IP，不修改系统代理/系统证书，不提供手机规则编辑器，不把隧道故障归类成 Whistle 配置丢失。

## 当前核对到的事实

- `electron/src/browser/profile/preferences.ts` 将偏好写入 `app.getPath("userData")/terminal-browser-profiles.json`，已经是本机用户文件。代理模式按 profileId 保存；同时还保存 worktree preferredProfileId/devServerPort。
- `electron/src/browser/whistle/runtime.ts` 使用同根 `terminal-browser-whistle` 作为 baseDir，按 profile storage 分开规则，共享同环境的 certDir；无需挪到数据库或复制一份规则。
- 当前正式安装目录实际存在这两个位置，偏好中 profile-1 为 whistle；本轮只读了配置结构，不展示规则、凭据，也没做重启实验。
- `electron/src/desktop/config.ts` 先选 userData；Dev Session launcher 注入独立目录。`profile/runtime.ts` 无保存值时 Dev Session 默认 direct、普通安装默认 whistle；已保存的显式选择优先。
- `resolveTerminalBrowserProfile` 会根据当前 worktree.devServerPort 设置/清除 Whistle 的保留 Value；所以“文件在本机”尚不等于“代理目标不随项目变”。这是与新需求的行为差异。
- `setTerminalBrowserProfileProxyMode` 在 Whistle 启动前就修改内存为 whistle，落盘在启动/配置完成后。启动失败或写盘失败可能让运行态/内存/保存值分叉；这属于需验证的失败窗口，不等于已复现用户此前故障。
- 配置损坏时现有读取逻辑备份后返回默认值；用户可能只看到配置似乎消失，需要显式恢复提示和保留有效文件。
- `packages/shared/src/browser/profile.ts` 将三套 Whistle 端口写为 8081/8082/8083。目录隔离并没有隔离监听端口；Dev Session 显式开启可能与正式版冲突。
- 冷启动已有 dormant tabs，在 Profile 路由准备前不导航，保留该顺序。现有 TBMP-015 把重启后恢复默认 Direct 作为期望，与代码的“保存选择优先”冲突，实施时同步修正测试合同。

## 设计合同

### A. 本机用户目录是权威来源

使用与隧道一致的 desktop paths resolver，但保留 `terminal-browser-profiles.json` 和 Whistle 原生目录，避免迁移导致看起来像新安装。main 在环境根确定后再初始化持久化与 Session；路径不得读取 activeConnection、project.path 或 renderer localStorage。

正式版沿用原 userData（当前安装实际为用户 Library/Application Support 下的应用目录）；Dev Session 使用 manifest 的 userDataDir；Beta 使用自身渠道/槽位目录。禁止跨环境 fallback、自动复制正式 Cookie/规则/SSH 凭据。新 Session、显式 reset 可以清理本 Session；同 userData 正常重启不能清理配置。

复用通用原子文件操作辅助，不创造一个同时管理 SSH、Whistle Rules 和 Cookie 的大配置服务。用户修改 Whistle Rules/Values 仍由 Whistle 负责持久化，Runweave 不与它双写底层文件。

### B. 保存意图与执行结果分开

每个 Profile 持久化 proxyMode 和可选 devServerPort。设置时校验后先可靠落盘，再应用；写入失败保持旧意图和旧运行配置，UI 不返回成功。落盘成功但代理启动失败时保留用户选的 whistle，显示“已保存，启动失败”，不能假装开启成功，也不能静默切 direct。重启按保存意图恢复；explicit direct 同样要保留。

保留懒启动，不在 App 启动时无条件启动全部 Whistle。首次恢复可见/显式打开 Profile 时，先准备 Whistle、证书和 session proxy，再导航业务页。代理启动失败不以直连加载业务 URL，也不覆盖已保存模式；用户可以明确切 Direct。

故障状态区分：配置损坏、写入失败、端口占用、Whistle 退出、代理应用失败、开发服务/SSH 不可达。错误与具体 Profile、环境、端口关联。存储无效不静默以默认值覆盖原文件；保留备份，提示恢复或重置。

### C. 代理目标归 Profile，不跟随连接/项目

把旧 worktree.devServerPort 引起的自动路由变更移除，改为 Profile 级显式 devServerPort。字段用于现有 `runweave-dev-server` 保留 Value；没有使用这个 Value 的用户普通规则完全不受影响。

切换项目/连接、Agent resolve 都只读取 Profile 固定设置，不重新写入其他项目端口；用户明确修改该 Profile 开发端口才更新保留 Value。修改当前被其它 Agent 使用的 Profile 仍遵守占用/冲突规则，不能拿这次重构绕开资源归属。

保留 Worktree 的首选 Browser 选择（如用户确有使用），将其与代理数据写入路径分开。SSH Browser 固定 Profile 的解析与桌面相同，不因远端 projectId 的命名空间没有 worktree 配置就删除目标。

一次性迁移：仅一个不冲突的旧端口可提议迁入对应 Profile；同一 Profile 有多个旧端口时展示迁移选择，不按最后使用/最后遍历偷偷选。迁移确认并保存前不删除旧偏好，不影响已有规则。旧字段可保存在离线备份，迁移完成后清理运行读取分支，不长期双轨。

### D. 正式与测试隔离到运行资源

正式版继续固定 8081/8082/8083。受管 Dev Session 的 Whistle 使用 planner 分配并登记的独立三端口集合；固定 Beta 槽位登记固定集合，同槽位重启保持；临时 Session 的集合在 session manifest 中稳定到 Session 结束。已分配端口被占用时明确失败，运行中不自动漂移，不借用正式 Whistle。

这是测试环境的内部代理监听端口隔离，不改变用户开发转发的 `P → P` 规则。三个 Browser 的逻辑 Profile ID 保持原样。把“Profile 固定身份/标签”和“当前环境监听端口”拆开，main 提供权威实际端口；UI、代理 setProxy/验证、证书获取、Whistle 控制台、远端 snapshot、CLI 都读取同一个运行配置，禁止残留硬编码 8081。

在 planner 的 start/status/open/stop/lease/recovery 中登记这些资源；不能只改 Electron 环境变量。测试默认 direct 仍成立，显式选择在同 userData 重启后保留。正式版进程/规则/CA 不会被测试 stop/reset 清理。

### E. Backend 只读，不成为配置源

手机读取范围遵循隧道计划的同机根与认证边界；只需要 Profile 的 proxyMode、是否有规则、运行状态、更新时间和错误摘要，不默认返回包含内网地址/认证内容的完整 Rules/Values。新增 `GET /api/desktop-network` 聚合本机隧道与代理摘要，内部复用 `/api/tunnels` 的只读模型，同步共享 DTO；两个读取入口均不持有或写入配置副本。

读取依据 main 写入的脱敏网络快照加同机配置；Whistle 不在线时只显示最后已知规则元数据，不启动代理来满足一次手机 GET。快照过期标 unknown/offline，当前 Backend 没有该桌面根则返回明确不可用。不同连接的数据不能覆盖正式桌面本机文件。

## 文件与实施顺序

1. [x] 路径与环境合同：`electron/src/desktop/config.ts`、新增 `electron/src/desktop/local-state.ts`，复用隧道 paths；核实正式路径，先记录旧文件和规则摘要，不移动存量数据。
2. [x] 偏好和保存：`electron/src/browser/profile/preferences.ts`、`packages/shared/src/browser/profile.ts`；新增 Profile 级目标字段、atomic write/readback、损坏错误、一次性迁移摘要。
3. [x] 恢复与失败：`electron/src/browser/profile/runtime.ts`、`security/network.ts`、`whistle/runtime.ts`、`restore.ts` 和 `workspace/index.ts`；去掉 worktree 自动改目标，保存意图与 ready 分离，保留导航前门禁。
4. [x] 端口隔离：shared 的静态身份与 runtime endpoint 类型拆分；`scripts/dev-session/services/dedicated.mjs` 及 planner/manifest/Beta slot 注册路径加入 Whistle 端口集合；全仓搜索 whistlePort/8081/8082/8083 修正实际 endpoint 消费。launch 缺失隔离端口信息时 fail closed，不落到正式端口。
5. [x] UI/CLI/读取：调整 `frontend/src/components/terminal/browser/header/profile-status.tsx` 与实际 Worktree 设置表单，代理设置保持在 Browser 入口，不挪进 SSH 主机配置；更新 resolver/CLI 文档和共享 DTO，增加 Backend 受认证只读摘要。
6. [ ] 在隔离 fixture 完成重启、保存故障、并行实例验收，再检查实际正式安装路径；部署前后对照规则/偏好摘要。除明确批准的迁移选择外不改用户规则，不将本轮验证升级为真实桌面重启授权。

## 验收和交付

新增[桌面网络持久化测试计划](../testing/terminal/browser/desktop-network-persistence.testplan.yaml)。引用现有 multi-profile-whistle 与 dev-session-proxy-mode 的 Profile/Cookie/规则边界；涉及 Worktree 自动路由及固定测试端口的旧用例在实现该行为变更时同步更新，不能维持矛盾期望。当前只是制定新合同，旧实现用例不在本轮改写为已落地事实。

必须形成独立结果：保存后重启的模式/规则不丢失；同 Profile 切连接/项目不改目标；保存故障不伪成功；代理启用失败不丢保存意图；正式与测试同时运行不共享路径/端口/CA；导航确实经过目标 Profile Whistle。用真实 Whistle 请求记录及 fixture 标识证明代理路径，不能只看 200 或 ready。

执行 shared/electron/frontend/backend/CLI typecheck/lint、architecture:check、docs:check、两个新 YAML 格式校验；改 Dev Session 后执行 `pnpm dev:session:verify` 以及按所有权安排真实 start/status/open/stop 验收。不新增单元测试；重启前后必须在同一 fixture 取证，重启后重新获取 surface 和鉴权。

回滚：停止本轮自有进程后恢复上一版本及原偏好备份；Whistle 原生目录未改格式，不清空重建。新模式应用失败不是删除用户规则的理由。计划完成不代表上述运行验收已通过。

## 本轮执行记录

核心集成与 UI 验收证据见本地 `artifacts/validation/network-dvs-3d4465/README.md`。本轮创建的全部测试实例、远端专用终端与 fixture 已清理；正式桌面未更新。没有宣称两份计划共 23 项全部通过，具体未覆盖项及全量 Dev Session 自检受其它任务活跃槽位影响的失败记录见该报告，最终验收任务继续保持未勾选。
