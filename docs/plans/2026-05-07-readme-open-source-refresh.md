# Runweave README 开源化刷新计划

## 目标

把当前 README 改成面向开源用户的项目入口页，重点讲清楚 Runweave 能帮用户完成什么，而不是展开内部实现细节。

这次 README 刷新要覆盖：

- 英文 README 和中文 README。
- 一个小 GIF，用来快速展示项目核心能力。
- 本地部署和桌面端启动方式。
- CLI 能力。
- 手机接力能力。
- 进一步阅读的文档入口。

## README 核心叙事

README 应围绕一句话展开：

> Runweave 是一个面向 AI CLI 工作流的终端管理和接力工作台，可以在桌面、浏览器、CLI 和手机之间管理长时间运行的 `codex`、`claude` 等命令行任务。

用户打开 README 后，应该快速理解：

- 这个项目解决什么问题：AI CLI 和长任务经常运行在终端里，用户需要创建、查看、投递、接力和恢复这些任务。
- 核心入口是什么：Web/Electron 终端工作台、`rw` CLI、手机端终端概览。
- 它适合什么场景：本地开发、远程观察、手机接力、外部 Agent 自动化投递。
- 怎么跑起来：本地开发、本地生产式运行、Electron 客户端。
- 下一步看哪里：CLI、部署、移动端、终端恢复等详细文档。

## 内容范围

需要新增或修改：

- `README.md`：英文主 README。
- `README.zh-CN.md`：中文 README，内容与英文版等价，不做简短摘要。
- `docs/assets/readme/runweave-terminal-management.gif`：README 顶部演示 GIF。
- 可选：`docs/assets/readme/README.md`，只在需要记录 GIF 生成方式时添加。

不做：

- 不修改产品代码。
- 不修改 CLI、前端、后端、Electron 行为。
- 不在 README 里展开大量内部实现、协议、源码路径或状态机细节。
- 不增加 Windows 打包说明，除非后续明确要求。
- 不加入不可公开访问或没有实际意义的 badge。

## README 建议结构

### 1. 顶部区域

内容：

- 项目名：`Runweave`。
- 语言切换：
  - English: link to `README.zh-CN.md`
  - 中文: link to `README.md`
- 一句话介绍。
- 小 GIF。
- 3-5 个关键词能力，例如：
  - Terminal workspace for AI CLI tasks
  - Desktop, browser, CLI, and mobile handoff
  - Run `codex`, `claude`, shell commands, and project scripts
  - Local-first, self-hostable

要求：

- 顶部不要写成架构说明。
- GIF 应该在第一屏附近出现。
- 如果提到内部仍有 `browser-viewer` 命名，只放在一个简短 note 中。

### 2. 为什么需要 Runweave

用用户问题来介绍项目，不从技术栈开始：

- AI CLI 任务经常是长时间运行的。
- 用户可能离开电脑，但仍想查看状态。
- 外部 Agent 需要一种稳定方式向已有终端投递输入。
- 手机端需要能看当前任务，并把上下文交给其他对话继续处理。
- 桌面客户端需要能连接本地或远端后端。

这部分只讲产品动机，不展开实现。

### 3. 核心能力

建议按功能模块写：

#### Terminal Workspace

说明：

- 创建项目和终端。
- 在终端里运行任意 CLI 命令。
- 适合 `codex`、`claude`、`opencode`、shell、watch/dev server 等命令。
- 查看实时输出、切换终端、继续向终端发送输入。

避免：

- 不详细解释 WebSocket、PTY、tmux attach 等实现链路。

#### Long-Running Task Continuity

说明：

- Runweave 面向长任务场景设计。
- 支持在可恢复的终端运行模型下继续查看或重新接回任务。
- 如果环境不支持恢复能力，终端仍可作为普通终端使用。

边界：

- 不承诺机器销毁、容器销毁后任务还能恢复。
- 不承诺自动判断 AI 任务语义上已经完成。

#### Desktop and Web

说明：

- Web 模式适合本地开发和自托管访问。
- Electron 模式适合本地桌面使用。
- Electron 客户端支持连接管理，可以连接不同后端。

避免：

- 不在 README 主体展开 Electron packaged backend 的内部细节。

#### Runweave CLI

说明：

- `rw` 是给人和外部 Agent 使用的命令行入口。
- 可以登录、确认项目、创建终端、列出终端、读取快照、生成接力上下文、发送输入。
- 适合 Hermes/OpenCloud/OpenClaw 等外部系统把任务投递到 Runweave 终端。

需要写示例：

```bash
rw auth status --json
rw project ensure --name my-project --path "$PWD" --json
rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json
rw terminal send "$TERMINAL_ID" --text "codex" --enter --confirm short --json
rw terminal snapshot "$TERMINAL_ID" --tail 120 --plain
rw terminal handoff "$TERMINAL_ID" --tail 120 --json
```

边界：

- `send --confirm short` 表示输入已投递或被短确认，不代表 AI 任务已经完成。

#### Mobile Handoff

说明：

- 手机端用于观察和接力，不是完整桌面控制台。
- `/mobile/terminals` 展示项目、终端、状态和最近输出。
- 用户可以复制接力上下文，粘贴给飞书/Hermes 或其他 Agent 继续处理。

边界：

- Runweave 不自动发送飞书消息。
- Runweave 不替用户在手机端隐式执行危险操作。

### 4. GIF 演示

GIF 目标：

- 8-12 秒。
- 一眼看出 Runweave 是终端管理工具。
- 展示能运行 `codex` 或 `claude` 这类 CLI。
- 展示“管理多个终端/查看状态/接力”的感觉，而不是只录一个普通 shell。

推荐分镜：

1. 打开 Terminal workspace。
2. 选中或创建一个项目终端。
3. 输入 `codex` 或 `claude` 作为示例命令。
4. 展示终端输出或状态变化。
5. 切换到另一个终端或展示终端列表。
6. 可选：最后带一下手机端终端概览或接力抽屉。

素材要求：

- 使用真实应用录制。
- 不暴露真实 token、用户名、私有路径或真实项目输出。
- 如果真实 `codex`/`claude` 输出不适合公开，可以用确定性的 demo 命令模拟流程，但画面中仍应让用户理解 Runweave 可以承载这类 CLI。
- 文件路径：`docs/assets/readme/runweave-terminal-management.gif`。

### 5. Quick Start

README 要给最小可执行路径：

```bash
pnpm install
cp backend/.env.example backend/.env
pnpm dev
```

补充：

```bash
BROWSER_HEADLESS=false pnpm dev
pnpm dev:electron
```

说明重点：

- `pnpm dev` 用于本地 Web/后端开发。
- `BROWSER_HEADLESS=false` 用于调试浏览器画面。
- `pnpm dev:electron` 用于桌面客户端开发。

### 6. Local Deployment

README 要提供生产风格本地运行方式：

```bash
cp backend/.env.example backend/.env
pnpm build
pnpm start
```

说明：

- `pnpm start` 启动后端服务。
- 默认适合放在反向代理后面。
- 详细部署说明链接到 `docs/deployment/overview.md`。

列出关键环境变量，但不要写成长篇配置手册：

- `AUTH_USERNAME`
- `AUTH_PASSWORD`
- `AUTH_JWT_SECRET`
- `FRONTEND_ORIGIN`
- `BROWSER_PROFILE_DIR`
- `TERMINAL_SESSION_STORE_FILE`
- `BROWSER_HEADLESS`

Electron 打包只写 mac 本地路径：

```bash
pnpm dist:electron:mac
```

### 7. Documentation

README 底部放进一步阅读入口：

- CLI：`docs/cli/terminal-cli.md`
- 部署：`docs/deployment/overview.md`
- 移动端：`docs/architecture/mobile-web-support.md`
- 终端恢复：`docs/architecture/terminal-tmux-recovery.md`
- 架构/网络：`docs/architecture/network-topology.md`
- 测试命令：`docs/testing/command-matrix.md`

这里可以链接实现文档，但 README 主体不展开这些实现细节。

### 8. Verification

贡献者检查命令：

```bash
pnpm typecheck
pnpm lint
pnpm test:e2e
pnpm test
```

说明：

- 前端正式自动化验证以 E2E 为主。
- README 文档工作不新增 `frontend/src` 下的前端单测。

## 实施步骤

1. 创建 README 素材目录。
   - 路径：`docs/assets/readme/`
   - 验证：目录存在。

2. 录制或生成 README GIF。
   - 输出：`docs/assets/readme/runweave-terminal-management.gif`
   - 验证：GIF 可打开、尺寸可读、文件大小合理。

3. 改写英文 README。
   - 输出：`README.md`
   - 重点：功能介绍优先，内部实现细节只通过链接承接。

4. 新增中文 README。
   - 输出：`README.zh-CN.md`
   - 重点：与英文版内容等价，中文表达自然。

5. 对照现有文档检查能力描述。
   - CLI 对照：`docs/cli/terminal-cli.md`
   - 部署对照：`docs/deployment/overview.md`
   - 移动端对照：`docs/architecture/mobile-web-support.md`
   - 终端恢复对照：`docs/architecture/terminal-tmux-recovery.md`

6. 格式化文档。

```bash
pnpm exec prettier --check README.md README.zh-CN.md docs/plans/2026-05-07-readme-open-source-refresh.md
```

如需修复：

```bash
pnpm exec prettier --write README.md README.zh-CN.md docs/plans/2026-05-07-readme-open-source-refresh.md
```

7. 最终检查。

```bash
pnpm typecheck
```

纯 README 改动不强制跑完整 E2E；如果 GIF 录制依赖真实页面流程，建议至少做一次手工打开检查。

## 验收标准

- `README.md` 是完整英文开源项目入口页。
- `README.zh-CN.md` 存在，并且内容与英文版实质等价。
- README 顶部包含可用 GIF。
- README 主体优先介绍项目功能，而不是源码实现。
- 用户能从 README 里理解：
  - Runweave 是什么；
  - 为什么需要它；
  - 它如何管理 `codex`、`claude` 等 CLI 任务；
  - 如何本地启动；
  - 如何本地部署；
  - CLI 能做什么；
  - 手机如何观察和接力；
  - 进一步文档在哪里。
- README 不夸大能力：
  - 不承诺自动语义化判断任务完成；
  - 不承诺手机端自动发送飞书消息；
  - 不承诺跨机器/容器销毁恢复任务；
  - 不添加未要求的 Windows 打包说明。
- Markdown 链接和图片路径可解析。
- Prettier 检查通过。

## 实施前建议决策

- README 语言结构：建议英文 `README.md` + 中文 `README.zh-CN.md`，符合开源项目习惯。
- GIF 内容：建议优先录确定性流程，避免暴露真实 AI CLI 输出。
- Badge：建议第一版不加，除非已有稳定公开 CI 或发布地址。
