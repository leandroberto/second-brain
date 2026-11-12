import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilarRota, loadModules } from "../src/index.js";
import { cleanup, tempBrain } from "./helpers.js";

const FIX = resolve(import.meta.dirname, "fixtures/modules");
const saved = { dir: process.env.BRAIN_STATE_DIR };
beforeAll(() => { process.env.BRAIN_STATE_DIR = mkdtempSync(join(tmpdir(), "brain-rotas-")); });
afterAll(() => { cleanup(); if (saved.dir === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = saved.dir; });

describe("compilarRota", () => {
  it("aceita :param ocupando o segmento inteiro e devolve os valores crus", () => {
    const r = compilarRota("/itens/:id/sub/:outro")!;
    expect(r.casar("/itens/a%20b/sub/c")).toEqual({ id: "a%20b", outro: "c" });
    expect(r.casar("/itens/a/sub")).toBeUndefined();
    expect(compilarRota("/fixa")!.casar("/fixa")).toEqual({});
    expect(compilarRota("/a.b")!.casar("/aXb")).toBeUndefined(); // literal escapado
  });
  it("recusa param colado, com prefixo/sufixo ou repetido", () => {
    for (const c of ["/:a:b", "/x:id", "/:id.json", "/itens/:", "/:a/:a"]) expect(compilarRota(c), c).toBeUndefined();
  });
  it("não é lenta com muitos params colados (recusada na compilação)", () => {
    const t = Date.now();
    expect(compilarRota("/" + ":a".repeat(40))).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(100);
  });
});

describe("loader: caminho de rota inválido", () => {
  it("o módulo fica falho com a causa 'rota inválida: <metodo> <caminho>'", async () => {
    const b = await tempBrain();
    b.config.modules = { "rota-colada": { path: join(FIX, "rota-colada") }, "rota-prefixo": { path: join(FIX, "rota-prefixo") } };
    const reg = await loadModules(b, { modo: "definicoes", validarConfig: false });
    expect(reg.get("rota-colada")).toMatchObject({ status: "falho", causa: "rota inválida: GET /:a:b" });
    expect(reg.get("rota-prefixo")).toMatchObject({ status: "falho", causa: "rota inválida: GET /x:id" });
  });
});
