# AGENTS

Runweave 编码智能体的仓库入口。根文件只保留全仓路由与硬约束；目标目录下更近的
`AGENTS.md` 在其作用域内优先。

## 开始前

- [ ] 先读本文件，再读目标目录最近的 `AGENTS.md`。
- [ ] 不确定代码归属或跨运行时链路时，读 `docs/architecture/README.md`。
- [ ] 从 `docs/README.md` 按需进入 CLI、部署、质量和测试文档。
- [ ] 保留工作区已有改动；只修改本次需求需要的行，不顺手重构或清理。

完整就近规则清单：

```bash
git ls-files '**/AGENTS.md' 'AGENTS.md'
```

## 全仓约束

- 不写单元测试或 TDD，不新增单元测试文件。当前自动化与替代验证见
  `docs/testing/layers.md`。
- 新增或重写测试计划只能使用 `docs/testing/**/*.testplan.yaml`；遵循
  `docs/testing/test-plan-format.md`，落盘后运行 `pnpm testplan:validate <path>`。
- 承诺浏览器或 UI 验收时必须实际执行 `$toolkit:playwright-cli`；未执行则明确记录阻塞，
  不得用静态检查、代码阅读或普通截图冒充。
- Web/App 稳定函数引用优先使用 `ahooks` 的 `useMemoizedFn`；引入 `useCallback` 前说明原因。
- 跨运行时协议、DTO 和纯 TS 合同进入 `packages/shared`；只有 Web 与 App 当前真实复用的
  前端实现才进入 `packages/common`。细则见对应包的 `AGENTS.md`。
- Electron 默认只打包当前 mac 客户端；除非用户明确要求，不生成 Windows 安装包。

## 操作路由

- 浏览器页面复现、修改或验收：使用 `$toolkit:playwright-cli`，按其规则附着正确页面。
- 实际执行 `pnpm dev:session`、`dev:status`、`dev:open` 或 `dev:stop`：必须使用
  `$toolkit:runweave-dev-session`；生命周期细则见 `scripts/dev-session/AGENTS.md`。
- `$toolkit:runweave-change-validation` 只在用户当前请求显式点名时触发；否则执行与改动范围
  相称的验证，不默认启动完整 Dev Session。
- App、Electron、Backend、Frontend、App Server、CLI 和共享包的专属边界与验证命令，
  以各自就近 `AGENTS.md` 为准。

## 常用命令

```bash
pnpm dev
pnpm dev:electron
pnpm typecheck
pnpm lint
pnpm docs:check
pnpm dist:electron:mac
```

## 文档入口

- 代码地图：`docs/architecture/README.md`
- 文档总览：`docs/README.md`
- 测试与验收：`docs/testing/README.md`
- 文档治理：`.agents/rules/documentation.md`
