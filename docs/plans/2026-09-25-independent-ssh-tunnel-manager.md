# 独立端口与 SSH 隧道管理实施计划

日期：2026-09-25。粒度：L3（涉及持久化、身份归属、迁移和跨进程恢复）。状态：主体实现完成；已完成核心真实链路、并行实例和恢复验收；完整 YAML 验收仍有未覆盖项，未部署正式版。

## 1. 目标和已确认范围

以[交互原型](../prototypes/ssh-tunnel-manager/README.md)和[原型截图](../prototypes/ssh-tunnel-manager/prototype-preview.png)作为布局基准：工作区右上角「更多 → 端口与隧道」打开右侧抽屉。独立管理 SSH 主机、同号端口转发、远端 Agent 访问本机 Browser；不再要求新增一条「远程 devbox」连接。

用户补充的持久化边界：

1. 配置必须写到本地磁盘，不以 renderer localStorage 或页面内存作为数据源。
2. 「本地」是运行该组隧道的电脑的桌面用户数据目录（Electron userData），不是项目目录、Backend 数据库或当前连接的数据目录。
3. 桌面抽屉始终管理本机，不随当前工作区的 activeConnection 切换。
4. 手机以后连接哪个 Backend，就查询那个 Backend 所在机器的配置与状态；本轮提供读取合同，不做跨节点汇总、远端 Backend 转发本机配置、手机原生界面或手机写操作。
5. 配置独立于连接生命周期。关闭抽屉、切换/删除普通后端连接不停止隧道。

本轮不做：多后端项目并排、通用 SSH Shell、任意反向端口/Dynamic SOCKS 配置、远端安装或 Agent 探测、Whistle 规则编辑器重写、云同步、无 Electron 的常驻 SSH 执行守护进程。手机连接纯 Linux Backend 时只查询该节点；没有获准的同机桌面配置时显示能力不可用，不借用其他电脑状态。

配套独立工作流：[桌面代理持久化与环境隔离](2026-09-25-desktop-proxy-persistence.md)。两份计划共同满足桌面用户级配置合同，但分别验收，不把普通 SSH 和 Whistle 失败混成一个结果。

## 2. 当前代码事实及差异

| 现状                                                                | 来源                                                          | 本次变化                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| SSH 主机字段与普通连接混在一起，保存到 viewer.connections           | frontend/src/features/connection/use-connections.ts、types.ts | 独立 TunnelHostConfig，连接不再持有 SSH 密钥/主机/Browser 配置    |
| useConnections 根据连接列表启动 SSH                                 | 同上                                                          | Electron main 依据本机持久化配置管理生命周期，renderer 仅操作界面 |
| 手动端口与路径保存在 viewer.remote-forward.<connectionId>           | frontend/src/components/remote-port-forwarding.tsx            | 转入本机配置；保留已保存端口和访问路径，禁止退回 3000 默认值      |
| SSH、Backend 转发、Browser 网关/反向转发、手动转发共用 connectionId | electron/src/remote/ssh-connections.ts                        | 改为独立 hostId 与 desktopId；拆分各子能力状态                    |
| Browser 注册由 React 后台观察器触发                                 | frontend/src/features/connection/workspace-overview.tsx       | 转到主进程执行器，页面关闭不取消注册或续期                        |
| Backend resolve 选择最后注册的 Browser binding                      | backend/src/remote/browser-bindings.ts                        | 终端明确绑定桌面通道；多个候选时拒绝猜测                          |
| 手机通过 Backend HTTP/WS 获取数据                                   | docs/architecture/app-mobile.md                               | 提供受认证的本机配置/状态读取接口，不依赖 Electron IPC            |

原型里的内存保存、延时成功、固定重试成功、两项连接名称切换不是生产需求。现有登录态刷新修复以及菜单精简改动保留，不回退。

## 3. 数据所有权与存储

### 3.1 单一配置源

持久化根目录统一使用 **Electron 完成环境选择后的 `app.getPath("userData")`**。本机 main 独占写入 `tunnels/config.json`，不通过当前连接、项目路径或 Backend 数据库存储。正式版继续使用既有用户目录，不能为重构另建一个看似空白的新目录；Dev Session 使用 manifest 指定的独立 userData，缺失合法目录则拒绝启动，不回退正式目录。固定 Beta 槽位沿用既有 owner/reset 规则，不能把上一个 Session 的凭据带给新 owner。

文件包含 schemaVersion、revision、稳定 desktopId、hosts 和 backendEndpoints。desktopId 属于这个桌面数据安装，不用 PID 或动态端口。原子保存由 main 串行执行：校验 → 比较 expectedRevision → 写临时文件 → fsync → 同目录 rename → 更新内存与通知。目录 0700、配置文件 0600。保存失败不改旧文件、不改变正在使用的配置、不启动新进程。损坏文件报 CONFIG_CORRUPT，保留坏文件与上次有效备份，不静默重置为空。

SSH 私钥和密码不复制进配置，使用本机 SSH config/agent。远端 Backend 登录凭据由 Electron safeStorage 加密保存为 `tunnels/credentials.enc`，config 不含明文秘密；安全加密不可用时只保留当次内存会话并明确提示。凭据身份与 hostId 关联，手机读接口不返回 Token、gateway key、票据、绝对密钥路径或原始 stderr。

持久化结构：

```text
<desktop userData>/
  tunnels/config.json               # main 持有的用户级配置
  tunnels/credentials.enc           # main 加密凭据
  tunnels/runtime.json              # 带时间/进程身份的运行快照，不能恢复成运行事实
  terminal-browser-profiles.json    # 既有 Browser 偏好，继续保留
  terminal-browser-whistle/         # 既有 Whistle Rules/Values/CA，继续保留
```

属于同一用户级归属不等于塞进同一个文件。各领域保留自己的结构和写入者，不复制 Whistle 原生规则到 tunnels 文件，不清空 Cookie 或代理数据。

### 3.2 配置合同（进入 packages/shared）

```ts
interface TunnelHostConfig {
  id: string;
  name: string;
  sshTarget: string;
  autoConnect: boolean;
  forwards: Array<{
    id: string;
    name: string;
    port: number; // 本地和远端同号；1..65535
    enabled: boolean;
    path: string; // 保留旧访问路径；默认 /
  }>;
  browser: {
    enabled: boolean;
    backendPort: number;
    profileId: "profile-1" | "profile-2" | "profile-3";
    approvedBrowserGroupId: string | null;
  };
}
```

配置 revision 与运行时 generation 分开。运行快照含 hostId、executorInstanceId、generation、appliedRevision、observedAt、SSH 状态、每条 forward 状态和 browser 状态，以及脱敏错误 code/message。SSH 状态为 disconnected/connecting/ready/reconnecting/failed；子能力为 disabled/waiting/starting/ready/needs_auth/failed。executor 为 online/offline/unsupported，offline 时最后的 ready 只能作为 lastKnownState 展示。

`TunnelHostConfig` 不含 connectionId/projectId。仅 SSH 可达的 Backend 连接使用单独 endpoint 描述 `{id, hostId, remotePort}` 引用主机，主机不反向引用消费者；endpoint 需要显式登记后才由主机连接生命周期建立内部 Backend 转发，不能临时从连接列表推导运行配置。

保存成功只代表落盘；UI 必须区分「已保存」「正在应用」「运行失败」。不把配置中的 enabled 当作当前已建立隧道。

### 3.3 桌面控制与手机读取

- 桌面 main 提供窄 IPC：`tunnels:list`、`save-config(expectedRevision, hosts, backendEndpoints)`、`connect(hostId)`、`disconnect(hostId)`、`browser-login`、`changed`；仅允许主窗口可信 renderer 调用，参数用共享 DTO 校验。保存/执行不依赖 Backend 可用性，Backend 停止时普通 SSH 仍可管理。
- main 自己持有单执行器锁，与 userData 和进程起始身份绑定。启动检查旧 owner，不能对未知进程或其他 Dev Session 进行清理；停止/替换时先失效 generation，避免迟到回调。
- main 每 5 秒及状态变化时原子写入脱敏 `runtime.json`，退出写 offline。读方超过 15 秒未收到新快照必须标 offline/unknown，不能照抄磁盘中的 ready。
- 新增 `GET /api/tunnels`：手机或其它已认证客户端读取该 Backend 获准读取的**同机桌面目录**，返回 schemaVersion、revision、owner 的 desktopId/channel/devSessionId、脱敏配置与状态。未登录 401；没有同机桌面配置根返回 503 DESKTOP_STATE_UNAVAILABLE，不去找任意 userData 或远端配置。
- 根目录由桌面启动器/Dev Session manifest 明确传给同机 Backend（`RUNWEAVE_DESKTOP_STATE_DIR`），必须在读取配置前完成环境/owner 校验。不能通过查询参数传任意路径，不能扫描用户目录发现其它实例；不得因 Electron 连到另一个 Backend 而修改这个根。
- Backend 仅只读文件、合并新鲜度，不开 config/report/import 写接口，不代替 Electron 创建 SSH。读到原子替换前后都是完整配置；无有效文件报具体错误，不写默认文件。
- 手机连接的 Backend 没有该节点桌面能力时显示不支持；手机连 devbox 不能顺带读取 Mac 配置。不新增跨机器镜像、数据库副本或云同步。手机原生界面、编辑和启停不在本轮。
- 独立 Backend 若保持在线，Electron 退出后仍可读配置和最后状态；如果内置 Backend 随 App 一起退出，手机就是不可达，不能承诺离线可读。
- Dev Session 若借用 shared Backend 且其桌面数据 owner 不匹配，该读能力标 unavailable；本功能读接口的验收应选择 dedicated Backend，不能改写共享 Backend owner 来让测试通过。

## 4. 运行行为

### 4.1 主机与端口

- Electron main 启动后加载配置并连接 autoConnect=true 的主机；手动断开仅作用于当次进程，不改 autoConnect。下次启动按保存选项执行。
- SSH 主机认证成功仅表明传输可用，不能由 Backend /health 或 Browser 是否就绪代替；无 Runweave Backend 的 SSH 主机也可以做普通端口转发。
- 各 forward 使用 `-L 127.0.0.1:P:127.0.0.1:P`，复用现有 manual-port-forward 的真实 readiness 信号，移除固定延时判定。绑定成功不代表远端 HTTP 服务健康，UI 用「转发已建立」，不声称业务服务可用。
- 同主机重复端口拒绝保存；本机被其他进程或其他主机占用时，此条返回 LOCAL_PORT_IN_USE，不换端口、不抢占、不影响其他条目。
- 路径只能是同源相对绝对路径（以 / 开头，拒绝 //、反斜杠跳转）。打开网页沿用现有 Browser 入口；不改 Whistle 规则。
- forward 或 Browser 开关仅影响对应子能力。用户主动断开主机、删除主机或修改 SSH 目标，先废弃 generation，再结束该主机子进程和 Browser binding；保留其他主机与远端 tmux。
- 运行中改普通字段无需重启全部；改端口/目标/Profile 先停止受影响资源，再启动新配置。迟到的启动成功回调不能复活被禁用/删除资源。
- SSH 传输异常自动重连，退避 1/2/5/10/30 秒封顶；认证失败、host key 不匹配、端口占用等待用户修复，不无限重试。保持 StrictHostKeyChecking=yes，不代替用户接受未知主机。
- 失败通知按 hostId + 故障代次去重；窗口内提示带打开抽屉动作，失焦用现有系统通知。关闭抽屉不停止通知订阅。
- 退出 Electron 会停止自有隧道，但不终止远端任务。不承诺退出 App 后常驻运行。

### 4.2 Browser 回连与认证

保留「远端 Backend → SSH -R → 本机认证网关 → 已获准的 Profile/Group」链路和一次性短期票据；desktopId + hostId + generation 替代以 UI connectionId 表示通道所有者。Profile 不凭用户当前选中的 Browser 推断。

主进程持有此通道的远端 Backend 会话与刷新流程。首用需要登录时在 Browser 设置内显示登录表单；认证失败只阻塞 Browser，不阻塞普通端口转发。已有认证可迁入新凭据仓，但只在后端 installationId 校验成功后关联，禁止凭相同名称/端口认定同一后端。刷新中不发送旧 accessToken；同一主机凭据只保留一个刷新请求。对手机只显示 needs_auth，不发送登录秘密。

后端新增显式终端 Browser binding 选择合同：已认证桌面可将自身已验证 binding 关联到有权访问的终端；同一终端绑定另一活跃桌面时返回冲突，不自动覆盖。终端没有选择且只有一个有效候选时允许唯一推导；多个候选返回 BROWSER_BINDING_AMBIGUOUS。capability 固定 bindingId 与 generation，旧通道重建后必须重新 resolve。移除「取最后注册 binding」逻辑。

UI 用普通 URL 打开远端终端时，可通过后端安装身份发现本机已有隧道并选择对应 binding；不根据 activeConnection 建立或销毁隧道。CLI 保留 `rw browser profile resolve` 入口，更新能力协议校验；无法识别新身份合同明确报升级需要，不回退全局 CDP。

## 5. 与连接管理解耦及迁移

### 5.1 依赖方向

Tunnel manager 不读取 viewer.connections，不以连接存在与否作为启停条件。普通 URL 连接不要求配置隧道。

仅能经 SSH 访问 Backend 的既有用户不能因本次清理失去终端入口：连接可作为消费者引用独立 hostId 的 Backend endpoint，连接记录只存 endpoint 引用与用户命名，不持有 SSH 配置、不拥有隧道生命周期。主机离线时显示等待通道，不由点击连接自动拉起。Backend endpoint 是内部动态入口，不属于用户同号开发端口转发，不改变「3001 必须还是 3001」约束。

不为每个 host 自动创建连接。devbox URL 与旧 SSH 入口经认证确认同 installationId 后，在迁移摘要中保留用户原命名和普通 URL 入口，去掉重复 SSH 入口；无法确认同一身份则不自动合并。

### 5.2 一次性迁移，不维持两套执行代码

1. 实施前记录当前脏文件及真实存储格式，备份 viewer.connections、project bindings、remote-forward 草稿和认证存储，敏感备份只留本机受限目录。
2. 迁移准备阶段读取旧 SSH 字段和手动转发草稿，生成 hostId、Browser 配置、forward port/path；旧版没有 autoConnect 字段的已自动连接条目设 true；已保存的转发草稿默认 disabled，避免把未启用草稿当运行意图。
3. 对目标 Backend 身份可验证的重复入口生成明确合并摘要；SSH-only 入口转为 endpoint 消费者。终端导航、项目引用只改归属，不删除远端项目或 session。
4. Electron main 按 migrationId 与导入摘要事务落盘，迁入凭据后读回校验。任一阶段失败保留旧数据和新导入状态供幂等重试，不删除旧记录。
5. 验证新持久化配置与连接引用完整，再提交 renderer 存储迁移；删除旧 SSH 字段、旧 forward key 和旧启动/Browser 观察器。禁止双写或旧执行器并行运行。
6. 迁移适配代码集中为一次性导入边界，不散落在业务代码；部署迁移完成且验收后删除旧字段读取/导入实现和旧 DTO。离线备份不是运行兼容路径。
7. 回滚时先停止新执行器和 binding，恢复旧版本与迁移前存储备份；不能旧版本读取新 schema，也不能在新旧执行器同时运行时回滚。

## 6. 文件落点与任务顺序

以下新文件路径为建议职责边界，执行者可为符合就近规则调整内部拆分，但不得改变合同与归属。

- [x] T1 合同与存储：新增 `packages/shared/src/tunnels/index.ts` 与包导出；新增 `electron/src/tunnels/store.ts`、`electron/src/desktop/local-state.ts` 负责原子文件/环境归属；新增 `backend/src/tunnels/read-model.ts`、`routes.ts`，在 Backend transport 装配受认证只读接口。完成 revision、脱敏读取、TTL 与权限验证。
- [x] T2 独立执行器：新增 `electron/src/tunnels/manager.ts`、`credentials.ts`、`ipc.ts`；用 `electron/src/tunnels/ssh-process.ts` 统一执行 SSH，删除旧 `ssh-connections.ts`、`manual-port-forward.ts`。在 `electron/src/main.ts` 管理生命周期，在 `preload.ts` 和 `packages/shared/src/desktop/bridge.ts` 提供窄桥接。先完成普通端口主链与主机无 Backend 场景。
- [x] T3 Browser 归属：调整 `electron/src/remote/browser-gateway.ts`、`backend/src/remote/browser-bindings.ts`、`routes.ts`、`packages/shared/src/remote/index.ts`、`packages/runweave-cli/src/commands/browser-profile.ts`。完成远端授权、终端绑定、冲突拒绝、generation 失效及真实远端 CLI 验证。
- [x] T4 桌面 UI：新增 `frontend/src/features/tunnels/` 管理状态与组件；仅从本机 bridge 取得数据，使用 useMemoizedFn。修改 `frontend/src/components/terminal/workspace/header.tsx` 增加更多入口；新增抽屉、表单、认证和故障提示。移除连接页上的远程主机编辑、Browser/转发配置。调整 `frontend/src/features/connection/use-connections.ts`、`types.ts`、`workspace-overview.tsx`、`frontend/src/pages/connections-page.tsx`、`frontend/src/components/connection-page.tsx`，删除旧 `remote-port-forwarding.tsx` 被替代路径。
- [x] T5 迁移与清理：按第 5 节执行一次性导入，清理旧 IPC、协议字段、启动 effect 和项目绑定耦合。避免误删仍用于 Attention 的项目数据；维护当前登录态回归修复。审计所有 connectionId/generation/remote-forward 引用后删除旧实现。
- [ ] T6 验收与文档：执行配套 YAML 和代理持久化配套计划；更新 `docs/architecture/ssh-remote-projects.md`、`docs/cli/browser-profile.md` 及本地持久化/手机读接口说明。正式实现通过后冻结原型并按文档治理归档成果、删除临时实施计划。

本轮不创建 iOS 页面或修改 Swift DTO；首次实现手机界面时再消费本合同、按原生规则真机验收。本轮用独立认证客户端验证读取权限与节点范围，不把 HTTP 验证说成手机 UI 已完成。

## 7. 验收、门禁和交付

配套：[独立隧道管理验收](../testing/platform/ssh-tunnel-manager.testplan.yaml)。新增能力尚未实现，本轮仅编写及格式校验；用例不能作为现有产品通过证据。

实现时逐项验证：

- 新建配置写入磁盘，刷新/重启保持原端口和路径，手机角色客户端 GET 同源数据。
- 切换连接/关闭抽屉/重载 renderer 不改变真实隧道；退出 Electron 后状态不能继续伪装 ready。
- 真实同号 HTTP/WebSocket 转发、冲突拒绝、无 Backend 主机转发正常。
- Browser 身份、Profile 边界、重连失效与两桌面冲突。
- 单写入、revision 冲突、故障写入不丢旧数据、幂等迁移、只有 SSH 入口仍可访问。
- 无权限读取/写入拒绝；日志与手机 DTO 不含凭据。

相关检查：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/electron lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm architecture:check
pnpm docs:check
pnpm testplan:validate docs/testing/platform/ssh-tunnel-manager.testplan.yaml
git diff --check
```

环境根透传涉及 `electron/src/desktop/config.ts`、`electron/src/backend/runtime.ts` 与 `scripts/dev-session/services/dedicated.mjs`，需同步检查 Dev Session start/status/open/stop 的 owner，不能只调整环境变量。

不新增单元测试。真实环境使用 toolkit:runweave-dev-session 规划隔离 Beta，再通过 dev:open 解析 endpoint；桌面 UI 使用 toolkit:playwright-cli，真实 SSH fixture 使用专用主机/测试账号和空闲固定端口。重启后重新解析 endpoint，不复用旧 target；清理只结束本轮拥有的资源，不动用户 Agent、Browser Profile、tmux 或生产服务。

验收环境缺失必须记为 blocked，不能用原型或 mock 代替。提交/PR/合并不在本次计划请求授权内；桌面更新另按明确的更新任务和既有保护流程执行。

## 本轮执行记录

核心集成与 UI 验收证据见本地 `artifacts/validation/network-dvs-3d4465/README.md`。本轮创建的全部测试实例、远端专用终端与 fixture 已清理；正式桌面未更新。没有宣称两份计划共 23 项全部通过，具体未覆盖项及全量 Dev Session 自检受其它任务活跃槽位影响的失败记录见该报告，最终验收任务继续保持未勾选。
