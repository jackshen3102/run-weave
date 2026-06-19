# Runweave Toolkit 插件实施计划

日期：2026-06-19

## 目标

在当前 Runweave 仓库中维护一个 repo-local Codex 插件，用它承载 Runweave 相关的个性化技能，并为后续扩展 hooks、脚本、MCP 或 App 集成预留清晰边界。插件的第一阶段目标是成为可安装、可验证、可迁移的“技能包”，而不是一次性实现所有插件能力。

本计划是 Level 2 结构化实施计划。执行者需要按文件路径、manifest 合约和验证命令推进，但每个具体 skill 的正文可按现有技能内容和后续需求逐步迁移。

## 背景与代码事实

- 当前仓库是 Runweave 项目，已有 `.agents/skills/` 作为 repo-local 技能目录，包含 `using-rw`、`daily-refactor`、`daily-doc-maintenance`、`diagnostic-log-debugging`、`recorded-browser-mcp-verification`、`shadcn`、`sync-branch-hard-reset`。
- 当前仓库也有 `skills/`，包含有效 skill `review-only`。
- 插件 manifest 必须保留 `.codex-plugin/plugin.json`，插件目录名和 `plugin.json` 的 `name` 必须一致。
- 第一版插件可以只声明 `skills: "./skills/"`。如果没有实际 `.mcp.json` 或 `.app.json`，不要把 `mcpServers` 或 `apps` 写进 manifest。
- 当前插件校验路径会拒绝不支持的 manifest 字段。hooks 作为后续能力规划，但第一阶段不要把 `hooks` 字段写进 `plugin.json`，也不要留下无法通过校验的空白说明。
- 浏览器操作验证不适用于本计划第一阶段；如果后续 hooks 或技能需要打开页面验证，必须使用 `$playwright-cli`。

## 命名与目录决策

插件规范名固定为：

```text
toolkit
```

选择原因：

- 和 Runweave 项目强相关；
- 不把插件限制成单一功能，例如 `runweave-skills`，因为后续还会包含 hooks、脚本、MCP 或其他插件能力；
- 符合 Codex 插件命名规则：小写、hyphen-case、目录名和 manifest name 一致。

源码维护位置固定在当前仓库：

```text
plugins/toolkit/
```

repo-local marketplace 位置固定为：

```text
.agents/plugins/marketplace.json
```

说明：`.agents/skills/` 和 `skills/` 下的全部有效技能都要迁移到新插件中。迁移完成后，新插件的 canonical source 是 `plugins/toolkit/`。不要用 symlink 作为主要激活机制，避免路径解析和热加载行为混淆。

## 非目标

- 不在第一阶段删除 `.agents/skills/` 或 `skills/` 中的现有技能；本阶段只复制迁移并建立 canonical source。
- 不把 hooks 提前写入 `plugin.json`，除非当前 Codex 插件 validator 已经接受对应字段并且本计划同步更新验证命令。
- 不把所有技能合并成一个大 `SKILL.md`。
- 不新增单元测试、Vitest、Node test、coverage 门槛或非 E2E 测试文件。
- 不改 Runweave 前端、后端、Electron、App 的业务代码。
- 不默认发布到个人全局 marketplace；本计划优先维护 repo-local 插件源和 repo-local marketplace。

## 文件结构

第一阶段创建：

```text
plugins/toolkit/
  .codex-plugin/
    plugin.json
  skills/
    daily-doc-maintenance/
      SKILL.md
    daily-refactor/
      SKILL.md
    diagnostic-log-debugging/
      SKILL.md
    recorded-browser-mcp-verification/
      SKILL.md
    review-only/
      SKILL.md
    shadcn/
      SKILL.md
      cli.md
      customization.md
      mcp.md
      agents/
      assets/
      evals/
      rules/
    sync-branch-hard-reset/
      SKILL.md
    using-rw/
      SKILL.md
  README.md

.agents/plugins/
  marketplace.json
```

后续阶段按需创建：

```text
plugins/toolkit/
  hooks/
    README.md
  scripts/
  assets/
  .mcp.json
  .app.json
```

后续目录只有在有真实内容和验证路径时再创建。`hooks/README.md` 可以先作为 hooks 设计说明存在，但不能让 manifest 指向一个未被 validator 接受的 hooks 配置。

## Manifest 合约

`plugins/toolkit/.codex-plugin/plugin.json` 第一版应保持最小可验证形态：

```json
{
  "name": "toolkit",
  "version": "0.1.0",
  "description": "Runweave Toolkit plugin for project-specific skills and future automation extensions.",
  "author": {
    "name": "Runweave"
  },
  "keywords": ["runweave", "codex", "skills"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Runweave Toolkit",
    "shortDescription": "Runweave-specific Codex skills and automations.",
    "longDescription": "A repo-maintained Codex plugin that packages Runweave-specific skills first, with room for hooks, scripts, MCP, and app integrations in later phases.",
    "developerName": "Runweave",
    "category": "Productivity",
    "capabilities": ["Write", "Interactive"],
    "defaultPrompt": [
      "Use Runweave control-plane skills in this repo.",
      "Review Runweave repo instructions before coding.",
      "Run Runweave validation commands for this change."
    ]
  }
}
```

约束：

- `version` 使用严格 semver；本地迭代需要重新安装时，通过 cachebuster 追加 `+codex.<token>`，不要随意 bump 主版本号。
- 不出现空白说明、未定结论或需要执行者猜测的占位内容。
- 如果未来添加 `.mcp.json`，再把 `"mcpServers": "./.mcp.json"` 加入 manifest。
- 如果未来添加 `.app.json`，再把 `"apps": "./.app.json"` 加入 manifest。
- hooks 接入前先跑 validator；如果 validator 仍拒绝 `hooks` 字段，hooks 只能作为设计文件或外部安装说明存在，不能写入 manifest。
- `interface.defaultPrompt` 是当前 validator 的必填字段；必须保留 1 到 3 条短 prompt，不要改成空数组。

## Marketplace 合约

`.agents/plugins/marketplace.json` 第一版应包含 repo-local marketplace：

```json
{
  "name": "runweave",
  "interface": {
    "displayName": "Runweave"
  },
  "plugins": [
    {
      "name": "toolkit",
      "source": {
        "source": "local",
        "path": "./plugins/toolkit"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

执行时优先使用 `plugin-creator` 脚本生成或更新 marketplace，避免手写结构漂移。如果脚本生成的 marketplace `name` 和 `source.path` 与本计划不同，执行者需要先确认脚本当前语义，再选择改计划或调整命令，不要静默混用两个 marketplace 根。

## 实施步骤

### 任务 1：脚手架插件和 repo-local marketplace

**目标：**创建一个可被 Codex 识别的 repo-local 插件源。

**文件：**

- 创建：`plugins/toolkit/.codex-plugin/plugin.json`
- 创建：`plugins/toolkit/skills/`
- 创建：`plugins/toolkit/README.md`
- 创建：`.agents/plugins/marketplace.json`

**建议命令：**

```bash
	python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/create_basic_plugin.py toolkit \
	  --path /Users/bytedance/Code/browser-hub/browser-viewer/plugins \
	  --marketplace-path /Users/bytedance/Code/browser-hub/browser-viewer/.agents/plugins/marketplace.json \
	  --marketplace-name runweave \
	  --with-skills \
	  --with-marketplace
```

**实现要点：**

- 生成后检查目录名、manifest `name`、marketplace 插件 `name` 三者都是 `toolkit`。
- 如果脚本生成的 manifest 缺少本计划中的 interface 文案，按 Manifest 合约补齐。
- 如果脚本生成的 manifest 缺少 `interface.defaultPrompt`，按 Manifest 合约补齐；该字段是 validator 必填项。
- 如果 `.agents/plugins/marketplace.json` 已存在，追加 `toolkit` entry；不要重排已有 entry。

**验证：**

```bash
python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  /Users/bytedance/Code/browser-hub/browser-viewer/plugins/toolkit
```

预期：validator 通过，没有 placeholder、manifest 缺字段或路径不存在错误。

### 任务 2：迁移两个目录下的全部有效技能

**目标：**把 `.agents/skills/` 和 `skills/` 下的全部有效技能复制到插件内，形成完整的 Runweave 技能包初始版本。

**文件：**

- 创建：`plugins/toolkit/skills/daily-doc-maintenance/SKILL.md`
- 创建：`plugins/toolkit/skills/daily-refactor/SKILL.md`
- 创建：`plugins/toolkit/skills/diagnostic-log-debugging/SKILL.md`
- 创建：`plugins/toolkit/skills/recorded-browser-mcp-verification/SKILL.md`
- 创建：`plugins/toolkit/skills/review-only/SKILL.md`
- 创建：`plugins/toolkit/skills/shadcn/`，包含 `SKILL.md`、`cli.md`、`customization.md`、`mcp.md`、`agents/`、`assets/`、`evals/`、`rules/`
- 创建：`plugins/toolkit/skills/sync-branch-hard-reset/SKILL.md`
- 创建：`plugins/toolkit/skills/using-rw/SKILL.md`
- 修改：`plugins/toolkit/README.md`

**迁移范围：**

- 从 `.agents/skills/daily-doc-maintenance/` 迁移 `daily-doc-maintenance`。
- 从 `.agents/skills/daily-refactor/` 迁移 `daily-refactor`。
- 从 `.agents/skills/diagnostic-log-debugging/` 迁移 `diagnostic-log-debugging`。
- 从 `.agents/skills/recorded-browser-mcp-verification/` 迁移 `recorded-browser-mcp-verification`。
- 从 `.agents/skills/shadcn/` 迁移 `shadcn`，保留该目录下的附属文档、规则、资产和 eval 文件。
- 从 `.agents/skills/sync-branch-hard-reset/` 迁移 `sync-branch-hard-reset`。
- 从 `.agents/skills/using-rw/` 迁移 `using-rw`。
- 从 `skills/review-only/` 迁移 `review-only`。
- 忽略 `skills/.DS_Store`，它不是技能文件。

**实现要点：**

- 保持每个 skill 独立目录和独立 `SKILL.md`。
- 不把多个 skill 合并成一个“总入口”。
- skill frontmatter 中的 `name` 必须和目录语义一致。
- YAML frontmatter 中包含冒号、引号、中文标点时要保证可被 YAML 解析。
- `description` 负责触发准确性，不要写成泛泛的“Runweave helper”。
- 迁移 `shadcn` 时必须复制 `SKILL.md` 引用的附属文件和图片资产，不能只复制入口文件。
- 迁移时保留原技能正文语义；如果 frontmatter 有解析问题，只做最小语法修复。
- 迁移 `shadcn` 时删除或转换当前 validator 不接受的 frontmatter 键，例如 `user-invocable`。`user-invocable: false` 不影响触发语义，可以在迁移副本中移除；不要把不支持字段原样带入插件。
- `README.md` 记录插件是 canonical source，现有 `.agents/skills/` 和 `skills/` 是历史来源或过渡来源。

**验证：**

```bash
python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  /Users/bytedance/Code/browser-hub/browser-viewer/plugins/toolkit
```

验证每个迁移后的 skill：

```bash
for skill_dir in /Users/bytedance/Code/browser-hub/browser-viewer/plugins/toolkit/skills/*; do
  [ -d "$skill_dir" ] || continue
  python3 /Users/bytedance/.codex/skills/.system/skill-creator/scripts/quick_validate.py "$skill_dir"
done
```

预期：所有迁移后的有效 skill 都能通过基础解析；如果失败，优先检查 frontmatter YAML、unsupported frontmatter key 或缺失的相对资源，而不是重写正文。

### 任务 3：安装并确认 Codex 可见性

**目标：**让当前 repo-local marketplace 中的插件可以被 Codex 安装。

**文件：**

- 不修改业务代码。
- 可能修改：`.agents/plugins/marketplace.json`，仅限修正 marketplace metadata 或 plugin entry。

**命令：**

```bash
codex plugin marketplace add /Users/bytedance/Code/browser-hub/browser-viewer
```

读取 marketplace 名称：

```bash
python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py \
  --marketplace-path /Users/bytedance/Code/browser-hub/browser-viewer/.agents/plugins/marketplace.json
```

安装插件：

```bash
codex plugin add toolkit@runweave
```

如果读取出的 marketplace name 不是 `runweave`，使用实际输出替换安装命令中的 marketplace 名称。

**验证：**

```bash
codex plugin list
```

预期：能看到 `toolkit` 来自本仓库 marketplace。完成安装后，需要开启新线程验证新技能是否出现在 Available skills 中；不要用当前线程热加载结果作为唯一判断。

### 任务 4：建立插件维护流程

**目标：**让后续新增技能、更新技能、更新插件版本都有固定流程。

**文件：**

- 修改：`plugins/toolkit/README.md`
- 可选创建：`plugins/toolkit/CHANGELOG.md`

**README 必须说明：**

- 新技能添加到 `plugins/toolkit/skills/<skill-name>/SKILL.md`。
- 更新已有本地插件时，使用 cachebuster helper，而不是手改 marketplace：

```bash
python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  /Users/bytedance/Code/browser-hub/browser-viewer/plugins/toolkit
```

- 读取 marketplace name 后重新安装：

```bash
python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py \
  --marketplace-path /Users/bytedance/Code/browser-hub/browser-viewer/.agents/plugins/marketplace.json

codex plugin add toolkit@runweave
```

- 重新安装后用新线程验证技能加载。
- 不用 symlink 激活技能；磁盘文件存在不代表当前会话已加载。

**验证：**

```bash
python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  /Users/bytedance/Code/browser-hub/browser-viewer/plugins/toolkit
```

预期：更新 README 或 CHANGELOG 不破坏插件校验。

### 任务 5：规划 hooks 扩展入口

**目标：**为后续 hooks 扩展留下可维护设计，但不在第一阶段破坏 plugin validation。

**文件：**

- 可选创建：`plugins/toolkit/hooks/README.md`
- 不修改：`plugins/toolkit/.codex-plugin/plugin.json` 中的 hooks 字段，除非 validator 已支持。

**hooks README 内容边界：**

- 记录期望 hook 类型，例如命令前检查、命令后摘要、Runweave repo 特定 guard。
- 记录每个 hook 的触发时机、输入、输出、失败策略。
- 明确哪些 hook 会读写文件，哪些只是提示或审查。
- 明确涉及浏览器验证的 hook 只能提示使用 `$playwright-cli`，不能自己调用其它浏览器方案。

**未来接入门槛：**

1. 当前 Codex 插件 validator 接受 hook 配置。
2. hook 配置文件存在且路径真实。
3. hook 的失败策略不会阻断普通开发命令，除非用户明确要求强制门禁。
4. hook 行为能被本地命令验证。

**验证：**

```bash
python3 /Users/bytedance/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  /Users/bytedance/Code/browser-hub/browser-viewer/plugins/toolkit
```

预期：即使存在 `hooks/README.md`，manifest 仍通过校验。

## 验收标准

- `plugins/toolkit/.codex-plugin/plugin.json` 存在，`name` 是 `toolkit`。
- `.agents/plugins/marketplace.json` 存在，并包含 `toolkit` 插件 entry。
- `.agents/skills/` 和 `skills/` 下的全部有效技能都已复制到 `plugins/toolkit/skills/`，且每个迁移后的 skill 能通过基础解析。
- `validate_plugin.py plugins/toolkit` 通过。
- `codex plugin add toolkit@<marketplace-name>` 能安装插件。
- 新线程中能看到插件贡献的 skills。
- 第一阶段没有修改 Runweave 业务代码，没有新增非 E2E 测试文件，没有把 hooks 字段写进不支持的 manifest。

## 风险与处理

- **风险：marketplace path 解析和脚本当前行为不一致。**
  - 处理：先用 `create_basic_plugin.py` 生成，再检查 `.agents/plugins/marketplace.json` 中的 `source.path` 是否指向 `plugins/toolkit`。如果不一致，优先按 validator 和 `codex plugin list` 的实际行为修正计划或命令。

- **风险：技能文件存在但当前会话不可见。**
  - 处理：把“安装后新线程验证”写成必需步骤；不要用当前线程判断热加载成功。

- **风险：迁移技能时 YAML frontmatter 解析失败。**
  - 处理：最小修复 frontmatter，例如给含冒号的 description 加引号；不要重写整个 skill。

- **风险：hooks 需求提前进入 manifest 导致插件无法安装。**
  - 处理：第一阶段只保留 hooks 设计文档；等 validator 和 Codex 插件 ingestion 明确支持后再接入。

- **风险：现有 `.agents/skills`、`skills` 和插件内 skills 出现双源漂移。**
  - 处理：第一阶段把两个历史目录中的全部有效技能复制到插件目录，但不删除旧目录；README 明确 canonical source。后续单独做一次收敛计划，决定保留、删除或生成同步脚本。

## 后续路线

1. 第一阶段：完成 `toolkit` 技能包插件，迁移 `.agents/skills/` 和 `skills/` 下的全部有效技能。
2. 第二阶段：把重复技能来源收敛到插件目录，决定是否删除旧目录或增加同步脚本。
3. 第三阶段：在 validator 支持的前提下接入 hooks。
4. 第四阶段：按实际需要接入 scripts、assets、MCP servers 或 App manifest。
5. 第五阶段：把插件安装、更新、验证流程写入 Runweave 项目文档，供新机器迁移复用。
