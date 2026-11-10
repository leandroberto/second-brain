import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { managedBlock, removeBlock } from "../src/integrate.js";

describe("blocos gerenciados (política dos agentes)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-int-"));
  it("preserva conteúdo do usuário, é idempotente e reversível", () => {
    const f = join(dir, "CLAUDE.md");
    writeFileSync(f, "# Minhas regras\n\nSempre responda em pt-br.\n");
    managedBlock(f, "policy v1"); managedBlock(f, "policy v2"); managedBlock(f, "policy v2");
    const t = readFileSync(f, "utf8");
    expect(t).toContain("Sempre responda em pt-br.");
    expect(t.match(/second-brain:start/g)?.length).toBe(1);
    expect(t).toContain("policy v2"); expect(t).not.toContain("policy v1");
    removeBlock(f);
    expect(readFileSync(f, "utf8")).toBe("# Minhas regras\n\nSempre responda em pt-br.\n");
  });
  it("remove o arquivo se só existia o bloco; cria diretório se faltar", () => {
    const f = join(dir, "sub", "AGENTS.md");
    managedBlock(f, "x");
    expect(existsSync(f)).toBe(true);
    removeBlock(f);
    expect(existsSync(f)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  it("conteúdo com $& ou $1 não vira padrão de substituição", () => {
    const d = mkdtempSync(join(tmpdir(), "brain-int2-"));
    const f = join(d, "A.md");
    managedBlock(f, "a"); managedBlock(f, "preço $& e $1");
    expect(readFileSync(f, "utf8")).toContain("preço $& e $1");
  });
});
