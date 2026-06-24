# Runweave Toolkit 插件

这个仓库本地插件是 Runweave Toolkit skills 的唯一规范来源。

Skills 统一维护在：

```text
plugins/toolkit/skills/<skill-name>/SKILL.md
```

不要把符号链接作为激活机制。文件存在于这个仓库磁盘上，并不代表当前 Codex 会话已经加载它们。

## 已包含的 Skills

- `brainstorming`
- `code-grounded-requirements`
- `daily-doc-maintenance`
- `daily-refactor`
- `debugging-strategies`
- `diagnostic-log-debugging`
- `doc-coauthoring`
- `git-advanced-workflows`
- `github-pr`
- `karpathy-guidelines`
- `playwright-cli`
- `react-best-practices`
- `recorded-browser-mcp-verification`
- `review-only`
- `shadcn`
- `sync-branch-hard-reset`
- `using-rw`
- `write-plan`

## 验证

以下命令从仓库根目录执行。

验证插件 manifest 和打包的 skills：

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
uv run --with pyyaml python "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" \
  plugins/toolkit
```

验证每个 skill：

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
for skill_dir in plugins/toolkit/skills/*; do
  [ -d "$skill_dir" ] || continue
  uv run --with pyyaml python "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" "$skill_dir"
done
```

## 本地安装

注册仓库本地 marketplace：

```bash
codex plugin marketplace add .
```

读取 marketplace 名称并安装插件：

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
MARKETPLACE_NAME="$(python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/read_marketplace_name.py" \
  --marketplace-path .agents/plugins/marketplace.json)"
codex plugin add "toolkit@$MARKETPLACE_NAME"
```

重新安装后，在新的 Codex 线程中验证 skill 加载。不要依赖当前线程热加载插件 skills。

## 更新流程

开发过程中更新这个本地插件时，使用 cachebuster helper，不要手动编辑 marketplace 元数据：

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" \
  plugins/toolkit
```

然后读取 marketplace 名称并重新安装插件：

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
MARKETPLACE_NAME="$(python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/read_marketplace_name.py" \
  --marketplace-path .agents/plugins/marketplace.json)"
codex plugin add "toolkit@$MARKETPLACE_NAME"
```

Hooks 运行时代码放在 `plugins/toolkit/hooks/`。

- Codex hook 配置由 `plugins/toolkit/.codex-plugin/plugin.json` 的 `hooks` 字段显式指向
  `plugins/toolkit/hooks.json`，随 `toolkit@runweave` 和 `toolkit@local` 安装进入插件缓存。
- 不要只在插件根目录放置 `hooks.json` 而不更新 manifest；新启动的 Codex 进程不会因为
  该文件存在就自动执行 hook。
- Electron 安装器会从同步后的 `electron/resources/hooks/` 运行副本安装 launcher 与
  兼容/清理层，旧的 Codex 全局 hooks 与 Trae 全局 TOML hook 会被去重清理。

## 自动更新

提交时如果 staged diff 包含 `plugins/toolkit` 或 `.agents/plugins/marketplace.json`，pre-commit 会先执行：

```bash
pnpm toolkit:sync:staged
```

该命令会同步 toolkit hook 资产到 Electron resources、验证插件和 skills，更新
cachebuster，重新安装 Codex 的 `toolkit@runweave` 与 Trae CLI 的 `toolkit@local`，
并把 cachebuster、插件 `hooks.json` 与 hook 运行副本写回本次提交。需要跳过本机插件安装时，可设置：

Codex 线程启动后会保存已加载 skill 的缓存绝对路径。`pnpm toolkit:sync` 会在重新安装
Codex 插件后，为最近的旧 cachebuster 版本保留兼容缓存路径并指向最新安装目录，避免已经
打开的线程继续调用旧 skill 时遇到 `SKILL.md` 路径不存在。新线程仍会加载最新版本。

```bash
RUNWEAVE_SKIP_TOOLKIT_PLUGIN_SYNC=1 git commit
```

也可以手动执行完整同步：

```bash
pnpm toolkit:sync
```

Hook 链路的真实验证命令：

```bash
pnpm toolkit:verify-hooks
```
