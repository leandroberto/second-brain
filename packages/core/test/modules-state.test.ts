import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createModuleState, modulesStateRoot, type Brain } from "../src/index.js";

describe("ctx.estado", () => {
  it("lerJson: undefined só quando o arquivo não existe", () => {
    const st = createModuleState(mkdtempSync(join(tmpdir(), "brain-estado-")), "mod");
    expect(st.lerJson("itens")).toBeUndefined();
    st.gravarJson("itens", [1, 2]);
    expect(st.lerJson("itens")).toEqual([1, 2]);
  });

  it("lerJson de JSON corrompido lança invalid citando nome e módulo, e o arquivo fica intacto", () => {
    const st = createModuleState(mkdtempSync(join(tmpdir(), "brain-estado-")), "mod");
    writeFileSync(join(st.dir, "itens.json"), "{trunc");
    expect(() => st.lerJson("itens")).toThrowError(expect.objectContaining({ code: "invalid", message: "estado itens do módulo mod está corrompido" }));
    expect(readFileSync(join(st.dir, "itens.json"), "utf8")).toBe("{trunc");
  });

  it("lerJson: erro de leitura que não é ausência é relançado (não vira undefined)", () => {
    const st = createModuleState(mkdtempSync(join(tmpdir(), "brain-estado-")), "mod");
    mkdirSync(join(st.dir, "pasta.json"));
    expect(() => st.lerJson("pasta")).toThrow(/EISDIR/);
  });
});

/** Só o que `modulesStateRoot` lê do Brain: sem abrir o vault (nada é escrito nele). */
const brainFalso = (root: string) => ({ vault: { root, stateDir: undefined }, config: { vault_name: "Cofre" } }) as unknown as Brain;

describe("modulesStateRoot em FS que não diferencia maiúsculas", () => {
  it("duas aberturas do mesmo vault com caixas diferentes caem na mesma pasta, sem state_unavailable", () => {
    const base = mkdtempSync(join(tmpdir(), "brain-caixa-"));
    // num FS que diferencia caixa, duas pastas reais; a sonda injetada faz o papel de /mnt/c (as duas são "o mesmo" vault)
    const maiusc = join(base, "Users", "Cofre"); const minusc = join(base, "users", "cofre");
    mkdirSync(maiusc, { recursive: true }); mkdirSync(minusc, { recursive: true });
    const env = { HOME: base, BRAIN_STATE_DIR: join(base, "estado") };
    const semCaixa = { sondaCaixa: () => true };
    const a = modulesStateRoot(brainFalso(maiusc), env, semCaixa);
    const b = modulesStateRoot(brainFalso(minusc), env, semCaixa);
    expect(b).toBe(a);
    // gravado pela mesma regra da impressão: o caminho real em minúsculas
    expect(readFileSync(join(a, "..", "vault-path"), "utf8").trim()).toBe(realpathSync(maiusc).toLowerCase());
    rmSync(base, { recursive: true, force: true });
  });

  it("vault-path antigo com a caixa da primeira abertura (versão anterior) continua aceito", () => {
    const base = mkdtempSync(join(tmpdir(), "brain-caixa-"));
    const maiusc = join(base, "Users", "Cofre"); const minusc = join(base, "users", "cofre");
    mkdirSync(maiusc, { recursive: true }); mkdirSync(minusc, { recursive: true });
    const env = { HOME: base, BRAIN_STATE_DIR: join(base, "estado") };
    const semCaixa = { sondaCaixa: () => true };
    const a = modulesStateRoot(brainFalso(minusc), env, semCaixa);
    writeFileSync(join(a, "..", "vault-path"), `${realpathSync(maiusc)}\n`);
    expect(modulesStateRoot(brainFalso(minusc), env, semCaixa)).toBe(a);
    rmSync(base, { recursive: true, force: true });
  });

  it("FS que diferencia caixa: outro vault (só a caixa muda) na mesma pasta continua recusado", () => {
    const base = mkdtempSync(join(tmpdir(), "brain-caixa-"));
    const maiusc = join(base, "Users", "Cofre"); const minusc = join(base, "users", "cofre");
    mkdirSync(maiusc, { recursive: true }); mkdirSync(minusc, { recursive: true });
    const env = { HOME: base, BRAIN_STATE_DIR: join(base, "estado") };
    const a = modulesStateRoot(brainFalso(maiusc), env, { sondaCaixa: () => false });
    expect(readFileSync(join(a, "..", "vault-path"), "utf8").trim()).toBe(realpathSync(maiusc));
    // pastas diferentes de verdade: impressões diferentes, nunca a mesma pasta
    expect(modulesStateRoot(brainFalso(minusc), env, { sondaCaixa: () => false })).not.toBe(a);
    // e se um vault-path de outro vault (só a caixa difere) estiver na pasta, é recusado
    writeFileSync(join(a, "..", "vault-path"), `${realpathSync(maiusc).toLowerCase()}\n`);
    expect(() => modulesStateRoot(brainFalso(maiusc), env, { sondaCaixa: () => false })).toThrowError(expect.objectContaining({ code: "state_unavailable" }));
    rmSync(base, { recursive: true, force: true });
  });

  // reprodução real no WSL: só leitura em /mnt/c (realpath e stat), estado num diretório temporário
  const mesmoArquivo = (a: string, b: string) => {
    try { const x = statSync(a); const y = statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch { return false; }
  };
  const temMntC = existsSync("/mnt/c/Users") && mesmoArquivo("/mnt/c/Users", "/mnt/c/users");
  it.skipIf(!temMntC)("WSL: /mnt/c/Users e /mnt/c/users dão a mesma pasta de estado, sem erro", () => {
    const base = mkdtempSync(join(tmpdir(), "brain-caixa-"));
    const env = { HOME: base, BRAIN_STATE_DIR: join(base, "estado") };
    const a = modulesStateRoot(brainFalso("/mnt/c/Users"), env);
    expect(modulesStateRoot(brainFalso("/mnt/c/users"), env)).toBe(a);
    expect(modulesStateRoot(brainFalso("/mnt/c/Users"), env)).toBe(a);
    rmSync(base, { recursive: true, force: true });
  });

  // pasta do vault sem letras (C:\Windows\System32\0409): a sonda usa outra entrada de System32
  const semLetras = "/mnt/c/Windows/System32/0409";
  const temSemLetras = existsSync(semLetras) && mesmoArquivo("/mnt/c/Windows/System32", "/mnt/c/Windows/system32");
  it.skipIf(!temSemLetras)("WSL: vault com nome sem letras em /mnt/c também normaliza a caixa", () => {
    const base = mkdtempSync(join(tmpdir(), "brain-caixa-"));
    const env = { HOME: base, BRAIN_STATE_DIR: join(base, "estado") };
    const a = modulesStateRoot(brainFalso(semLetras), env);
    expect(modulesStateRoot(brainFalso("/mnt/c/windows/system32/0409"), env)).toBe(a);
    expect(readFileSync(join(a, "..", "vault-path"), "utf8").trim()).toBe(semLetras.toLowerCase());
    rmSync(base, { recursive: true, force: true });
  });
});
