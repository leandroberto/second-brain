import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const p = (s: string) => fileURLToPath(new URL(s, import.meta.url));
export default defineConfig({
  resolve: { alias: {
    "@brain/shared": p("./packages/shared/src/index.ts"),
    "@brain/core": p("./packages/core/src/index.ts"),
    "@brain/mcp": p("./packages/mcp/src/index.ts"),
    "@brain/api": p("./packages/api/src/index.ts"),
  } },
  test: { globalSetup: ["./vitest.global.ts"], include: ["packages/*/test/**/*.test.ts", "e2e/**/*.test.ts"], testTimeout: 30000, pool: "forks" },
});
