import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist", "**/node_modules", "**/coverage", "apps/web/playwright-report"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["apps/api/**/*.ts", "packages/**/*.ts", "load/**/*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    // Fixtures and tests index into data they just created; `!` is clearer than guards there.
    files: ["**/test/**/*.ts", "**/*.test.{ts,tsx}", "**/e2e/**/*.ts", "apps/api/src/seed.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["load/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node, __ENV: "readonly" } },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
