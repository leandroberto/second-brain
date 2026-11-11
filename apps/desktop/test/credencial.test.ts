import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { criarCredencial, type Cripto } from "../src/main/credencial";

// cripto falsa e reversível: o arquivo nunca pode conter o token em claro
const cripto: Cripto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").toString("hex"), "utf8"),
  decryptString: (b) => Buffer.from(b.toString("utf8"), "hex").toString("utf8"),
};
const dir = () => mkdtempSync(join(tmpdir(), "desktop-cred-"));

test("salvar e ler via cripto; o arquivo não guarda o token em claro", () => {
  const d = dir();
  const c = criarCredencial(join(d, "credencial.bin"), cripto);
  expect(c.ler()).toBeNull();
  c.salvar("hs_abc123");
  expect(c.ler()).toBe("hs_abc123");
  expect(readFileSync(join(d, "credencial.bin")).toString("utf8")).not.toContain("hs_abc123");
});

test("token com espaços ao redor é aparado; vazio é recusado", () => {
  const c = criarCredencial(join(dir(), "c.bin"), cripto);
  c.salvar("  hs_x \n");
  expect(c.ler()).toBe("hs_x");
  expect(() => c.salvar("   ")).toThrow();
});

test("sem criptografia disponível, não grava em claro", () => {
  const d = dir();
  const c = criarCredencial(join(d, "c.bin"), { ...cripto, isEncryptionAvailable: () => false });
  expect(() => c.salvar("hs_x")).toThrow(/criptografia/);
  expect(existsSync(join(d, "c.bin"))).toBe(false);
});

test("arquivo corrompido: ler devolve null em vez de quebrar", () => {
  const d = dir();
  const c = criarCredencial(join(d, "c.bin"), {
    ...cripto,
    decryptString: () => {
      throw new Error("falhou");
    },
  });
  c.salvar("hs_x");
  expect(c.ler()).toBeNull();
});
