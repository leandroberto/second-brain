import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RespostaAnotar } from "../src/main/cliente-api";
import { FilaLocal } from "../src/main/fila-local";
import { anotarComFila } from "../src/main/fluxo";

const fila = () => new FilaLocal(join(mkdtempSync(join(tmpdir(), "desktop-fluxo-")), "fila-local.json"));
const sucesso: RespostaAnotar = {
  ok: true,
  capture_id: "20261110-153012-a1b2",
  state: "processada",
  result: { ok: true, notas: [], segredo_omitido: false, texto_mascarado: null },
};

test("sucesso não enfileira", async () => {
  const f = fila();
  const r = await anotarComFila({ anotar: async () => sucesso }, f, "oi");
  expect(r).toEqual({ resposta: sucesso, enfileirado: false });
  expect(f.pendentes()).toEqual([]);
});

test("incerto (timeout ou 5xx) NÃO vai para a fila: o servidor pode ter gravado, reenviar duplicaria", async () => {
  const f = fila();
  const incerto: RespostaAnotar = { ok: false, tipo: "incerto", mensagem: "não sei se foi registrado" };
  expect(await anotarComFila({ anotar: async () => incerto }, f, "x")).toEqual({ resposta: incerto, enfileirado: false });
  expect(f.pendentes()).toEqual([]);
});

test("offline e pareamento guardam o texto na fila local", async () => {
  for (const falha of [
    { ok: false, tipo: "offline" },
    { ok: false, tipo: "pareamento", mensagem: "m" },
  ] as RespostaAnotar[]) {
    const f = fila();
    const r = await anotarComFila({ anotar: async () => falha }, f, "texto ditado\ncom linhas");
    expect(r).toEqual({ resposta: falha, enfileirado: true });
    expect(f.pendentes()).toEqual(["texto ditado\ncom linhas"]);
  }
});

test("erro 4xx (que não adianta repetir) não enfileira: o chamador devolve o texto à janela", async () => {
  const f = fila();
  const falha: RespostaAnotar = { ok: false, tipo: "http", status: 413, mensagem: "corpo > 1MB" };
  expect(await anotarComFila({ anotar: async () => falha }, f, "x")).toEqual({ resposta: falha, enfileirado: false });
  expect(f.pendentes()).toEqual([]);
});

test("captura 200 com result de erro (pendente no servidor) não vai para a fila local", async () => {
  const f = fila();
  const pendente: RespostaAnotar = { ok: true, capture_id: "c", state: "pendente", result: { ok: false, tipo: "auth", mensagem: "x" } };
  expect((await anotarComFila({ anotar: async () => pendente }, f, "x")).enfileirado).toBe(false);
  expect(f.pendentes()).toEqual([]);
});
