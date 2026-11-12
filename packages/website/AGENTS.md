# Website

独立中文静态官网。入口为 `src/pages/index.astro`，公开链接在 `src/data/home.ts`。

- Astro + TypeScript + CSS，不导入产品 Frontend、Backend 或运行时合同。
- 所有营销正文和入口输出 HTML；设备画面为示意，不伪装成实时任务。
- 默认预览 noindex；生产构建必须提供 `WEBSITE_ENV=production` 与真实 HTTPS `WEBSITE_SITE_URL`。
- 最小检查：`pnpm --filter @runweave/website lint`、`typecheck`、`build`；模板诊断由 `astro check` 承担。
- 浏览器验收使用 playwright-cli，素材只含可公开的示例数据。
- 操作、静态托管和回滚见 [README](README.md)。
