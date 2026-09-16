// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // `scripts/__snapshots__/public-api/**`（Issue #342 / ADR 0178）は
      // `scripts/check-public-api-surface.mjs --write` が生成する、公開 API の
      // 型シグネチャの diff 用スナップショットであり、コンパイル可能なソースではない
      // （TypeScript の printer が吐いた出力を連結しただけで、import 先の実在は
      // 保証されない）。`dist/**` と同じ理由でここも除外する。
      "scripts/__snapshots__/public-api/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  eslintConfigPrettier,
);
