import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "electron/release/**",
      // Bundled Pi extension; lint its source under plugins/pi instead.
      "electron/resources/hooks/pi/runweave.js",
      "docs/prototypes/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "app-server/src/**/*.ts",
      "backend/src/**/*.ts",
      "packages/shared/src/**/*.ts",
      "packages/push-gateway/src/**/*.ts",
      "packages/suiji-server/**/*.ts",
      "packages/suiji-server/**/*.cjs",
      "packages/runweave-cli/src/**/*.ts",
      "electron/src/**/*.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["*.mjs", "**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["frontend/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value='react'] ImportSpecifier[imported.name='useCallback']",
          message: "Use useMemoizedFn from ahooks instead.",
        },
        {
          selector: "CallExpression[callee.name='useCallback']",
          message: "Use useMemoizedFn from ahooks instead.",
        },
        {
          selector: "CallExpression[callee.property.name='useCallback']",
          message: "Use useMemoizedFn from ahooks instead.",
        },
      ],
    },
  },
  {
    files: ["frontend/src/**/*.{ts,tsx}"],
    ignores: ["frontend/src/components/ui/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{
        group: ["@radix-ui/react-dialog", "@radix-ui/react-alert-dialog", "@radix-ui/react-popover", "@radix-ui/react-select", "@radix-ui/react-dropdown-menu", "@radix-ui/react-context-menu"],
        message: "Use components/ui floating surfaces so native Browser occlusion is coordinated.",
      }] }],
    },
  },
);
