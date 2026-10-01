# System Monitor 架构边界

系统监控从当前连接的 macOS **Backend** 读取资源事实，Web 与 Electron renderer 使用同一 HTTP 合同。
客户端原生能力不参与资源采集、排行、持续观察或进程终止权限；原生 iOS 读取同一 API，只展示能耗排行。
资源占用不改变 Runtime Status 对离散运行依赖的判断。

## 数据与生命周期

[ResourceMonitorService](../../backend/src/resource-monitor/service.ts)由 Backend runtime 创建、拥有和关闭。
启动及每 60 秒采样，single-flight；GET、页面刷新、多客户端与暂停显示均不启动系统命令。
关闭资源监控取消进行中的资源采样，原 DeviceMonitor 电量采样保持运行。关闭过程等待采样、操作与存储排空。

[采样器](../../backend/src/resource-monitor/sampler.ts)使用固定路径、参数数组及 `LC_ALL=C`，整轮预算 5 秒，
单命令输出上限 2 MiB，无 shell、sudo 或原生私有能耗 SDK。Backend 构建时编译、签名并打包一个公开 libproc 采集程序，客户端不提供采集能力：

- Backend 的 `resource-sampler` 读取公开 `RUSAGE_INFO_V0` 累计 CPU / package idle wakeups，按相邻分钟差值计算 CPU 与相对能耗影响。首帧、计数重置、进程重建或间隔超过 90 秒返回未知。
- 分数 = 单核心 CPU 百分比 + 每次 package idle wakeup 按 0.5 ms 折算的百分比。它是 CPU / 唤醒代理指标，不是应用瓦数，也不声称等于活动监视器的 Energy Impact；GPU、网络和磁盘耗电不能由此完整归因。
- `ps` 提供 PID、父 PID、UID、启动时间、RSS 与可执行信息，不读取完整 argv、cwd 或环境变量。
- 完整聚合后由页面分别展示能耗影响、CPU、RSS 的 Top 50，行内展开最多 12 个进程。
- CPU 总览采用全核心 100% 口径；进程 CPU 的 100% 表示一个核心。RSS 合计含共享页重复计入。
- `vm_stat`、`sysctl vm.swapusage` 与系统内存压力级别提供内存、Swap、压力；无法取得压力为 unknown。
- 电池供电事实复用 DeviceMonitor。结构化 `ioreg` 电压与精确 64 位符号转换后的电流仅在确认放电时估算整机 W；接电或未知返回 null。

按 `.app`、模拟器运行时或可执行名分组。appKey 与进程实例标识使用哈希，不回显完整本机路径。
Node 等通用分组不猜测项目归属。采集最多 4096 个进程，覆盖信息显式返回；缺失的能耗影响为 null，
缺失的 CPU 同样为 null，不作为完整观测。成功快照超过 180 秒为旧记录，采样失败保留真实成功时间。

## 观察与提醒

[观察逻辑](../../backend/src/resource-monitor/observations.ts)使用固定规则：能耗影响 ≥ 100（仅电池供电），
或 RSS 合计 ≥ 4 GiB；以单调时钟累计六次有效采样跨满五分钟，相邻间隔不超过 90 秒。
提示是「近 5 分钟多次检测到高占用」，不表示每秒连续高耗电。内存提醒明确不代表耗电量。
partial、错误、断档、实例集合改变时清空连续观察；接电只清空能耗观察。
三次低于阈值 80% 的有效观测结束异常，同应用/规则两次提醒至少间隔 30 分钟。

独立 [store](../../backend/src/resource-monitor/store.ts)在 profile 的 `resource-monitor/` 原子保存设置、
一小时应用静默、事件与去重；目录 0700、文件 0600，最多 200 条/24 小时。
同一 store 保存默认关闭的远程操作授权及独立 revision；旧状态文件缺失此字段时按未授权迁移。
重启后重新积累观察窗口，未结束 episode 复用原事件；初始化或保存失败仅降低资源能力。
不扩充原低电量和定时任务订阅，也不建长期资源数据库。

App 层 [Provider](../../frontend/src/features/system-monitor/resource-monitor-provider.tsx)共享每分钟一次的缓存读取。
连接切换销毁旧请求与 UI 状态；普通 Web 隐藏时停止读取，Backend 继续观察。
页面暂停只冻结展示。其他页面的新事件以紧凑提示展示，本机浏览器持久去重；监控页保留当前异常提示。

Mac 系统通知默认关闭，只有 Electron 主 renderer 可通过窄 IPC 请求。
[通知 handler](../../electron/src/monitoring/resource-notifications.ts)校验发送者、输入和事件去重；点击只定位已保存连接及应用，
不执行命令或任意 URL。开启偏好不代表已获 macOS 授权；投递失败保留应用内提醒。
系统提交结果不冒充 macOS 授权或实际展示确认，应用内提醒始终保留。
Electron 未运行不投递 Mac 通知；全部普通 Web 页面关闭时也不能显示应用内提示。

## API 与操作边界

共享合同：[resource-monitor](../../packages/shared/src/monitoring/resource-monitor.ts) 与扩展的
[system-monitor](../../packages/shared/src/monitoring/system.ts)。原 DeviceStatus v1 不变。
[资源路由](../../backend/src/routes/resource-monitor.ts)全部使用现有 Bearer 鉴权及 no-store：

| API                                                                 | 行为                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/device/resources`                                         | 缓存快照、覆盖、采样年龄、流身份、设置、提醒、授权及请求动作能力 |
| `GET /api/device/resources/settings`                                | 设置与 revision                                                |
| `PUT /api/device/resources/settings`                                | 严格布尔值、expectedRevision；并发冲突 409                     |
| `POST /api/device/resources/alerts/:alertId/snooze`                 | 固定忽略一小时，只操作本 host 的事件                           |
| `PUT /api/device/resources/remote-control`                          | 本机直连授予或撤销；严格 enabled/expectedRevision，冲突 409 |
| `POST /api/device/resources/processes/:processInstanceId/terminate` | 严格 requestId/force；已观测实例、本机或已授权远程请求 |

[ProcessActions](../../backend/src/resource-monitor/process-actions.ts)只接受服务端已观测的实例标识，
发送前实读核对 PID、启动身份、所有者与可执行信息，并重新验证会话。
系统、其他用户、当前 Runweave 控制进程或未知身份禁用操作；未授权的远程/tunnel 请求返回 403。
只有已鉴权的本机直连请求能修改授权。授权面向该 Backend 的已登录客户端，不是单手机配对授权。
每次远程操作在发信号前重新检查授权及 revision；撤销或重新授权使旧强制资格与操作缓存失效。
不接受任意 PID、signal、命令、提权或同名分组批量结束。

普通进程由用户确认后发送 SIGTERM，最多三秒实读验证退出；仍在运行才开放同会话、同实例的强制资格。
SIGKILL 必须再次确认，不自动升级。已退出、身份变化、权限不足和验证失败分别反馈，不把信号成功当退出成功。
同一 requestId 幂等缓存十分钟、最多 200 项。身份核对不是原子 OS 锁，不能消除所有 PID 重用竞态。

精确匹配当前已托管 workspace service 的 owned PID 时，操作为「停止服务」，明确影响服务及子进程，
复用已有 manager.stop 生命周期（SIGTERM 后按该服务既有规则升级）。没有通用项目归因器。
终止只更新目标结果；下一轮采样更新占用与电池功率，不承诺整个应用退出或固定续航收益。

## 验证入口

类型、lint、配置、架构和 Backend 生命周期门禁之外，按
[资源监控合同](../testing/platform/resource-monitor.testplan.yaml)及
[进程操作合同](../testing/platform/resource-process-actions.testplan.yaml)取得实际行为证据。
隔离 HTTP / 生命周期验证入口：`pnpm --dir backend exec tsx ../scripts/verify/resource-monitor/index.mts`。
终止验证只能使用自己创建的低负载 fixture，不结束用户应用或系统服务。
原生 iOS 从首页菜单或连接管理进入[耗电页面](../../packages/app-ios/Sources/RunweaveIOS/Features/ResourceMonitor/ResourceMonitorView.swift)，
复用 APIClient 和连接 generation。仅前台可见时每五秒读取缓存；确认前刷新授权，离线、过期、连接变化或撤权禁用操作。
手机设置只读取授权状态；监控、提醒开关及忽略提醒与电脑共享。普通结束及强制结束分别确认，强制资格限时。
当前阶段不包含 APNs 资源提醒、长期趋势或按阈值自动终止；模拟器验收不代表真机验收或实际续航收益。
