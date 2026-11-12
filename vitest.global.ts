import { execSync } from "node:child_process";
/** Os testes de MCP/API sobem o CLI compilado: garante build atualizado. */
export default function setup() {
  execSync("pnpm exec tsc -b packages/shared packages/module-sdk packages/core packages/mcp packages/api packages/cli examples/modules/lembrete", { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  execSync("pnpm --filter @brain/web build", { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
}
