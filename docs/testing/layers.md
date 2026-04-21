# 测试层级与命名

## Layer: default

- 负责：后端与共享包的纯逻辑、确定性回归、进程内集成
- 非目标：外部依赖漂移

## Layer: e2e

- 负责：前端与跨模块关键路径闭环验证
- 非目标：后端/共享纯逻辑分支穷举

## Layer: live

- 负责：外部依赖与运行时漂移检查
- 非目标：高频日常回归

## 命名规则

- default：`backend/src/**/*.test.ts`、`packages/shared/src/**/*.test.ts`
- e2e：`frontend/tests/*.spec.ts`
- live：`backend/src/**/*.live.test.ts`

## 过渡规则

- 现有 `*.spec.ts` 保持有效。
- 后端与共享包新增 default 仍使用 `*.test.ts`。
- 仅在需要时新增 `*.live.test.ts`。
- 前端项目不新增任何 `*.test.ts`、`*.test.tsx`、`*.ui.test.ts`、`*.ui.test.tsx`；前端 `src/**/*.{ts,tsx}` 与 UI 侧 hooks 通过 E2E 或手工回归验证。

## 当前映射

- `frontend/src/**/*.{ts,tsx}` → 不新增单测，依赖 e2e / 手工回归
- `frontend/tests/*.spec.ts` → e2e
- `backend/src/**/*.test.ts` → default（含部分集成）
- `backend/src/**/*.live.test.ts` → live
- `packages/shared/src/**/*.test.ts` → default
