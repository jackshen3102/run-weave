# Web Clarity 自动采集

普通 Web 主入口支持 Microsoft Clarity 托管脚本，默认关闭。实现入口是
[clarity.ts](../src/features/analytics/clarity.ts) 和 [main.tsx](../src/main.tsx)。
业务组件没有手工事件、身份上报或元素标签；点击只表示交互，不代表业务成功。

## 构建配置

| Vite 环境变量             | 生效条件                                          |
| ------------------------- | ------------------------------------------------- |
| `VITE_CLARITY_ENABLED`    | 只有字符串 `true` 启用，缺省或其他值关闭          |
| `VITE_CLARITY_PROJECT_ID` | 去除首尾空白后非空且仅含 ASCII 字母数字，无默认值 |

配置应注入前端构建进程，例如在具备已验收测试项目的环境中：

```bash
VITE_CLARITY_ENABLED=true VITE_CLARITY_PROJECT_ID="$CLARITY_TEST_PROJECT_ID" \
  pnpm --filter @runweave/frontend build
```

项目 ID 是公开客户端标识，不能代替后台权限，也不能仅凭格式判断项目有效。
测试和正式环境分别使用各自的项目；开发/Beta 默认不注入配置，隔离验收可以显式
启用，没有 `PROD` 限制。不要向配置或 SDK 传 Runweave token、sessionId、connectionId
或自定义用户身份。

仅 `http:` / `https:` 的正常 Web 主入口加载
`https://www.clarity.ms/tag/<projectId>`。Electron、存在 Companion bridge 的宿主、
独立 `companion.html` 入口和实际进入的 overlay harness 分支不加载。
初始化不等待网络，不改变路由、登录、主题或 PWA 更新流程。

同一 Document 的重复调用、HMR 和 SPA 导航复用队列及项目脚本标识。
完整刷新产生新 Document 后可以重新加载。项目 tag 还可能加载版本化脚本，
多个 SDK 请求不等于重复初始化。SDK 加载前的操作可能丢失，不补发业务事件。
脚本或上传失败不触发业务错误弹窗，应用不轮询重试；SDK 自身采用官方网络策略。

## 项目设置与正式启用

先在可访问的独立测试项目设置全局 **Strict masking**，确认设置对新会话生效，
正式项目沿用相同设置。不得添加逐元素 unmask 或 `data-clarity-*`。
Strict 也会遮盖按钮文字，应通过布局、位置和动作时间判断回放是否可用；
若不足以解释体验问题，记录可用性不通过，不自行解除遮盖或补手工事件。

Strict 不是 URL、所有 HTML 属性或 CSS 的通用清洗器。用合成文本检查实际上传和
回放范围；出现不可接受的字段时保持关闭，不能宣称全量脱敏。启用前记录项目的
cookies/consent 设置并遵循已有同意流程，不伪造同意。需要额外同意流程但当前
环境尚未具备时，保持关闭。

使用有界面的 Chrome 验收；记录 bot filtering 原设置，仅在专用测试项目按需
关闭，结束后恢复。不得用伪造 UA 或手工上报绕过过滤。

如果实际部署 CSP 拦截脚本或上传，仅在已有部署配置中按观测到的必要域名最小
放行，并记录配置位置。不使用通配放行、不关闭 CSP、不代理改写 SDK。

## 关闭与回滚

设置 `VITE_CLARITY_ENABLED=false`（或移除启用配置），重新构建并部署前端。
只修改服务端进程环境变量不会改变已构建的前端。新打开或完整刷新的页面不再
初始化；旧的已打开页面不会自动停止，需刷新或关闭。移除 script 节点不能撤销
已运行的 SDK。紧急停止使用部署层已经验证的阻断方式，或回滚构建并通知刷新。
本实现不提供未经验证的 SDK stop API。

## 验收与证据

执行 [Web Clarity 测试计划](../../docs/testing/analytics/web-clarity-autocapture.testplan.yaml)。
14 条 required 全部通过才表示首期验收完成；无后台访问能力时允许交付默认关闭的
代码，但云端回放、遮盖和性能等缺失证据必须明确记为 blocked。

每次验收记录以下信息，凭据不进入 Git：

- 构建 revision、测试站点、项目 ID、访问权限、Strict 与 cookies/consent 设置、bot filtering 恢复情况。
- SDK 加载时间、项目 tag 和实际版本脚本 URL；CDN 版本不能假定固定。
- 各独立合成会话的开始时间、浏览器、URL、动作顺序、后台会话链接及回放截图。
- 点击、动态菜单、SPA 导航、内层滚动与现场操作的逐项对应；请求成功不代替回放核对。
- 脚本阻断、上传阻断和关闭重建的结果；真实 Electron 与 Companion 独立入口的排除证据。
- 同源码启用/关闭构建的五组交替性能轨迹：每次开关同一菜单 30 次，以交互到下一次绘制测量，
  p95 中位数增量不得超过 `max(20ms, 基线的20%)`，附请求字节数、请求数、长任务和异常记录。

单个云端用例最长观察 30 分钟，每次等待不超过 60 秒；无权限、环境或服务阻塞记
blocked，配置无误却缺少合同承诺的普通 DOM 行为记 fail。没有可靠性能轨迹不能
宣称无影响。更换构建、项目设置或 SDK 版本后，至少复验采集闭环及全局遮盖。
不承诺终端/编辑器语义、Canvas、跨域 iframe、原生 iOS 或跨设备身份；
热力图与 Firefox 属于扩展验收。

官方参考：[安装与验证](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup)、
[全局遮盖](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking)。
