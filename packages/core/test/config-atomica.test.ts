import * as fs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Vault, writeFileAtomic } from "../src/index.js";
import { cleanup, human, tempBrain } from "./helpers.js";

// o rename do writeFileAtomic falha (só) para os caminhos de `falharRename`: simula a queda no meio da troca do arquivo
const falharRename = new Set<string>();
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (de: fs.PathLike, para: fs.PathLike) => {
      if (falharRename.has(String(para))) throw Object.assign(new Error("EIO: falha forçada no rename"), { code: "EIO" });
      return real.renameSync(de, para);
    },
  };
});
afterEach(() => falharRename.clear());
afterAll(cleanup);

const tmps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("config.yaml gravado de forma atômica", () => {
  it("updateConfig com falha no rename: o config.yaml antigo fica intacto e não sobra tmp", async () => {
    const b = await tempBrain();
    const cfg = b.vault.configPath;
    const antes = readFileSync(cfg, "utf8");
    falharRename.add(cfg);
    await expect(b.updateConfig({ vault_name: "Outro" }, human)).rejects.toThrow(/falha forçada/);
    expect(readFileSync(cfg, "utf8")).toBe(antes);
    expect(tmps(dirname(cfg))).toEqual([]);
    b.close();
  });

  it("setModuleEntry com falha no rename: o config.yaml antigo fica intacto e não sobra tmp", async () => {
    const b = await tempBrain();
    const cfg = b.vault.configPath;
    const antes = readFileSync(cfg, "utf8");
    falharRename.add(cfg);
    await expect(b.setModuleEntry("lembrete", { enabled: true, ia_max_usd_dia: 2 }, human)).rejects.toThrow(/falha forçada/);
    expect(readFileSync(cfg, "utf8")).toBe(antes);
    expect(tmps(dirname(cfg))).toEqual([]);
    b.close();
  });

  it("criação do vault com falha no rename: nenhum config.yaml parcial e nenhum tmp", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-cfg-atomica-"));
    try {
      fs.mkdirSync(join(root, ".brain"));
      const v = new Vault(root);
      falharRename.add(v.configPath);
      expect(() => v.writeDefaultConfig()).toThrow(/falha forçada/);
      expect(existsSync(v.configPath)).toBe(false);
      expect(tmps(join(root, ".brain"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("toda gravação troca o arquivo (inode novo) e mantém o modo atual do config.yaml", async () => {
    const b = await tempBrain();
    const cfg = b.vault.configPath;
    // modo de um arquivo novo: o mesmo que o writeFileSync daria (0666 menos a umask), não 0600
    const ref = join(dirname(cfg), "referencia");
    writeFileSync(ref, "x");
    expect(statSync(cfg).mode & 0o777).toBe(statSync(ref).mode & 0o777);
    rmSync(ref);
    for (const modo of [0o644, 0o640]) {
      chmodSync(cfg, modo);
      const ino = statSync(cfg).ino;
      await b.updateConfig({ vault_name: `V${modo}` }, human);
      expect([modo, statSync(cfg).mode & 0o777, statSync(cfg).ino === ino]).toEqual([modo, modo, false]);
      await b.setModuleEntry("lembrete", { enabled: modo === 0o644, ia_max_usd_dia: 2 }, human);
      expect([modo, statSync(cfg).mode & 0o777]).toEqual([modo, modo]);
    }
    expect(tmps(dirname(cfg))).toEqual([]);
    b.close();
  });

  it("writeFileAtomic com \"manter\": arquivo existente fica com o modo dele; arquivo novo, com o padrão da umask", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-cfg-atomica-"));
    try {
      const alvo = join(dir, "a.yaml");
      writeFileSync(alvo, "velho", { mode: 0o640 });
      chmodSync(alvo, 0o640);
      writeFileAtomic(alvo, "novo", "manter");
      expect([readFileSync(alvo, "utf8"), statSync(alvo).mode & 0o777]).toEqual(["novo", 0o640]);
      const novo = join(dir, "b.yaml"); const ref = join(dir, "ref");
      writeFileAtomic(novo, "x", "manter");
      writeFileSync(ref, "x");
      expect(statSync(novo).mode & 0o777).toBe(statSync(ref).mode & 0o777);
      expect(tmps(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
