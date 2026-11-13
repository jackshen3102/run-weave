# Windows 云桌面终端稳定性排查

目标是在真实 Windows ConPTY 上复现用户可见的断连、输入异常、输出异常和资源增长，修复有证据的问题，再重跑失败场景与相邻场景。一次成功不能证明没有其他缺陷。

## 基线与边界

- 当前部署 Server 0.1.23，源码 8b24b10d13faec90c70785bcef6727c594a01e9f；生产 Host 仍为兼容的 0.1.20。执行前重新核对版本和进程身份。
- 独立配置目录、随机本机端口、独立认证和专用终端；不杀生产 Host、不向用户终端发送输入、不重启生产 Backend。
- 复用已安装发行包、现有真实进程验证入口和产品协议，不新增单元测试或测试框架。一次性负载驱动与原始回执放在工作区外。
- 源码变更只针对稳定复现的偏差。操作确认仅表示 PTY 收到字节，不能当作命令执行完成；窗口外的恢复快照不承诺完整历史。

## 执行顺序

1. 保存生产 Host、终端 PID、会话绑定与版本基线；建立隔离实例，确认清理只覆盖该实例。
2. 按传输计划逐项递增负载。输出带随机运行标识、序号和摘要，核对实时输出、恢复快照和落盘三个边界。记录实际吞吐、输入响应 p50/p95/p99、断开原因和恢复时间。
3. 按生命周期计划验证同代重连、跨代 writer、重启、Host 丢失及资源回收；核心资源替换不得混入其他 case 的通过证据。
4. 在实际 Mac Runweave 页面执行界面计划，使用 playwright-cli 附着更新器验证的 renderer；保留原页面和用户终端，不能用接口通过代替界面通过。
5. 首个失败保留版本、最小输入、负载、时序和独立回执；修实现后重跑该 case，再继续矩阵。故障注入与驱动自身的失败单独归因。
6. 结束后核对生产基线、删除专用终端、停止隔离服务与 Host，记录未执行与阻塞项。需要发布部署时沿用现有发行流程，不能把源码修复当作已上线。

## 场景与判据

- [传输、输入与恢复压力](../testing/platform/windows-terminal-transport-stress.testplan.yaml)：字节与序号正确、输入不重复、明确背压、会话隔离。
- [生命周期与资源压力](../testing/platform/windows-terminal-lifecycle-stress.testplan.yaml)：身份与进程符合合同、退出资源回收、内存和句柄不随循环无界增长。
- [桌面终端交互压力](../testing/platform/windows-terminal-ui-stress.testplan.yaml)：用户入口真实操作后仍可输入和恢复，恢复重试有界，页面不长期卡住。

每项记录 pass、fail 或 blocked，附实际档位和时长。格式校验不算行为通过。20 分钟持续运行只能作为该时长证据，24 小时及系统注销/整机重启未执行时必须单列。

## 可能修改的位置

- `packages/pty-host/src/`：本机管道、输入队列、ConPTY 生命周期与镜像；协议变化进入 `packages/shared`。
- `backend/src/terminal/runtime/`、`backend/src/ws/`：会话连接、输出恢复、订阅回收与 WebSocket 背压。
- `backend/src/terminal/manager/`、`backend/src/terminal/scrollback/`：持续落盘和保留边界。
- `packages/common` 与 `frontend` 的实际终端调用方：仅在真实页面复现后修改输入、渲染或恢复状态。

## 验证与兼容

新增计划执行 `pnpm testplan:validate <path>`；有实现修改时执行目标包的 typecheck/lint、对应真实 Windows 进程验收和必要的架构检查。不改变配置或数据结构则无需迁移；涉及迁移必须走既有升级合同。修复前后的回执使用同一负载与判据，不能通过降低负载掩盖失败。
