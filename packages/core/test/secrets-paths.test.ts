import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeResolve } from "../src/paths.js";
import { scanBulk, scanSecrets } from "../src/secrets.js";

describe("secret filtering", () => {
  const bad = [
    "AWS key AKIAIOSFODNN7EXAMPLE",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz",
    "password = hunter2hunter2",
    "API_KEY: 9f8a7b6c5d4e3f2a1b",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "postgres://user:s3cretpass@db.host/app",
    "-----BEGIN RSA PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
  ];
  for (const t of bad) it(`detecta: ${t.slice(0, 28)}`, () => expect(scanSecrets(t).length).toBeGreaterThan(0));
  const ok = ["use a variável API_KEY=<seu-token>", "token = process.env.TOKEN", "O projeto usa Python 3.12 e SQLite", "senha: ${SENHA}"];
  for (const t of ok) it(`aceita: ${t.slice(0, 28)}`, () => expect(scanSecrets(t)).toEqual([]));
  it("não vaza o segredo no sample", () => expect(JSON.stringify(scanSecrets("password=abcdefghijkl"))).not.toContain("abcdefghijkl"));
  it("limita blocos de código e tamanho", () => {
    const big = "```\n" + "x\n".repeat(60) + "```";
    expect(scanBulk(big, { maxChars: 9999, maxCodeLines: 40 })[0]).toMatch(/bloco de código/);
    expect(scanBulk("a".repeat(100), { maxChars: 50, maxCodeLines: 40 })[0]).toMatch(/grande/);
  });
});

describe("path safety", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-path-"));
  mkdirSync(join(root, "knowledge"));
  it("aceita caminho interno", () => expect(safeResolve(root, "knowledge/a.md")).toContain("knowledge"));
  for (const bad of ["../x", "knowledge/../../etc/passwd", "/etc/passwd", "", "a\0b"]) {
    it(`rejeita ${JSON.stringify(bad)}`, () => expect(() => safeResolve(root, bad)).toThrow());
  }
  it("rejeita symlink que escapa", () => {
    const outside = mkdtempSync(join(tmpdir(), "brain-out-"));
    symlinkSync(outside, join(root, "knowledge", "link"));
    expect(() => safeResolve(root, "knowledge/link/x.md")).toThrow(/symlink/);
  });
});
