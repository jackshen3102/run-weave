# Mac 本地 Agent，经 Devbox 中转

2026-09-25 实测方案的历史教学快照，用来解释反向 SSH 的建连方向、手机输入与终端输出链路、Mac 进程的生命周期。不是已合入产品的部署合同。

## 阅读与运行

打开 `index.html` 对应的 HTTP 页面，按四个步骤查看建隧道、发指令、回结果和手机离线的变化。展开底部说明可以读取端口语义和接口。

```bash
python3 -m http.server 6188 --bind 127.0.0.1 --directory docs/architecture-flows/mac-agent-devbox-relay
```

浏览器打开 `http://127.0.0.1:6188/`。无外部依赖；SVG 图另存为 `architecture.svg`。图中的箭头动画仅作教学演示，不连接或操作真实机器。

## 事实基线

- `packages/app-ios/Sources/RunweaveIOS/Services/APIClient.swift`：手机输入通过 `POST /api/terminal/session/{id}/input`；终端输出通过 `/ws/terminal`。
- 本机私有部署目录 `~/.runweave/mac-relay-poc-20260925/`：`relay.mjs`、`gateway.mjs`、SSH launchd plist 与 `README.md`。仅引用路径，不复制私人配置或凭据。
- 真机证据目录 `.runweave/mobile-qa/mac-relay-phone-20260925/`：`result.json`、`agent-transcript-evidence.json`、`process-evidence.txt`、`phone-recovered.png`。
- 实测手机为 iPhone 17，iOS 26.6.1，已安装 App 0.1.0 (1)。USB 用于 UI 自动化；网络为 Wi-Fi。蜂窝 + VPN 尚未验证。

## 核心结论

1. Mac 主动发起 SSH，Devbox 的反向监听端口沿已有连接回到 Mac。本例无需公网直接连接 Mac。
2. 手机使用 Mac Backend 的登录身份；Devbox 对本次链路只转发流量。代码与 Pi 进程保留在 Mac。
3. 三个新增端口各司其职：Devbox 内网入口 15443、Devbox 回环反向入口 15444、Mac 回环网关 15445；后者转到已有 Backend 5001。
4. 手机退出或 App 重启不等于 Mac 进程结束。本轮核对 shell 与 Pi 的 PID/启动时间未变，并验证手机恢复后继续对话。
5. 网关保留原登录鉴权、拒绝内部路由。SSH 加密只覆盖 Mac 与 Devbox 段；手机段当前内网 HTTP，未配置 HTTPS。

## 边界与维护

- 本轮 Pi 关闭工具，仅验收对话与进程连续性；图中的项目与工具框表示 Mac 上的开发资源，不声明已做全桌面或模拟器测试。
- 后台完成测试由 Mac 的 rw CLI 在手机退到后台后发起；前两条指令由手机 UI 发起。
- Mac 休眠、重启、退出登录、长时间断网，以及全日稳定性未验证。当前服务没有安装开机/登录自启动。
- 修改端口、代理路由或进程管理方式后，需要重新对照部署脚本并更新图；不能仅凭这张历史图判断现有运行状态。
- 页面验收：使用仓库固定版本的 Playwright CLI，检查四个场景、技术详情、桌面与移动视口及浏览器 console；默认状态截图存为 `preview.png`。

## 页面验收结果

2026-09-25 使用仓库 Playwright 1.62.1，附着当前终端解析得到的 Profile 1，并新建专用页面保留原标签。四个场景切换、详情展开/折叠通过；1440 × 1180 桌面与 390 × 844 移动视口通过，移动页面无整体横向溢出、架构画布可横向滚动。本页面重新加载和操作期间 pageerror / console error 均为 0。`preview.png` 已实际查看；SVG 通过 XML 解析；`pnpm docs:check` 通过。
