# 计划：更新项目文档以反映 Electron 多后端连接支持

## 概要

最近提交 `4f2ee02` 引入了 Electron 客户端、多后端连接管理、CORS 注入、终端 Home 导航等重大变更。现有文档未覆盖这些内容，需要同步更新。

## 当前状态分析

### 已有文档

| 文件                                    | 当前内容                                      | 需更新 |
| --------------------------------------- | --------------------------------------------- | ------ |
| `AGENTS.md`                             | 项目概览仅列 前端/后端/共享 三层，无 Electron | ✅     |
| `docs/README.md`                        | 文档路由表，无 Electron 相关条目              | ✅     |
| `docs/architecture/network-topology.md` | 仅描述 Web SPA 架构，无 Electron 客户端拓扑   | ✅     |
| `docs/deployment/overview.md`           | 仅描述 Web 部署，无 Electron 开发/构建说明    | ✅     |
| `docs/quality/quality-harness.md`       | 测试体系，无需改动                            | ❌     |
| `docs/testing/layers.md`                | 测试层级，无需改动                            | ❌     |
| `docs/testing/command-matrix.md`        | 测试命令，需增加 Electron 开发命令            | ✅     |

### 最近提交引入的关键变更

1. **Electron 客户端**：`electron/` 目录，含 main.ts, preload.ts, tray.ts, updater.ts
2. **多后端连接管理**：`frontend/src/features/connection/`，用户可配置并切换多个后台地址
3. **CORS 解决方案**：Electron `onHeadersReceived` 注入 CORS 头
4. **开发命令**：`pnpm dev:electron`、`pnpm dev:electron:headed`
5. **监听地址**：`electron-dev.mjs` DEV_HOST 默认 `0.0.0.0`
6. **终端 Home 导航**：终端工作区增加返回首页按钮

---

## 变更计划

### 1. 更新 `AGENTS.md`

**原因**：项目概览缺少 Electron 层，开发命令缺少 Electron 相关命令。

**具体变更**：

- 项目概览增加 `Electron 桌面客户端：electron/`
- 最小命令增加 `Electron 开发：pnpm dev:electron`
- 文档路由表增加 Electron 相关文档条目（如果新增了文档的话）

### 2. 更新 `docs/README.md`

**原因**：文档路由表需要与 `AGENTS.md` 保持同步。

**具体变更**：

- 路由表增加 Electron/桌面客户端相关条目

### 3. 更新 `docs/architecture/network-topology.md`

**原因**：当前只描述了 Web SPA 直连后端的拓扑，未包含 Electron 客户端的网络模型。

**具体变更**：

- 总体形态增加第 4 条：Electron 桌面客户端通过自定义协议加载前端，直连远程后端
- 对外入口增加 Electron 客户端连接模型说明
- 增加"Electron 跨域处理"章节：说明 `onHeadersReceived` CORS 注入机制
- 增加"多后端连接"章节：说明连接管理器允许切换不同后台地址

### 4. 更新 `docs/deployment/overview.md`

**原因**：需要补充 Electron 开发与构建的入口说明。

**具体变更**：

- 增加"Electron 桌面客户端"章节
- 说明开发命令 `pnpm dev:electron`
- 说明 `DEV_HOST` 环境变量（默认 `0.0.0.0`）
- 说明 `electron-builder.yml` 构建配置位置

### 5. 更新 `docs/testing/command-matrix.md`

**原因**：命令矩阵需要覆盖 Electron 相关的开发与调试场景。

**具体变更**：

- 变更场景表增加"Electron 客户端开发"行，推荐 `pnpm dev:electron`

---

## 假设与决策

1. **不新建独立 Electron 文档**：Electron 相关内容分散在已有文档的对应章节中（架构 → network-topology，部署 → overview），保持文档结构扁平，与现有风格一致。
2. **文档风格**：沿用现有文档的简洁高层风格，避免实现级细节，只描述概念与入口。
3. **中文撰写**：所有文档保持中文。

## 验证步骤

1. 检查所有修改文件的 Markdown 格式正确
2. 确保 `AGENTS.md` 与 `docs/README.md` 的路由表一致
3. 运行 `pnpm lint` 确认无错误（prettier 会格式化 .md 文件）
