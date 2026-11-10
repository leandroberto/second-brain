import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "seed/demo-vault/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // scripts .mjs rodam em Node: globais padrão
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", setTimeout: "readonly", fetch: "readonly" } } },
  // A UI só fala com a API local: nada de Core nem de APIs de Node.
  {
    files: ["apps/web/src/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["@brain/core", "@brain/core/*", "@brain/api", "@brain/mcp", "node:*"], message: "A UI não pode importar o Core nem APIs de Node: use somente a API local." }] }] },
  },
);
