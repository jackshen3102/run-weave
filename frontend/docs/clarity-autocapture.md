# Web Clarity 自动采集

普通 Web 主入口默认加载 Microsoft Clarity。代码入口是 [clarity.ts](../src/features/analytics/clarity.ts) 与 [main.tsx](../src/main.tsx)。前端构建包含加载器和项目 ID；官方采集脚本运行时从微软下载。业务组件没有手工事件、身份上报或元素标签，点击不等于业务成功。

## 构建配置与运行范围

| Vite 环境变量             | 行为                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `VITE_CLARITY_PROJECT_ID` | 缺省使用 Web 生产项目 `yo8dc0des6`；可覆盖为独立验收项目 `yo6azwkf18`。非空 ID 仅允许 ASCII 字母数字。 |
| `VITE_CLARITY_ENABLED`    | 缺省启用；显式字符串 `false` 关闭。                                                                    |

Vite 开发服务（包括 Dev Session）不初始化；即使 Dev Session 使用生产模式构建，存在 `VITE_RUNWEAVE_DEV_SESSION_ID` 时也不初始化。Electron、Companion bridge、独立 `companion.html` 和 overlay harness 继续排除。仅正常 `http:`/`https:` Web Document 加载 `https://www.clarity.ms/tag/<projectId>`。同一 Document 只安装一次；SPA 导航不重复安装。脚本下载或上传失败不阻塞产品操作。

如需云端验收，使用隔离的**生产模式构建**并覆盖项目 ID：

```bash
VITE_CLARITY_PROJECT_ID=yo6azwkf18 pnpm --filter @runweave/frontend build
```

开发服务器和 Dev Session 不会产生 Clarity 会话，不能用于云端采集验收。项目 ID 是公开标识，不是后台凭据；应用不传 Runweave token、sessionId、connectionId 或自定义用户身份。Web 生产项目当前登记的网站 URL 为 `http://127.0.0.1:5001`；项目存在不代表真实线上流量已进入。

## 遮盖、披露和验收

生产与验收项目均使用全局 Strict masking，不添加 unmask。Strict 遮盖文本与图片，但不能据此推断 URL、属性或所有媒体都安全；使用唯一合成标记检查实际上传和回放。项目规则的修改需要等待生效后用新会话验证。上线前核对既有用户披露和部署环境的 cookies/consent 要求。

使用 [Web Clarity 测试计划](../../docs/testing/analytics/web-clarity-autocapture.testplan.yaml) 验证默认构建、Dev Session 排除、普通 DOM 行为、云端回放、遮盖及性能。浏览器网络请求只证明客户端尝试采集，不证明官方后台有可用回放。无法访问后台时相关项记 blocked。

## 关闭与回滚

以 `VITE_CLARITY_ENABLED=false` 重新构建并部署，完整刷新后的新 Document 不再初始化；旧页面需刷新或关闭。只更改服务进程变量不会改变已构建包；移除脚本节点不能停止已运行 SDK。紧急停止需使用已验证的部署阻断或后台规则，并核对实际效果。

参考：[官方安装](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup)、[遮盖](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking)。
