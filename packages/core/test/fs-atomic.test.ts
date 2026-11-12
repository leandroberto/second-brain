import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issueHumanSession, preservarCorrompido, writeFileAtomic } from "../src/index.js";
import { human } from "./helpers.js";

const nova = () => mkdtempSync(join(tmpdir(), "brain-atomic-"));
const tmps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("writeFileAtomic", () => {
  it("grava, substitui o arquivo (inode novo) com o modo pedido e não deixa tmp", () => {
    const dir = nova(); const alvo = join(dir, "x.json");
    writeFileSync(alvo, "velho", { mode: 0o644 });
    const antes = statSync(alvo).ino;
    writeFileAtomic(alvo, "novo");
    expect(readFileSync(alvo, "utf8")).toBe("novo");
    expect(statSync(alvo).ino).not.toBe(antes);
    expect(statSync(alvo).mode & 0o777).toBe(0o600);
    writeFileAtomic(alvo, "outro", 0o640);
    expect(statSync(alvo).mode & 0o777).toBe(0o640);
    expect(tmps(dir)).toEqual([]);
  });

  it("rename que falha: relança e nenhum tmp sobra", () => {
    const dir = nova(); const alvo = join(dir, "alvo");
    mkdirSync(join(alvo, "dentro"), { recursive: true }); // rename de arquivo sobre diretório não vazio falha
    expect(() => writeFileAtomic(alvo, "x")).toThrow();
    expect(tmps(dir)).toEqual([]);
  });

  it("destino que é symlink: grava atomicamente no alvo real e o link continua link", () => {
    const dir = nova(); const outra = nova();
    const real = join(outra, "real.json"); const link = join(dir, "link.json");
    writeFileSync(real, "velho");
    symlinkSync(real, link);
    writeFileAtomic(link, "novo");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("novo");
    expect(tmps(dir)).toEqual([]); expect(tmps(outra)).toEqual([]);
    // symlink pendente (alvo ainda não existe, caminho relativo): cria o alvo
    symlinkSync("futuro.json", join(dir, "pendente.json"));
    writeFileAtomic(join(dir, "pendente.json"), "x");
    expect(lstatSync(join(dir, "pendente.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, "futuro.json"), "utf8")).toBe("x");
  });

  it("escrita que falha (pasta inexistente): relança", () => {
    expect(() => writeFileAtomic(join(nova(), "nao", "existe.json"), "x")).toThrow(/ENOENT/);
  });
});

describe("preservarCorrompido", () => {
  it("renomeia para <nome>.corrompido-<timestamp> e devolve o caminho; arquivo ausente devolve undefined", () => {
    const dir = nova(); const alvo = join(dir, "_x.json");
    writeFileSync(alvo, "{lixo");
    const p = preservarCorrompido(alvo)!;
    expect(p).toMatch(/_x\.json\.corrompido-\d{8}T\d{6}/);
    expect(readFileSync(p, "utf8")).toBe("{lixo");
    expect(readdirSync(dir)).toEqual([p.slice(dir.length + 1)]);
    expect(preservarCorrompido(alvo)).toBeUndefined();
  });

  it("falha que não é ausência (ex.: pasta sem permissão) lança em vez de fingir que preservou", () => {
    const dir = nova(); const alvo = join(dir, "_x.json");
    writeFileSync(alvo, "{lixo");
    chmodSync(dir, 0o500);
    try { expect(() => preservarCorrompido(alvo)).toThrow(/EACCES|EPERM/); }
    finally { chmodSync(dir, 0o700); }
    expect(readFileSync(alvo, "utf8")).toBe("{lixo");
  });
});

describe("sessions.json gravado de forma atômica", () => {
  it("save troca o arquivo por rename (inode novo), mantém 0600 e não deixa tmp", () => {
    const dir = nova(); const file = join(dir, "s", "ui-sessions.json");
    issueHumanSession(dir, human, { file });
    const antes = statSync(file).ino;
    issueHumanSession(dir, human, { file });
    expect(statSync(file).ino).not.toBe(antes);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(tmps(join(dir, "s"))).toEqual([]);
    expect(Object.values(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[]>)[0]).toHaveLength(2);
  });
});
