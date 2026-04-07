# 测试层级与命名

## Layer: default

- 负责：纯逻辑、确定性回归、进程内集成
- 非目标：外部依赖漂移

## Layer: e2e

- 负责：跨模块关键路径闭环验证
- 非目标：穷举纯逻辑分支

## Layer: live

- 负责：外部依赖与运行时漂移检查
- 非目标：高频日常回归

## Layer: ui

- 负责：前端非视图逻辑、状态、存储、URL 与协议适配回归
- 非目标：TSX 组件渲染覆盖与后端契约正确性

## 命名规则

- default：`*.test.ts`
- ui：`*.ui.test.ts`
- e2e：`*.e2e.spec.ts`
- live：`*.live.test.ts`

## 过渡规则

- 现有 `*.spec.ts` 保持有效。
- 新增 default 仍使用 `*.test.ts`。
- 仅在需要时使用 `*.ui.test.ts` 与 `*.live.test.ts`。
- 不新增任何 `*.test.tsx` / `*.ui.test.tsx`；前端 `*.tsx` 与 UI 侧 hooks 通过 E2E 或手工回归验证。

## 当前映射

- `frontend/src/**/*.test.ts` → ui
- `frontend/src/**/*.tsx` → 不写单测，依赖 e2e / 手工回归
- `frontend/tests/*.spec.ts` → e2e
- `backend/src/**/*.test.ts` → default（含部分集成）
- `backend/src/**/*.live.test.ts` → live
