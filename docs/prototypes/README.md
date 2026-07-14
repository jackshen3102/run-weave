# prototypes（可运行原型归档）

按功能沉淀的可运行 HTML/JS 交互原型，用于设计阶段验证交互与视觉。

- **性质**：一次性产物，服务于对应功能的设计与评审阶段，功能落地后即冻结。
- **不代表当前实现**：原型里的交互/数据是 mock，最终实现以线上代码与 `docs/architecture/` 为准。
- **默认预览**：先把仓库登记为 Runweave 项目，再在 Terminal 顶部 `...` 中打开 `Prototypes`。同一轮巡库会按项目分组扫描 `<project.path>/docs/prototypes`，点击左侧原型即可在右侧运行，不需要为每个仓库或原型单独启动端口。
- **单目录排障**：只有在脱离 Runweave 排查原型自身问题时，才按子目录 `README.md` 启动临时静态服务器（例如 `python3 -m http.server --directory docs/prototypes/<name>`）。
- **不需保鲜**：不回头修改已冻结的原型。

## 当前参考入口

- `system-activity-data-foundation/`：行为事实底座的 Facts、Timeline、Sources、Data Policy 四视图原型。
- `terminal-activity-archives/`：Terminal Activity Journal 与 Multi-Agent Round Journal 的冻结交互原型，说明 Terminal 档案、Thread 分段、异构事件 Inspector 与 Run Round 归因的产品方向。
