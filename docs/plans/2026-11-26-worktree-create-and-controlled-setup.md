# 一键新建 Worktree 终端与受控 `setup` 实施计划

用户在桌面端 Worktree Rail 或原生 iOS 首页「＋」中可直接输入名称/分支一键创建 `.worktree/<name>` 子项目并打开新终端；若仓库 `runweave.json` 声明了 `worktree.setup` 且当前 SHA-256 版本已获用户明确勾选批准，系统将在新建 tmux 首面板中可见运行初始化脚本，并在退出码为 `0` 后自动拉起所选编码 Agent。产品交互见 [可视化方案](../prototypes/t3code-borrowings-plan/index.html#mech-3)。

## 1. 目标与非目标

### 目标

- 将 `RaceWorktreeSupply` 中已验证的 `.worktree/` 路径边界与 Git 分支创建能力抽离为公共 `WorktreeProvisioner`，并与 `TerminalWorktreeDeletionService` 共用父项目级并发互斥锁。
- 新增受认证接口 `GET /api/terminal/project/:parentProjectId/worktree-create-preview` 与 `POST /api/terminal/project/:parentProjectId/contexts`，支持桌面端与原生 iOS 一键创建直接子 Worktree 并原子打开首个终端会话。
- 在 `runweave.json`（保持 `schemaVersion: 1` 兼容）新增可选字段 `worktree.setup: { command: string, cwd?: string }`：
  - 基于规范化 `(repositoryId, setupCommand, setupCwd)` 计算 SHA-256 `setupRevision`，在 Backend profile 持久化用户的显式信任记录；
  - 新建 tmux 终端首面板可见执行已批准的 `setup` 命令，通过单次随机完成哨兵捕获真实退出码：`exitCode === 0` 时按用户选择自动启动目标 CLI（`codex / claude / pi / traex / agy` 或仅停留 Shell）；`exitCode !== 0` 时停留在终端面板保留完整错误输出，**绝不带病盲跑 Agent**。

### 非目标（不做什么）

- **绝不未经批准自动跑脚本**：克隆未知仓库、远端更新修改了 `runweave.json` 的 `setup` 命令、或请求未携带匹配的 `approvedSetupRevision` 时，严禁执行 `setup` 脚本。
- 不支持在父项目 `.worktree/` 之外的任意路径创建 Worktree，不执行自定义 shell `worktreeLayout` 创建脚本，也不支持 `runOnSettle` 自动删文件钩子。
- 不改变现有 `effectiveProjectId = childProjectId ?? parentProjectId` 唯一身份合同（[terminal-worktree-context.md](../architecture/terminal-worktree-context.md)）。

## 2. 用户可见行为与业务规则

1. **新建预览（打开新建弹窗时）**：
   - 桌面端点击 Worktree Rail 末尾的 `＋ 新建 Worktree`，或原生 iOS 在首页点击项目 `＋` → `新建 Worktree…`，调用 `GET /worktree-create-preview`。
   - 返回默认基准分支（继承父项目 `mainBranch` 或远端默认分支，回退当前 `HEAD`）、当前已有子目录/分支冲突校验辅助信息，以及目标基准或主目录中 `runweave.json` 的 `worktree.setup` 详情与 `approved: boolean`。
2. **目录、分支与命名约束**：
   - `name`（`.worktree/<name>` 目录名）：NFC 归一化后匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`，禁止 `.`、`..`、路径分隔符与以 `-` 开头（防止 Git 将目录名解析为命令行选项）。
   - `branch`：可选；传入时经 `git check-ref-format --branch` 校验并执行 `git worktree add -b <branch> -- <worktreePath> <baseCommit>`（若同名本地分支已存在且未被其他 worktree 检出，允许显式选择 `checkoutExistingBranch: true`；已被检出或冲突时返回 `409` 明确说明）。
   - 创建前 `realpath` 校验 `<parent.path>/.worktree` 不是逃逸父目录的符号链接。
3. **受控 `setup` 与 Agent 串联执行**：
   - Worktree 检出成功后，**必须重新从新建的 `.worktree/<name>/runweave.json`（使用 `O_NOFOLLOW`）读取实际落盘的 `worktree.setup`** 并重算 `actualSetupRevision`：
     - 若用户提交了 `runSetup: true`，则要求 `approvedSetupRevision === actualSetupRevision`（若基准分支里的 `runweave.json` 与主目录版本不同导致不匹配，拒绝自动执行 `setup`，返回新预览或在终端提示需确认该分支的 `setup` 版本）。
     - 验证通过后，将该 `(repositoryId, actualSetupRevision)` 记入本机已批准存储，同版本下次新建默认勾选无需重复警告。
   - 在新建的 tmux 首面板执行受控包装命令：打印 `[Runweave Setup] Running: <command>`，执行完毕输出随机哨兵 `__RUNWEAVE_SETUP_DONE_<uuid>:<exitCode>`；Backend 观察到哨兵退出码为 `0` 且面板未被用户中断或关闭时，调用既有 `prepareTerminalAgent` 在同一面板启动所选 Agent；退出码非 `0` 或超时未见哨兵则保持纯 Shell 现场供排障。
   - 在无 tmux 的纯 PTY 环境（如 Windows）：同样支持创建 Worktree 与在 PTY 首会话执行受批准 `setup`。

## 3. API 合约与配置结构

### 3.1 `runweave.json` 兼容扩展（`backend/src/terminal/workspace-service/config.ts`）

```ts
// schemaVersion 仍为 1，services 字段改为 optional（默认 {}），允许仅配置 worktree.setup 的仓库使用
const worktreeSetupSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096),
    cwd: z.string().trim().min(1).max(512).optional(), // 相对新 Worktree 根，禁止绝对路径与越界 symlink
  })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    services: z.record(serviceSchema).optional().default({}),
    worktree: z
      .object({
        setup: worktreeSetupSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
```

### 3.2 HTTP 路由（位于 `/api/terminal/project/:parentProjectId/`）

1. **`GET /worktree-create-preview`**
   - 响应：
     ```ts
     interface WorktreeCreatePreviewResponse {
       parentProjectId: string;
       defaultBaseRef: string; // 如 "origin/main" 或 "HEAD"
       currentBranch: string | null;
       setup: {
         command: string;
         cwd: string;
         revision: string; // SHA-256(JSON.stringify([repositoryId, cwd, command]))
         approved: boolean;
       } | null;
     }
     ```
2. **`POST /contexts`**
   - 请求体：
     ```ts
     interface CreateWorktreeContextRequest {
       operationId: string; // UUID，1 小时幂等去重
       name: string; // .worktree/<name>
       branch: string;
       baseRef: string;
       checkoutExistingBranch?: boolean;
       runSetup?: boolean;
       approvedSetupRevision?: string;
       launchAgent?: "none" | "codex" | "claude" | "pi" | "traex" | "agy";
     }
     ```
   - 响应（`201 Created`）：
     ```ts
     interface CreateWorktreeContextResponse {
       context: TerminalProjectContextListItem; // projectId = wt:<base64url>:<base64url>
       terminalSessionId: string;
       setupStatus: "skipped" | "running" | "revision_mismatch_skipped";
     }
     ```

## 4. 修改与新增文件清单

| 文件路径                                                                              | 操作      | 职责说明                                                                                                                                                |
| :------------------------------------------------------------------------------------ | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/terminal/project-context.ts` 与 `workspace-service.ts`           | 修改      | 新增 `WorktreeCreatePreviewResponse`、`CreateWorktreeContextRequest/Response` 与 `worktree.setup` 共享类型                                              |
| `backend/src/terminal/workspace-service/config.ts`                                    | 修改      | 兼容解析 `worktree.setup`（允许无 `services` 仅含 `worktree` 的 `runweave.json`），保持既有 `services` 严格校验                                         |
| `backend/src/terminal/workspace-service/setup-approvals.ts`                           | 新建      | 在 Backend profile 下以 `0600` 原子读写 `(repositoryId, setupRevision)` 信任记录                                                                        |
| `backend/src/terminal/workspace-service/worktree-provisioner.ts`                      | 新建      | 抽离公共 `.worktree/<name>` 路径安全校验、Git 创建、与 `worktree-deletion.ts` 共享的父项目互斥锁、以及新建 tmux/PTY 首面板 `setup → Agent` 哨兵串联执行 |
| `backend/src/race/race-worktree-supply.ts` 与 `worktree-deletion.ts`                  | 修改      | 接入公共父项目 Worktree 并发互斥屏障，顺带消除架构文档已记录的创建与删除并发竞态                                                                        |
| `backend/src/routes/terminal/projects/context.ts`                                     | 修改      | 注册 `GET /worktree-create-preview` 与 `POST /contexts` 路由                                                                                            |
| `frontend/src/components/terminal/workspace/worktree-rail.tsx` 及新建弹窗组件         | 修改/新建 | 在桌面 Rail 提供 `＋ 新建 Worktree` 弹窗、分支/Agent 选择与 `setup` 命令全文确认框，成功后切入新 Context 与新终端                                       |
| `packages/app-ios/Sources/RunweaveIOS/Features/Home/NewTerminalView.swift` 及新建子页 | 修改/新建 | 在手机「新建终端」工作目录列表提供「新建 Worktree」，支持查看并勾选批准 `setup` 后创建并进入新终端                                                      |
| `docs/architecture/terminal-worktree-context.md` 与 `terminal-workspace-services.md`  | 修改      | 同步更新新建接口、`runweave.json` `worktree.setup` 信任合同与并发锁边界                                                                                 |
| `docs/testing/terminal/workspace/provision-and-setup.testplan.yaml`                   | 新建      | 覆盖合法创建、路径逃逸拦截、`setup` 修订信任门禁、`exitCode!=0` 阻断 Agent 启动及双端入口验收                                                           |

## 5. 高风险点与安全/兼容回滚

- **跨分支 `runweave.json` 偷梁换柱（TOCTOU）风险**：主目录的 `runweave.json` 可能是干净的 `pnpm install`，但用户选择的 `baseRef` 分支里的 `runweave.json` 可能包含不同命令。必须在 `git worktree add` 检出目标树之后，对**新 Worktree 目录内实际文件**用 `O_NOFOLLOW` 重新计算 `actualSetupRevision`，与请求携带的 `approvedSetupRevision` 严格相等才允许执行。
- **哨兵伪造与中途人工接管**：完成哨兵使用每次生成的 `128-bit` 随机 hex token，防止构建输出意外碰撞；等待 `setup` 期间若用户关闭了面板、按了 `Ctrl+C`（退出码 130）或主动输入了其他命令，自动取消后续 `launchAgent` 启动，绝不抢夺用户终端。
- **中途失败清理**：若 `git worktree add` 失败，不残留半成品空目录；若 Worktree 已建好但终端创建失败，返回明确错误并在刷新后由 `WorktreeProjectRegistry` 正常展示该已建好的 Worktree 供重试打开终端，不静默强删已检出的 Git 分支。

## 6. 验收标准与验证方式

配套新增测试计划：[docs/testing/terminal/workspace/provision-and-setup.testplan.yaml](../testing/terminal/workspace/provision-and-setup.testplan.yaml)，并回归既有 [project-context.testplan.yaml](../testing/terminal/workspace/project-context.testplan.yaml)、[deletion.testplan.yaml](../testing/terminal/workspace/deletion.testplan.yaml) 与 `pnpm workspace-services:verify`。

- [ ] `pnpm testplan:validate docs/testing/terminal/workspace/provision-and-setup.testplan.yaml`、`pnpm workspace-services:verify` 与 `pnpm docs:check` 通过。
- [ ] `pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`、`pnpm --filter @runweave/frontend typecheck`、`pnpm lint`、`pnpm architecture:check` 与 `pnpm ios:build` 全部通过。
- [ ] 在桌面 Dev Session 与 iOS 模拟器完成 `WTPROV-001` 至 `WTPROV-007` 取证：验证一键创建切换、路径逃逸/参数注入 `400/403` 拒绝、未批准或修改后的 `setup` 绝不自动执行、`setup` 成功（`exit 0`）自动拉起 Agent、`setup` 失败（`exit 1`）保留报错现场不拉起 Agent。
