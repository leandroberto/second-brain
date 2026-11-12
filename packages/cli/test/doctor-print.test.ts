import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Brain, coreDoctor, dumpConfig } from "@brain/core";
import { printChecks } from "../src/doctor.js";

const dir = mkdtempSync(join(tmpdir(), "brain-doctor-print-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** O que `printChecks` escreve no terminal. */
function impresso(fn: () => void): string {
  const linhas: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { linhas.push(a.join(" ")); });
  try { fn(); } finally { spy.mockRestore(); }
  return linhas.join("\n");
}

describe("brain doctor: saída de texto", () => {
  it("remove caracteres de controle (C0/C1, inclusive ESC) do nome, do detalhe e da correção", () => {
    const out = impresso(() => printChecks([{ id: "x", name: "No\x1b[2Jme", status: "warn", detail: "de\x1b[31mtalhe\x07\x9b31m\r\x00fim", fix: "cor\x1b]0;título\x07reção\u0085" }]));
    expect(out.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u); // as quebras de linha são do próprio printChecks
    expect(out).toContain("[31mtalhe31mfim");
    expect(out).toContain("↳ correção: cor]0;títuloreção");
  });

  it("um model com ESC (vira `oa:<model>` no detalhe dos embeddings) sai sem ESC", async () => {
    const b = await Brain.init(join(dir, "vault"));
    const model = "m\x1b[31m-vermelho\x1b[0m";
    writeFileSync(b.vault.configPath, dumpConfig({ ...b.config, embeddings: { ...b.config.embeddings, provider: "openai-compatible", base_url: "http://localhost:9/v1", model } }), "utf8");
    b.close();
    const b2 = await Brain.open(join(dir, "vault"));
    const checks = await coreDoctor(b2);
    b2.close();
    expect(checks.find((c) => c.id === "embeddings")?.detail).toContain(`oa:${model}`); // o vetor existe no detalhe
    const out = impresso(() => printChecks(checks));
    expect(out).not.toContain("\x1b");
    expect(out).toContain("oa:m[31m-vermelho[0m");
  });
});
