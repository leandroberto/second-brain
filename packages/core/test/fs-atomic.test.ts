import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
