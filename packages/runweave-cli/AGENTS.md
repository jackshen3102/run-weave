# Runweave CLI

`packages/runweave-cli` 产出 `rw` 命令，是 Backend / App Server 控制面的参数化客户端。

## 先看哪里

- 命令分发与 usage：`src/index.ts`
- 参数解析公共逻辑：`src/args.ts`
- 错误与退出码：`src/errors.ts`
- 命令组：`src/commands/`
- 打包：`scripts/bundle.mjs`
- 用户文档：`../../docs/cli/README.md`

## 边界

- CLI 负责参数校验、请求、输出格式与退出码，不复制 Backend 领域状态机。
- 机器消费路径提供稳定的 JSON 输出；诊断信息写 stderr，不污染 stdout。
- 跨运行时 DTO 复用 `@runweave/shared`，不要在命令文件中手写近似协议。
- CLI 新增或修改命令时，同一改动内更新 `docs/cli/` 的当前合同。
- 不新增单元测试；使用现有 verify 脚本、build 和目标命令的真实输出验证。

## 验证

```bash
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm cli:build
```
