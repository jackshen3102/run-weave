# Toolkit cache compatibility 评审

## 评审对象

- `plugins/toolkit/.codex-plugin/plugin.json`
- `plugins/toolkit/README.md`
- `scripts/sync-toolkit-plugin.mjs`

本次按代码评审处理，覆盖当前 unstaged live diff。未修改被评审源码、配置或既有文档。

## 结论

未发现 P0/P1/P2 级别问题。新增的 Codex 旧 cachebuster 兼容路径逻辑整体方向成立：同步前收集 manifest、现有 cache、历史 session 与 git 历史中的旧版本；安装新版本后，为旧版本路径建立到当前版本目录的兼容 symlink。当前本机检查也显示 `~/.codex/plugins/cache/runweave/toolkit` 下旧版本路径已指向 `0.1.0+codex.20260624030007`。

## 发现

未发现需要阻断提交的风险。早先发现的 Prettier 格式问题已通过对 `scripts/sync-toolkit-plugin.mjs` 运行 Prettier 修复。

## 验证摘要

- `git diff --check`：通过，无空白错误。
- `node --check scripts/sync-toolkit-plugin.mjs`：通过，无语法错误。
- `pnpm exec eslint scripts/sync-toolkit-plugin.mjs`：通过。
- `pnpm exec prettier --write scripts/sync-toolkit-plugin.mjs plugins/toolkit/README.md plugins/toolkit/.codex-plugin/plugin.json docs/review/2026-06-24-toolkit-cache-compatibility.review.md`：通过。
- `codex plugin list --json`：当前 `toolkit@runweave` 已安装并启用，版本为 `0.1.0+codex.20260624030007`。
- 只读检查 `~/.codex/plugins/cache/runweave/toolkit`：旧版本路径当前为 symlink，目标为 `0.1.0+codex.20260624030007`。
- 只读检查 `~/.codex/sessions`：session 日志中存在旧 cachebuster 绝对路径引用，兼容路径问题是真实场景。

## 残余风险

- 已执行 `pnpm toolkit:sync`，确认新安装版本会为旧 cachebuster 路径创建兼容 symlink；该命令会更新 cachebuster 并改动本机插件缓存。
- 当前逻辑硬编码匹配 `0.1.0+codex.<digits>`。如果后续 Toolkit 插件主版本从 `0.1.0` 改为其他 semver，兼容版本收集规则需要同步调整；这不是当前 diff 的上线阻断项。
