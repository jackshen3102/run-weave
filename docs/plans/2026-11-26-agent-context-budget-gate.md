# Agent 启动上下文与 MCP 工具字节预算门禁实施计划

每次在仓库启动编码 Agent 会话时，宿主都会隐式加载根 `AGENTS.md`、Toolkit 技能目录的 `name/description` 元数据以及已挂载 MCP 的 `instructions/tools` Schema；本计划通过确定性字节预算文件与本地/CI 门禁锁死上述常驻文本上限，一旦任意 PR 造成无感膨胀即刻阻断并打印超标明细。设计背景见 `docs/prototypes/t3code-borrowings-plan/index.html#mech-6`。

## 1. 目标与非目标

### 目标

- 精确测量并锁死四类会话冷启动常驻上下文的 UTF-8 字节上限：
  1. 根 `AGENTS.md` 总字节数，以及全仓所有就近 `**/AGENTS.md` 的单文件字节上限；
  2. `plugins/toolkit/skills/*/SKILL.md` 的 YAML Frontmatter（`name` + `description`）总字节数与单技能 `description` 字节上限；
  3. `packages/runweave-mcp` 实例化后导出的服务端 `instructions` 与 `tools/list` JSON 序列化总字节数；
  4. `plugins/toolkit/hooks/` 与 `electron/resources/hooks/` 注入给 Agent 的固定提示模板字节数（若存在）。
- 提供秒级零网络命令 `pnpm context:budget`（只读校验）与 `pnpm context:budget --update`（显式刷新基线），并接入 `scripts/quality/gate.mjs` 与 GitHub Actions CI。
- 在 CI PR 检查中同时对比 `HEAD^1:scripts/quality/context-budget.json`，防止执行者在业务 PR 中顺手调高预算数字绕过门禁。

### 非目标（不做什么）

- 不限制业务源码、`docs/architecture/`、`docs/plans/`、`docs/testing/` 或技能正文（`SKILL.md` 除 Frontmatter 外的按需读取部分）的正常编写。
- 不调用外部模型或分词器 API；统一使用确定性的 UTF-8 字节数（`Buffer.byteLength(text, "utf8")`）与规范化 JSON 序列化长度作为跨平台一致口径。
- 不替代 `pnpm token:report` 与 `pnpm skill:report` 的历史日志事后统计职责。

## 2. 用户可见行为与业务规则

1. **日常开发校验（`pnpm context:budget`）**：
   - 读取工作区真实文件与 `packages/runweave-mcp` 工具注册表，计算各项当前字节数并与 `scripts/quality/context-budget.json` 中的 `ceilings` 对比。
   - 当所有指标 `<= ceiling` 时退出码为 `0`，输出简短摘要（当前值 / 上限 / 剩余裕量）。
   - 当任一指标 `> ceiling` 时退出码为 `1`，逐条列出超标指标名、基线上限、当前字节数、增量（`+N bytes`）以及体积最大的前 5 个贡献项（例如最长的 5 个 Skill `description` 或最大的 MCP Tool Schema）。
2. **基线收紧与显式扩容（`pnpm context:budget --update`）**：
   - 当精简了提示词或技能描述使字节数显著下降时，维护者可运行 `--update` 收紧 `context-budget.json`。
   - 当确需新增技能或 MCP 工具导致上限上调时，执行者运行 `--update` 提交变更，但 CI 会检测到 `context-budget.json` 相比 `HEAD^1` 存在数值上调：未附带维护者显式批准标签（`context-budget-increase`）或环境变量豁免时，CI 仍以退出码 `1` 拦截并提示人工确认。
3. **统一质量门禁联动（`pnpm quality:gate`）**：
   - 当变更列表触及 `AGENTS.md`、`**/AGENTS.md`、`plugins/toolkit/**`、`packages/runweave-mcp/**`、`scripts/quality/context-budget.*` 或 `package.json` 时，`pnpm quality:gate` 自动将 `context-budget` 纳入必跑步骤。

## 3. 数据结构与接口合约

### 3.1 预算配置文件 `scripts/quality/context-budget.json`

以 2026-11-26 仓库实测值（根 `AGENTS.md` `4823` B、50 个技能 Frontmatter 共 `17621` B）为初始基线，预留极小合理编辑缓冲（或直接锁死当前实测值）：

```json
{
  "schemaVersion": 1,
  "ceilings": {
    "rootAgentsMdBytes": 5000,
    "maxScopedAgentsMdBytes": 6000,
    "toolkitSkillFrontmatterTotalBytes": 18000,
    "maxSingleSkillDescriptionBytes": 420,
    "runweaveMcpInstructionsBytes": 1200,
    "runweaveMcpToolsJsonBytes": 18000
  }
}
```

> 实现落盘时由 `node ./scripts/quality/context-budget.mjs --update` 采集仓库当时的真实精确字节数（对总量指标采用 `实测值` 零冗余锁死，对单文件/单技能峰值指标采用当前最大值锁死），禁止手工拍脑袋填写虚假数字。

### 3.2 CLI 参数与 JSON 输出合约

- 命令入口：`node ./scripts/quality/context-budget.mjs [--json] [--update] [--compare-git-ref <ref>]`
- `--json` 输出结构：
  ```ts
  interface ContextBudgetReport {
    schemaVersion: 1;
    ok: boolean;
    metrics: Record<
      string,
      {
        actual: number;
        ceiling: number;
        delta: number;
        exceeded: boolean;
      }
    >;
    topContributors: {
      scopedAgentsMd: Array<{ path: string; bytes: number }>;
      skillsFrontmatter: Array<{
        skill: string;
        bytes: number;
        descriptionBytes: number;
      }>;
      mcpTools: Array<{ name: string; bytes: number }>;
    };
    ceilingIncreasesAgainstBaseRef: Array<{
      metric: string;
      baseCeiling: number;
      nextCeiling: number;
    }>;
  }
  ```

### 3.3 `runweave-mcp` Schema 测量边界

- 在不发起网络连接、不扫描真实用户日志目录的前提下，使用空内存 stub 构造 `createMcp(stubContext)`（复用 `packages/runweave-mcp/src/tools.ts`），通过内存 `InMemoryTransport` 或直接读取注册工具的 JSON Schema 导出标准 `tools/list` 响应，按键名稳定排序后计算 `JSON.stringify` UTF-8 字节数。
- 严禁在测量脚本中正则抠取 `tools.ts` 源码字符串代替真实 MCP Schema，避免 Zod 复用对象展开后体积翻倍却漏检。

## 4. 修改与新增文件清单

| 文件路径                                | 操作             | 职责说明                                                                                                                                                                            |
| :-------------------------------------- | :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runweave-mcp/src/tools.ts`    | 修改（按需小改） | 保持现有业务行为不变；如必要导出只读 `inspectMcpSurfaceForBudget()` 供预算脚本无副作用提取 `instructions` 与 `tools/list` Schema                                                    |
| `scripts/quality/context-budget.mjs`    | 新建             | 扫描 `git ls-files '**/AGENTS.md' 'AGENTS.md'`、`plugins/toolkit/skills/*/SKILL.md` Frontmatter 与 `runweave-mcp` 导出 Schema，执行上限比对、`--update` 与 `--compare-git-ref` 检查 |
| `scripts/quality/context-budget.json`   | 新建             | 提交受控的精确字节预算基线文件                                                                                                                                                      |
| `scripts/quality/gate.mjs`              | 修改             | 在 `ALL_STEPS` 与变更路径路由中接入 `context-budget` 检查步骤                                                                                                                       |
| `package.json`                          | 修改             | 新增 `"context:budget": "node ./scripts/quality/context-budget.mjs"` 脚本                                                                                                           |
| `.github/workflows/` 对应 PR 检查工作流 | 修改             | 增加 `Context Budget` 检查步骤，对比 `HEAD^1:scripts/quality/context-budget.json`，仅在 PR 含 `context-budget-increase` 标签时放行基线上调                                          |
| `.agents/rules/documentation.md`        | 修改             | 补充一行说明：新增或扩写根 `AGENTS.md`、Toolkit Skill 描述或 `runweave-mcp` 工具时须通过 `pnpm context:budget`                                                                      |

## 5. 高风险点与安全/兼容回滚

- **换行符跨平台差异（CRLF vs LF）**：Windows 工作区若启用 `autocrlf` 会导致字节数比 macOS/Linux 多出 `\r` 数量。测量脚本读取 Markdown 与 Frontmatter 时统一先将 `\r\n` 归一化为 `\n` 再计算 UTF-8 字节数，保证 macOS、Linux CI 与 Windows 本地结果逐字节一致。
- **构建产物依赖顺序**：若 `context-budget.mjs` 读取 `@runweave/mcp` 的编译产物，在未执行 `build` 的全新 worktree 中会因缺 `dist/` 报错。应通过 `pnpm --dir packages/runweave-mcp exec tsx` 加载源码入口直接导出 Schema，不依赖预构建产物。
- **回滚策略**：纯工程检查脚本与 CI 步骤，不影响任何运行时服务；如需回滚，移除 `gate.mjs` 与 workflow 引用即可立即恢复。

## 6. 验收标准与验证方式

本计划为确定性命令行与 CI 门禁，直接通过以下命令与合成越界实验验收，无需新增浏览器/移动端 `.testplan.yaml`：

- [ ] **基线通过验证**：运行 `pnpm context:budget --json`，确认退出码为 `0`，`ok: true`，且输出的 `rootAgentsMdBytes`、`toolkitSkillFrontmatterTotalBytes`、`runweaveMcpToolsJsonBytes` 均为正整数且与手工统计一致。
- [ ] **越界阻断验证**：在本地临时向 `AGENTS.md` 或某个 `SKILL.md` 的 `description` 追加超限字符后运行 `pnpm context:budget`，确认退出码为 `1` 并准确打印超标文件名与 `+N bytes`；还原文件后再次运行恢复退出码 `0`。
- [ ] **防基线暗改验证**：临时调大 `scripts/quality/context-budget.json` 中任一数值，运行 `node ./scripts/quality/context-budget.mjs --compare-git-ref HEAD`，确认识别到 `ceilingIncreasesAgainstBaseRef` 非空并以退出码 `1` 拦截；还原 `context-budget.json`。
- [ ] **仓库全量门禁验证**：运行 `pnpm docs:check`、`pnpm architecture:check`、`pnpm quality:gate --changed=AGENTS.md,plugins/toolkit/skills/suiji/SKILL.md` 及 `pnpm lint`，全部退出码为 `0`。
