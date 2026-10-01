# 手机耗电监控原型

2026-10-01，用户已确认并进入实现的历史设计原型。此目录始终是模拟交互；当前产品合同见 [System Monitor 架构](../../architecture/system-monitor.md)，不能把原型截图当作运行证据。

## 看什么

手机查看当前所连接电脑的电池和能耗排行，经电脑授权后结束选定的普通进程。只保留能耗排序，不复制 CPU / 内存排序 Tab。CPU 和 RSS 作为次要信息保留；RSS 不是独占内存，能耗影响不是应用瓦数。

沿用当前 iOS 的首页右上角菜单和连接管理入口，深色导航、分组列表、详情页及确认弹窗。首次没有远程权限，能查看但不能操作。电脑端开启权限后，手机普通结束；仍在运行时才显示强制结束，再次确认后执行。电脑撤销权限时，已打开的确认弹窗也失效。

可在 Runweave 的 Prototypes 面板找到本目录，或运行：

```bash
python3 -m http.server 6188 --bind 127.0.0.1 --directory docs/prototypes/mobile-energy-monitor
```

默认入口：<http://127.0.0.1:6188/>。review.html / review-preview.png 是独立评审辅助画板，不进入产品。手机推荐 390 × 844；同时检查 320 × 740、430 × 932，电脑授权视图 1000 × 760。

## 评审路线

1. 首页右上角菜单 → 耗电监控；另一路：首页左侧「我的 Mac」→ 连接管理 → 耗电监控。
2. 未授权：`?screen=energy&authorized=0`。点击应用进入详情，结束按钮不可用；提醒设置里没有授权开关。
3. 同一浏览器另开 `?screen=desktop&dialog=permission`，这是电脑端提醒设置设计。开启「允许远程结束进程」后保存。手机页自动同步权限。
4. 回到手机 node 详情，普通结束第一个进程，可取消；确认后显示已结束。
5. 第二个 node 进程的模拟结果为仍在运行；强制结束另开确认，可取消。不会自动升级。
6. Runweave 行查看受保护进程；普通 node 分组也包含一个受保护 Backend 进程。
7. 再次从电脑取消远程授权；手机结束按钮失效，即使原先已打开确认弹窗也不能继续。
8. 提醒设置里的监控和提醒开关对整台电脑生效，沿用桌面能耗与内存两条规则；没有虚构独立的能耗开关。忽略 node 1 小时作用于该应用的资源提醒。

## 截图与场景入口

URL 参数仅是演示辅助，不进入产品页面或实施功能。`authorized` 是原型的同源 localStorage 初始化参数，0/1 会修改所有同源原型页的 mock 权限。关闭页面不清空权限；用 `authorized=0` 重置。`screen` / `state` / `dialog` 参数只切换样例画面。

| 场景 | 查询参数 |
| --- | --- |
| 默认首页与菜单 | 无参数，点击右上菜单 |
| 耗电排行 | `?screen=energy&authorized=1` |
| 未授权排行 | `?screen=energy&authorized=0` |
| 进程详情 | `?screen=app&app=node&authorized=1` |
| 普通确认 | `?screen=app&app=node&authorized=1&dialog=terminate` |
| 强制确认 | `?screen=app&app=node&authorized=1&dialog=force` |
| 提醒设置 | `?screen=settings&authorized=1` |
| 电脑授权 | `?screen=desktop&dialog=permission&authorized=0` |
| 接电 | `?screen=energy&state=ac` |
| 离线 / 过期 | `?screen=energy&state=offline` / `state=stale` |
| 首轮采样 / 失败 | `?screen=energy&state=warming` / `state=error` |
| 监控关闭 | `?screen=energy&state=disabled` |

## 评审时的代码基线

- [iOS 首页](../../../packages/app-ios/Sources/RunweaveIOS/App/RootView.swift) 已显示所连接电脑电量，左侧打开连接管理；[首页菜单](../../../packages/app-ios/Sources/RunweaveIOS/Features/Home/HomeView.swift) 可增加耗电入口。
- [设备状态合同](../../../packages/app-ios/Sources/RunweaveIOS/Contracts/DeviceStatus.swift) 只接电量状态，还没有资源排行 DTO / 页面。手机继续经 APIClient 获取数据，不采集电脑或手机本地资源。
- [共享合同](../../../packages/shared/src/monitoring/resource-monitor.ts)、[Backend 资源路由](../../../backend/src/routes/resource-monitor.ts) 已提供排行、设置、忽略和结束操作。当前 terminate 只接受本机直连；本原型的远程授权与远程终止尚未实现。
- 现有 `canTerminate` 同时表示请求是否可操作及快照是否可用。实现时还需明确返回远程授权状态，避免把数据过期误显示为未授权。原型数据来自 mock-state.json，进程详情仅列代表性样例，不代表对应进程组的全部采样。

## 授权方案（用户已要求纳入后续实现）

1. 对每个 Backend host 保存 `remoteControlEnabled`，默认 false，跨 Backend 重启持久化。
2. 只有经过鉴权的本机直连请求能开启或撤销。建议新增同资源路由下的本机专用授权写入口，不能把权限字段无条件塞进当前远程也可调用的 settings PUT。
3. 手机与其他远程客户端只有读取权限状态的能力，不能自行授权。开启后的范围明确为「已登录客户端」，不是单个手机的配对授权。
4. GET 仍复用 `/api/device/resources`，扩展授权状态；`canTerminate` 依据本地/已授权远程、采样状态计算。普通进程操作继续复用 terminate API，无需另起手机专用采集或结束逻辑。
5. Backend 每次普通 / 强制请求均重新检查授权与 token；电脑撤销后旧客户端和待确认操作立即失效。持续受现有 UID、PID 启动身份、可执行路径、受保护进程检查限制。
6. SIGTERM 先核对实际退出；只有 still_running 结果才发放同会话、同进程实例的限时强制资格。SIGKILL 必须第二次确认。不可把“退出整个应用”伪装成“结束单个进程”。
7. 手机确认弹窗明确目标电脑、进程名称和 PID。离线、过期、错误或受保护时不可操作。

手机后台 APNs 资源提醒不在此轮画面中承诺；只展示 Backend 事件的应用内提醒。不加入模拟器闲置自动关闭、不展示手机自身电量排行、不推测续航收益。

## 功能分类账

| 类型 | 内容 |
| --- | --- |
| 产品核心 | 两处入口、当前电脑身份、电量与整机功率、能耗排序、应用与进程详情、Backend 提醒和设置、电脑授权 / 撤销、手机权限状态、单进程二次确认、状态与失败反馈 |
| 原型辅助 | 独立 review.html 评审画板、URL 状态参数、同源 localStorage / storage 事件模拟权限同步、固定电量和时间、代表性进程子集、立即模拟结束结果、示例首页项目 |

没有真实授权、API 调用、采样、系统通知或进程信号。所有按钮结果只作用于本目录的原型状态；不得以浏览器原型验收替代 Backend 鉴权和真实 iOS 验收。

## 验证记录

已用仓库固定版本 Playwright CLI 的独立浏览器完成 12 组交互检查：两处入口、未授权、电脑授权同步、取消 / 普通结束、仍运行 / 二次确认 / 强制结束、受保护进程、撤销使待确认失效、手机不能自授权、忽略提醒、无效采样禁止操作、接电暂停能耗提醒。五个手机页面在 320 / 390 / 430 宽度下共 15 个布局检查没有横向溢出。结果见 verification.json，全部是原型交互，不是生产权限或真实进程验收。用户已确认该设计；这些记录仅证明历史原型交互。
