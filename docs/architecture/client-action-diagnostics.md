# 客户端操作诊断

用于把 Clarity 中的异常行为对应到安装包和实际处理阶段。入口为 Web 的
[action-diagnostics.ts](../../frontend/src/lib/action-diagnostics.ts) 与两个原生宿主共用的
[IOSDiagnostics](../../packages/ios-diagnostics/Sources/IOSDiagnostics/ClientDiagnostics.swift)。
Swift 包只依赖 Foundation，不依赖业务 App、Web 或 Clarity；共享浏览器只向宿主回调固定阶段，
由宿主写日志，不取得业务凭据。

## 如何判断一次操作

每次发送、保存、浏览器打开或连接尝试产生独立 operation ID，阶段沿用同一个 ID。
终端 HTTP 输入沿用该 ID 作为业务 operationId；随记 request_started 记录原有幂等键对应的
relatedOperationId，手动重试产生新诊断操作，但仍可关联同一业务请求。不改变原有幂等或重试策略。

| 阶段                         | 能证明的边界                                                               |
| ---------------------------- | -------------------------------------------------------------------------- |
| started / rejected           | 处理函数收到意图，或本地前置条件拒绝                                       |
| request_started              | 已调用传输接口，不证明服务器收到                                           |
| response_received            | 收到响应，不证明响应通过业务校验                                           |
| confirmed                    | 业务接受响应通过校验；终端仅指输入已接受/入队，不代表命令执行完成          |
| state_updated                | 已提交客户端模型状态，不证明画面渲染                                       |
| ui_updated                   | 已进入相应界面生命周期；随记编辑页成功退出或 Web 保存结果进入 React effect |
| loaded                       | 浏览器导航完成，不代表页面内业务成功                                       |
| failed / unknown / cancelled | 已知失败、请求结果未知或当前操作失效；不能将 unknown 当成失败自动重发      |

原生浏览器另有 awaiting_confirmation 和 presentation_requested，分别表示等待确认与请求呈现。
analytics 的 confirmed 只表示本地 SDK 初始化或标签调用已被接受，不表示云端收到数据。
一个操作后续的状态更新不能抹去此前 unknown/failed；应查看完整时间线，不能只取最后一条。

## 回放与环境

Web 和原生 App 通过 Clarity 自定义标签 diagnostic*launch_id 与本地启动 ID 对应，再按时间和
固定 action*\* 阶段事件定位操作。原生本地记录还包含 SDK 回调提供的 Clarity 会话 ID。
版本、构建 ID、源码 revision 来自正在运行的安装包；缺失时保留 unknown，不从连接的 Backend 推导。
原生区分 analytics_environment、build_configuration、device_kind；分析项目归属不能替代服务环境核对。

Clarity 未初始化、被禁用或离线时，本地操作记录仍工作。仅在原有启用条件成立时发送固定事件和
版本/启动关联标签，不新增用户身份、不放开遮盖、不补发离线历史事件。SDK 接受调用不证明上传成功；
需要在独立 QA 项目看到新会话、标签、事件和实际回放后，才能报告云端验证通过。

## 本地保留与导出

- Web/Electron：当前 origin 的 localStorage 最多保留256条、256 Ki字符的 JSON 操作记录，
  写盘合并间隔500毫秒。日志上报窗口的“导出最近操作诊断”无需先开始录制；手动结束并上报时
  同时带上该有界窗口。存储受限时仍保留内存记录，导出包含 persistenceFailed。
- 两个 iOS App：各自沙箱的 Library/Application Support/ClientDiagnostics/records.json，
  最多512条，串行队列合并写盘，目录排除备份，使用文件保护。进程在延迟写盘前退出可能丢失尾部记录。
  Runweave 复用现有诊断导出；随记在使用分析区域先“准备诊断日志”，再通过系统分享导出。
  原生导出也披露持久化失败；损坏文件保留，内存记录仍可导出。

只记录固定操作/阶段名、生成的关联 ID、时间、耗时、版本和有限错误码，不记录输入正文、URL、
附件名、密码、token、响应正文或错误描述。详细日志默认留在设备；Clarity 固定阶段事件用于发现
候选，不能替代设备日志、真实复现或服务端证据。

验收使用隔离 Dev Session 与共享模拟器池：实际操作成功、确定失败及响应丢失场景，核对同一 ID
的阶段、草稿保留与原幂等键重试，并用唯一正文标记检查导出中未包含正文。构建、SDK 返回值或
截图单独都不能替代这些后置条件。原生共享浏览器变动必须同时操作两个宿主。
