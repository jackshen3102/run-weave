import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.live.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "**/dist/**",
        "**/*.test.ts",
        "vitest.config.ts",
        "vitest.live.config.ts",
        "src/index.ts",
        "src/browser/**",
        "src/routes/test.ts",
        "src/voice/codex-app-server-client.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
});
