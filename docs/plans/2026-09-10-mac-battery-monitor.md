# Mac 电量监控与手机展示实施计划

状态：代码、本地专项验证与 iPhone 17 安装交互检查已完成；真实 APNs 推送和完整多设备联调尚未完成。粒度 L2。代码基线 `a256e1dd`，核对日期 2026-09-10；本文描述候选行为，不代表已上线。

目标是让手机知道所连接 Mac 的电量与供电状态，并能识别过期数据。本计划可独立交付；锁屏提醒由[推送计划](2026-09-10-mac-battery-alerts.md)完成，两部分都通过后才算满足完整需求。

## 现状与边界

- [桌面采集](../../electron/src/monitoring/system.ts)已经调用 `pmset -g batt` 与 `ioreg`；[IPC](../../electron/src/desktop/window.ts)只向本地 System Monitor 页面开放，手机没有读取入口。
- [DeviceHealthService](../../packages/app-ios/Sources/RunweaveIOS/Services/DeviceHealthService.swift)只检查 `/health`。[AppSession](../../packages/app-ios/Sources/RunweaveIOS/State/AppSession.swift)仅持有当前连接，退到后台会停掉事件连接。
- [事件传输](../../backend/src/ws/terminal-events-server.ts)已有鉴权、心跳和终端补发协议。设备快照可作为该连接的可选消息，不写入 TerminalEventService 的终端事件日志。
- “本地/远程”指手机通过局域网或已配置远程地址访问目标 Mac；采集始终在目标 Backend 所在机器执行。Backend 运行于 Linux 或容器时，不能宣称取得宿主 Mac 电量。
- 本期不做公网中继、自动发现、历史曲线、电池健康度、精准剩余工作时长、自动休眠或关机。电量低也不改写终端运行状态或阻断发送命令。

## 用户可见行为

| 位置或状态            | 展示与交互                                                           |
| --------------------- | -------------------------------------------------------------------- |
| 首页电脑名称旁        | 紧凑显示电池图标和百分比；点现有连接入口查看详情，不增加整行常驻面板 |
| 连接列表              | 各电脑独立显示百分比、使用电池/充电中/已接电/已充满及最近更新时间    |
| 20% 及以下且使用电池  | 黄色提示；10% 及以下改为红色，保留数字和文字，不只依赖颜色           |
| 首次尚无数据          | 显示“正在读取电量”，不先显示 0%                                      |
| Mac 无内置电池        | 显示“无电池”，不是未知或 0%                                          |
| 非 macOS 或旧 Backend | 显示“暂不支持电量监控”，不影响登录和终端                             |
| 采样失败、断线或过期  | 有旧值则显示“上次 18% · 5 分钟前”；无旧值显示“电量未知”              |

百分比仅支持 0–100 的整数，真实 0% 是有效值。“接电”与“正在充电”分开：充满、优化充电暂停也可能处于 AC 供电。剩余分钟只在详情作为估算显示；系统未给出时不猜测。

## 采集与身份规则

1. Backend 启动后立即异步采集，此后每 60 秒采集一次；前次未结束时合并，不并行积压。单次子进程总预算 3 秒，固定程序及参数、限定输出 64 KiB，不接受客户端传入命令。
2. 手机 GET、切页和客户端数量不改变采样频率。只采电源信息，不连带执行 CPU、进程列表、内存压力等整套 System Monitor 查询。采样定时器不阻止退出，关闭时取消子进程和订阅。
3. 返回百分比、供电方式、充电状态以及可用的剩余时间。抽取现有纯解析逻辑至 shared，命令执行留在各自运行时；桌面旧 DTO 通过适配保持兼容，不在此任务重做桌面看板。
4. `hostId` 是当前 Backend 安装在存储目录首次生成并持久化的 UUID；不是硬件序列号、IP、项目 ID 或每次启动变化的 serviceInstanceId。重启及端口变化不更换；换存储目录代表新安装。
5. 同一 Backend 的局域网和远程别名返回同一 `hostId`。同一 Mac 上不同隔离 profile 视为不同安装，不推断合并；开发和验收 profile 默认不具备真实推送配置。
6. 在 `resolveStoragePaths` 的 `browserProfileDir` 下新建专用 `device-monitor/state.json`；原子落盘、串行写入，新目录 0700、文件 0600，不调整既有 profile 目录权限。一个监控目录只允许一个写入者；第二个进程只禁用设备监控并说明冲突，不影响终端。不得把恢复前的旧读数视作新样本。
7. 休眠期间不承诺采样。恢复后执行到期采样，只做一次，不补跑休眠期间所有 tick；采样失败不把电量归零。

## HTTP 与事件合同

新增 `GET /api/device/status`，使用现有 Bearer 鉴权，响应 `Cache-Control: no-store`；不能把电量、设备名称等塞入公开 `/health`。

```ts
type DeviceStatusSnapshot = {
  protocolVersion: 1;
  hostId: string;
  streamId: string; // 采集服务本次生命周期的 UUID
  revision: number; // 同一 streamId 内每次采样尝试完成后递增
  sampleStatus: "pending" | "ok" | "error" | "unsupported";
  observedAt: string | null; // 最后一次成功观测的 ISO 时间
  sampleAgeMs: number | null; // Backend 用单调时钟计算，不要求手机时钟同步
  battery: {
    presence: "present" | "absent" | "unknown";
    percent: number | null;
    powerSource: "battery" | "ac" | "unknown";
    chargeState:
      | "charging"
      | "discharging"
      | "full"
      | "not_charging"
      | "unknown";
    remainingMinutes: number | null;
  };
};
```

- 未采样时 `pending`、`observedAt=null`、字段未知。失败时 `error`，保留最后成功 battery 与 observedAt；已确认无电池用 `ok + absent`；不支持的平台用 `unsupported + unknown`。
- 在已有 `/ws/terminal-events` 上以 `deviceStatus=1` 显式订阅，新增独立传输消息 `{type:"device-status", snapshot}`。服务端先鉴权，原子建立订阅并发送当前快照，之后每次采样完成发送一帧。即使电量不变，也更新成功采样时间，避免长时间 100% 被误判失联。
- 不修改终端 cursor、补发日志及 completion 语义。旧客户端未显式订阅则完全不接收新帧；新增消息体不能强迫旧终端 DTO 解码设备字段。
- GET 与事件竞态按连接 generation、hostId、streamId、revision 接受结果：同一 streamId 拒绝更小 revision；新的 socket 建立后丢弃建立前发起的 GET；streamId 更换只从当前连接的重新同步流程接受，不由迟到响应触发回退。
- 长连接需保留鉴权 sessionId，在广播前确认会话仍有效；失效就停止发送并关闭。普通临时 WS ticket 到期不等于登录会话失效，不以旧 ticket 到期时间反复踢掉正常连接。

## 手机生命周期与新鲜度

- 当前连接复用 AppSession 的事件连接；认证成功、前台恢复和 socket 重连时读取快照。设备采样错误仅影响电量区域；401 仍由已有认证恢复逻辑处理。
- 连接管理页打开时，使用各连接已有的独立 APIClient/Keychain 凭据并发读取，最多同时 3 个请求；不切换 activeID，不把当前连接的 token 发给其他地址。没登录的连接提示登录后查看。
- 非当前连接不在后台维持长连接；列表显示其最近读取时间，可手动刷新。离开列表取消请求。后台提醒由推送订阅覆盖所有已启用的电脑，不依赖当前选中哪台电脑。
- 手机记录收到快照的单调时间，用 `sampleAgeMs + 收到后的已逝时间` 判断新鲜度。超过 180 秒、已知断线或 `sampleStatus=error` 即显示旧值；不能用收到消息的时间替换实际采样时间。
- UI 可用本地时间刷新“几分钟前”，这不发网络请求。跨进程恢复缓存一律先标旧，成功获取新样本后再标新。
- 电量状态由新的独立 ObservableObject 持有，避免继续扩张 AppSession；AppSession 只负责传入连接身份、事件与生命周期。删除连接、换地址、退出登录均清理对应缓存和在途任务。

## 文件与任务

以下新文件是计划落点，实施前读取就近 AGENTS；既有文件只改装配和必要调用。

| 任务               | 文件范围                                                                                                                                                                                                                                     | 完成条件                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| P1.1 合同与解析    | 新建 `packages/shared/src/monitoring/device-status.ts`、`battery.ts`；修改 `packages/shared/package.json`、`electron/src/monitoring/system.ts`                                                                                               | 新旧 DTO 适配明确，接电/充电/失败/无电池可区分 |
| P1.2 Backend owner | 新建 `backend/src/device-monitor/{service,sampler,store}.ts`；修改 `backend/src/utils/path.ts`、`bootstrap/runtime-services.ts`、`index.ts`                                                                                                  | 单采样器、超时和退出清理、持久身份生效         |
| P1.3 传输          | 新建 `backend/src/routes/device-status.ts`；修改 `backend/src/ws/terminal-events-server.ts`、`terminal-events-handshake.ts`、`packages/shared/src/terminal/runtime/events.ts`                                                                | 鉴权读取、显式订阅、旧客户端兼容及撤销生效     |
| P1.4 原生状态      | 新建 `packages/app-ios/Sources/RunweaveIOS/Contracts/DeviceStatus.swift`、`State/DeviceStatusStore.swift`；修改 `Services/APIClient.swift`、`Contracts/TerminalEvent.swift`、`Features/Terminal/EventStream.swift`、`State/AppSession.swift` | 切换、后台、迟到响应和失败隔离生效             |
| P1.5 原生展示      | 新建 `Features/Connections/DeviceBatteryView.swift`；修改 `App/RootView.swift`、`Features/Connections/ConnectionManager.swift`                                                                                                               | 紧凑标识、逐连接读取、旧值文案和无障碍可读     |
| P1.6 验证与说明    | `scripts/verify/device-monitor/` 的集成驱动；既有 iOS XCUITest 执行器；更新 `docs/architecture/system-monitor.md`、`packages/app-ios/docs/architecture.md`                                                                                   | 验收证据分清系统实读、注入场景、模拟器与真机   |

目录级花括号表示该目录内列出的独立文件，不是新增一个通用框架。shared 只放纯合同和解析函数，不放命令执行、定时器或存储。

## 验收与交付

配套[设备监控用例](../testing/app/mac-battery-monitor.testplan.yaml)，共 16 条 required 用例。阈值数据只能通过本轮隔离 Backend 的采样依赖注入；真实 HTTP/WS、鉴权、存储和原生 UI 不替换。另有真实 macOS 命令对照，不能把注入值宣称为物理电池实测。

执行阶段使用已有验收执行器和 `toolkit:run-test-cases`；本次编写阶段只校验格式。禁止新增单元测试文件。

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/electron typecheck
pnpm architecture:check
pnpm testplan:validate docs/testing/app/mac-battery-monitor.testplan.yaml
pnpm docs:check
```

原生构建从 `packages/app-ios` 执行 `node scripts/ios.mjs doctor`，再使用其实际 destination 执行 `node scripts/ios.mjs build --simulator <UDID> --configuration Debug`。构建通过不代替原生交互通过。

兼容：新 App 对旧 Backend 的 404 降级为不支持；旧 App 对新 Backend 保持原状；监控错误不关闭终端。回滚：停止挂载新路由及订阅，保留未知新文件、不删除认证和终端数据；未知存储 schema 禁用该能力并报错，不覆盖为默认值。资源监控数据不得迁入 App Server、Suiji 云服务或公开健康响应。

预计熟悉仓库的一名实现者需要 2–3 个工作日，含集成和原生验收；这是规划估算，不包含推送部分和设备/网络环境准备。实施完成后将实际合同迁入活文档，再按文档治理删除本临时计划。

## 实施进度

当前代码合同已迁入 [设备监控架构](../architecture/device-monitor.md)，实际验证与剩余门槛见
[iOS 验收状态](../../packages/app-ios/docs/validation-status.md)。注册增加持久化撤销凭据后的版本确认步骤，
防止未收到注册响应的手机留下已启用但没有撤销凭据的绑定；此步骤属于原撤销保证的实现。
