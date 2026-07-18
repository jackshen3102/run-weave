# Terminal Browser Tool Menu Prototype

右侧 Terminal Browser 工具栏分组与 per-tab 显示缩放的可运行 HTML 原型。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-browser-tool-menu
```

默认状态、工具提升状态与缩放验收状态：

```text
http://127.0.0.1:6188/?more=1
http://127.0.0.1:6188/?more=1&headers=1
http://127.0.0.1:6188/?more=1&annotations=2
http://127.0.0.1:6188/?more=1&headers=1&annotations=2
http://127.0.0.1:6188/?more=1&zoomMenu=1
http://127.0.0.1:6188/?more=1&zoomMenu=1&zoomA=80
http://127.0.0.1:6188/?tab=tab-b&zoomA=80&zoomB=100
```

## 原型简报

- 目标：压缩浏览器地址栏右侧的常驻工具，并为当前 Browser Tab 提供低成本、浏览器式显示缩放入口。
- 用户动作：直接使用常驻工具；从“更多”展开其它工具；进入 Zoom 子菜单执行放大、缩小或重置。
- 关键状态：请求头规则数量、标注数量、“更多”是否展开、当前 Tab、每个 Tab 独立的 `displayScale`。
- 动态规则：请求头规则或标注数量大于 0 时，对应入口提升到外层，并从“更多”移除。
- 缩放规则：新 Tab 默认 100%；修改只作用当前 Tab；切到其它 Tab 展示其自己的比例；切回后恢复原比例。
- 非目标：原型不实现 Electron IPC、CDP Proxy 命令组合、Agent 接口，也不证明 Playwright 点击与截图已经满足缩放不变量。
- 影响模块：`terminal-browser-navigation-bar.tsx`、原生工具菜单、per-tab Browser 状态，以及后续 CDP Proxy 显示缩放控制面。

## 验证点

- 无配置时外层为复制地址、代理、更多，其余工具只在更多中出现。
- 仅请求头有配置时，请求头提升到外层。
- 仅有标注数据时，标注入口提升到外层；提交标注仍属于更多中的独立工具。
- 两者都有数据时同时提升，任何工具都不重复。
- 更多使用 Electron `Menu.popup()`，由系统菜单覆盖 Electron `WebContentsView`。
- Zoom 作为原生子菜单出现，父级始终显示当前 Tab 的缩放百分比。
- A Tab 调整到 80% 后，B Tab 仍为 100%；切回 A Tab 后仍为 80%。
- Zoom out、Zoom in 按预设档位调整当前 Tab；Reset zoom 只将当前 Tab 恢复到 100%。
- 选择任一缩放动作后菜单关闭，保持 Electron 原生菜单的低成本交互语义。

## 功能分类

### 产品核心功能

| 元素 / 行为          | 最终产品是否需要 | 产品价值            | 备注                     |
| -------------------- | ---------------- | ------------------- | ------------------------ |
| 复制地址、代理常驻   | 是               | 保留最高频入口      | 顺序固定                 |
| 其它工具进入更多     | 是               | 降低工具栏密度      | 保持原动作               |
| 请求头、标注动态提升 | 是               | 有状态时保持可见    | 分别按规则数、标注数判断 |
| 原生系统菜单         | 是               | 可靠覆盖浏览器 View | 产品使用 `Menu.popup()`  |
| Zoom 原生子菜单      | 是               | 低成本提供缩放入口  | 显示当前 Tab 百分比      |
| per-tab displayScale | 是               | 保持标签间缩放隔离  | 新 Tab 默认 100%         |
| 人与 Agent 共用状态  | 是               | 两端看到同一缩放值  | Agent 接口不在原型中模拟 |

### 原型辅助功能

| 元素 / 行为  | 辅助验证什么                 | 为什么不进入产品              | 备注                                                                        |
| ------------ | ---------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| URL 参数     | 工具提升与缩放状态快速切换   | 产品使用真实状态              | `headers` / `annotations` / `more` / `zoomMenu` / `tab` / `zoomA` / `zoomB` |
| CSS 页面缩放 | 表达 displayScale 的视觉结果 | 产品由 CDP Proxy 组合显示缩放 | 不能作为真实缩放实现依据                                                    |
| 模拟网页内容 | 表达工具托盘与浏览器边界     | 产品使用真实 WebContentsView  | 不作为产品内容                                                              |

## 冻结记录

- 最终采用：复制地址、代理常驻；请求头和标注按数据动态提升；其余工具进入 Electron 原生系统菜单；Zoom 使用显示当前百分比的原生子菜单。
- 缩放架构采用方案三：Runweave 保存 per-tab `displayScale`，由 CDP Proxy 与 Playwright 的逻辑 viewport 组合；人的 UI 与 Agent 操作同一份标签状态。
- 放弃方向：不使用 Electron `setZoomFactor` 作为产品底层；不做自定义 Chrome 式横向缩放行或额外浮层窗口；普通 Portal 下拉菜单仍会被 Electron `WebContentsView` 覆盖。
- 产品核心功能清单：已由用户本轮需求明确。
- 原型辅助功能：不进入产品实现。
- 验收方式：Playwright 检查工具提升状态、Zoom 子菜单、per-tab 缩放隔离、档位调整与重置，并保存 `prototype-preview.png`。
- 冻结时间：2026-07-18。

## 边界与实施衔接

- 原型不连接真实 Electron、后端或 IPC，不导入产品源码。
- 产品实现调整 `TerminalBrowserNavigationBar` 的入口编排，并通过 preload IPC 请求主进程弹出原生菜单。
- 产品运行态以每个 Terminal Browser entry 为缩放状态权威来源；前端 tab 只镜像当前值。
- CDP Proxy 需要提供绑定 page session 的 get/set/reset display scale 能力，并保证逻辑 viewport 不因显示缩放改变。
- 真实实现必须单独验证 locator click、CSS 坐标 click、viewport screenshot 和 full-page screenshot 在 50% / 80% / 100% 下不受显示缩放影响。
- 产品验证执行 TypeScript、Lint，并通过真实 Electron Terminal Browser CDP endpoint 使用 Playwright 验收；本原型通过 CSS 表达的缩放不构成运行时证据。
