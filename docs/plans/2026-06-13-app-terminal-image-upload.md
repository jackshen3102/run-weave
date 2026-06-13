# App 终端输入框图片上传计划

## 目标

让 App 终端详情页底部输入框支持选择图片：用户点图片按钮并选中图片后，App 复用现有 Web/后端上传接口把图片保存到后端临时目录，然后把返回的图片文件路径以 shell-quoted 文本插入到底部命令输入框中。用户可以继续编辑或点击发送。

这里的“输入框”定义为 App 的 `TerminalCommandComposer` 文本输入区，不是在 xterm 渲染区内展示图片，也不是 Web 端的 pasted image chip 预览。

## 当前代码依据

- App 输入框组件：`app/src/components/TerminalCommandComposer.tsx`
  - 已有隐藏 `<input type="file" accept="image/*">` 和图片按钮。
  - 当前 `onPickImage(file)` 是 fire-and-forget 回调，组件内部不能拿到上传后的文本并插入 `value`。
- App 终端页：`app/src/pages/AppTerminalPage.tsx`
  - 已引入 `fileToBase64`、`shellQuote`、`createTerminalSessionClipboardImage`。
  - 当前图片处理链路上传成功后调用 `sendInput(shellQuote(payload.filePath))`，这会直接写入终端输入流，不会出现在底部输入框里。
- App 服务接口：`app/src/services/terminal.ts`
  - 已有 `createTerminalSessionClipboardImage(apiBase, accessToken, terminalSessionId, payload)`。
- Web 参考实现：`frontend/src/components/terminal/use-terminal-emulator.ts`
  - 粘贴图片后调用同一个 `/clipboard-image` 接口，返回 `filePath` 后发送 `shellQuote(filePath)`。
- 后端接口：`backend/src/routes/terminal-clipboard-image-routes.ts`
  - `POST /api/terminal/session/:id/clipboard-image`
  - 请求体：`{ mimeType, dataBase64 }`
  - 响应：`{ fileName, filePath }`
  - 支持 `image/png`、`image/jpeg`、`image/webp`、`image/gif`，解码后最大 100 MiB。

## 非目标

- 不做图片预览，不新增缩略图、chip、上传列表或删除附件能力。
- 不改 Web 端粘贴图片行为。
- 不改后端图片存储位置、命名规则或大小限制，除非验证发现 App 无法复用现有接口。
- 不新增前端 Vitest 单测；前端验证以类型检查、构建和 Playwright E2E/手工回归为主。
- 不实现多图批量选择；本次仍按单张图片处理。

## 实施步骤

### 1. 调整 App composer 的图片选择契约

修改 `app/src/components/TerminalCommandComposer.tsx`：

- 将 `onPickImage` 类型从 `(file: File) => void` 改成 `(file: File) => Promise<string>`。
- `handleImageChange` 选中文件后：
  - 清空原生 file input 的值，保证重复选择同一张图片也会触发 change。
  - `await onPickImage(file)` 获取要插入输入框的文本。
  - 把返回文本追加到当前 `value` 中。
- 追加规则：
  - 当前输入为空：直接插入 `quotedPath`。
  - 当前输入不为空且末尾不是空白：先补一个空格再插入。
  - 当前输入末尾已有空白：直接插入。
- 上传失败时不清空已有输入，不插入任何内容。
- 图片按钮在 `disabled || isPickingImage` 时保持不可点。

验收点：

- 选择图片后，输入框文本出现类似 `'/tmp/browser-viewer-terminal-images/browser-viewer-terminal-image-YYYYMMDD-HHMMSS-xxxxxx.png'`。
- 已输入 `codex analyze` 再选图后，输入框变成 `codex analyze '/tmp/...png'`。
- 上传失败后，已有输入保留。

### 2. 调整 App 终端页的上传逻辑

修改 `app/src/pages/AppTerminalPage.tsx`：

- 保留 `fileToBase64(file)`。
- 保留调用 `createTerminalSessionClipboardImage(apiBase, accessToken, terminalSessionId, { mimeType: file.type, dataBase64 })`。
- 上传成功后返回 `shellQuote(payload.filePath)` 给 composer。
- 删除当前上传成功后直接 `sendInput(shellQuote(payload.filePath))` 的行为。
- 401 继续调用 `onAuthExpired()`。
- 其他错误继续写入 `imageError`，文案保持用户可理解，例如“图片上传失败”或后端返回的错误。
- `recordSupportLog` 继续记录 started/completed/failed/unauthorized，completed 可保留 `filePathLength`，不要记录完整本地路径。

验收点：

- 选择图片只更新底部输入框，不会立即把内容写进终端。
- 用户点击发送后，走现有 `handleSendCommand` 和 `/input` 逻辑。
- 支持日志中不泄露完整图片路径。

### 3. 保持接口复用并只做必要补齐

默认不改 `backend/src/routes/terminal-clipboard-image-routes.ts`、`backend/src/terminal/clipboard-image.ts`、`packages/shared/src/terminal-protocol.ts`。

只有验证发现 App 上传失败时才补齐：

- 如果 App `File.type` 为空，前端先拒绝并提示“请选择 PNG、JPEG、WebP 或 GIF 图片”，不要把空 mimeType 发给后端。
- 如果 App 端能拿到 MIME 但不是后端允许集合，前端直接提示“不支持的图片格式”。
- 不扩大后端允许类型。

验收点：

- App 与 Web 使用同一个 `POST /api/terminal/session/:id/clipboard-image`。
- 后端现有 100 MiB 限制和 413 行为保持不变。

### 4. UI 与交互约束

修改范围限定在 App 终端输入区：

- 不新增预览区域。
- 不改变 `Chat / Changes / Files` tab 布局。
- 不改变终端 renderer 行为。
- 如果需要触碰图片按钮或发送按钮结构，按项目约束使用原生 `<button type="button">` 加现有 CSS class，不新增 Ionic button 依赖；如果只是改回调逻辑，可以先不做按钮结构重构。
- `isPickingImage` 期间保持图片按钮 disabled，避免重复上传。

验收点：

- iPhone 宽度下输入框、图片按钮、发送/停止按钮不重叠。
- 上传期间按钮不可重复点击。
- 没有预览 chip 或缩略图出现在输入框上方。

## 验证计划

### 静态验证

运行：

```bash
pnpm --filter @runweave/app typecheck
```

预期：

- 命令退出码为 0。
- `TerminalCommandComposer` 的 `onPickImage` Promise 类型与 `AppTerminalPage` 调用方一致。

运行：

```bash
pnpm --filter @runweave/app build
```

预期：

- 命令退出码为 0。
- 如仅出现 Vite chunk size warning，不视为本次失败。

### 后端接口回归

如本次没有改后端，只运行现有相关用例即可：

```bash
pnpm --filter @runweave/backend test -- terminal.test.ts
```

预期：

- `stores uploaded clipboard images in the system temp directory` 通过。
- `rejects clipboard images larger than 100 MiB after base64 decoding` 通过。

### App 浏览器验证

涉及浏览器操作时必须使用 `$playwright-cli`。

步骤：

1. 启动 App 本地开发环境：

```bash
pnpm app:dev
```

2. 用 `$playwright-cli` 打开 App 终端详情页。
3. 选择一张 PNG 图片。
4. 确认底部输入框出现 shell-quoted 临时图片路径。
5. 确认终端渲染区没有因为选择图片立即出现输入或执行结果。
6. 点击发送。
7. 确认终端收到该路径文本并进入现有发送流程。

失败判断：

- 选择图片后直接写入终端但输入框为空，失败。
- 出现预览 chip 或缩略图，失败。
- 上传失败后清空用户已有输入，失败。
- 浏览器验证不是通过 `$playwright-cli` 完成，失败。

## 风险与回滚

- 最大行为变化：当前 App 可能已经会在选图后直接 `sendInput(shellQuote(filePath))`；本计划会改为先插入底部输入框，用户点击发送后才进入终端。
- 如果用户实际想要“选图后立即写入 xterm 输入流”，只需要回滚步骤 1 和步骤 2 的契约调整，保留当前直接 `sendInput` 行为。
- 后端临时文件仍在系统 temp 目录，沿用现有清理和安全边界；本计划不引入新的持久化数据。

## 执行清单

- [ ] 修改 `TerminalCommandComposer` 的 `onPickImage` Promise 契约和 append-to-value 逻辑。
- [ ] 修改 `AppTerminalPage.handlePickImage`，上传成功后返回 `shellQuote(filePath)`，不直接 `sendInput`。
- [ ] 确认错误处理和 support log 不记录完整本地路径。
- [ ] 运行 `pnpm --filter @runweave/app typecheck`。
- [ ] 运行 `pnpm --filter @runweave/app build`。
- [ ] 如触碰后端接口，运行 `pnpm --filter @runweave/backend test -- terminal.test.ts`。
- [ ] 使用 `$playwright-cli` 做 App 图片选择回归。
