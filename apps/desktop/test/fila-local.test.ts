import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { avisosDasFilas, FilaLocal } from "../src/main/fila-local";
import type { RespostaAnotar } from "../src/main/cliente-api";

const arquivo = () => join(mkdtempSync(join(tmpdir(), "desktop-fila-")), "fila-local.json");
const ok = (n: number): RespostaAnotar => ({
  ok: true,
  capture_id: `c${n}`,
  state: "processada",
  result: { ok: true, notas: [], segredo_omitido: false, texto_mascarado: null },
});
const clienteQue = (respostas: RespostaAnotar[]) => {
  const enviados: string[] = [];
  return {
    enviados,
    anotar: async (t: string) => {
      enviados.push(t);
      return respostas[enviados.length - 1] ?? ok(99);
    },
  };
};

test("fila local envia em ordem e mantém o que falhou", async () => {
  const fila = new FilaLocal(arquivo());
  fila.adicionar("primeiro");
  fila.adicionar("segundo");
  fila.adicionar("terceiro");
  const c = clienteQue([ok(1), { ok: false, tipo: "http", status: 500, mensagem: "erro interno" }, ok(3)]);
  const r = await fila.enviar(c);
  expect(c.enviados).toEqual(["primeiro", "segundo"]); // para no primeiro erro: a ordem é preservada
  expect(fila.pendentes()).toEqual(["segundo", "terceiro"]);
  expect(r.enviados.map((e) => e.texto)).toEqual(["primeiro"]);
  expect(r.enviados[0]!.resposta).toMatchObject({ capture_id: "c1" });
  expect(r.falha).toMatchObject({ tipo: "http", status: 500 });
});

test("offline mantém tudo; depois que volta, envia o resto em ordem", async () => {
  const fila = new FilaLocal(arquivo());
  fila.adicionar("a");
  fila.adicionar("b");
  await fila.enviar(clienteQue([{ ok: false, tipo: "offline" }]));
  expect(fila.pendentes()).toEqual(["a", "b"]);
  const c2 = clienteQue([ok(1), ok(2)]);
  const r = await fila.enviar(c2);
  expect(c2.enviados).toEqual(["a", "b"]);
  expect(fila.pendentes()).toEqual([]);
  expect(r.falha).toBeUndefined();
});

test("persiste em disco e sobrevive a uma nova instância", () => {
  const a = arquivo();
  new FilaLocal(a).adicionar("não perder");
  expect(new FilaLocal(a).pendentes()).toEqual(["não perder"]);
});

test("gravação atômica: sem arquivo temporário sobrando e JSON válido", () => {
  const a = arquivo();
  const fila = new FilaLocal(a);
  fila.adicionar("x");
  fila.adicionar("y");
  expect(readdirSync(join(a, ".."))).toEqual(["fila-local.json"]);
  expect(JSON.parse(readFileSync(a, "utf8"))).toHaveLength(2);
});

test("arquivo ausente começa vazio; texto ditado nunca é alterado", () => {
  const a = arquivo();
  expect(new FilaLocal(a).pendentes()).toEqual([]);
  const fila = new FilaLocal(a);
  const longo = "  linha 1\n\n  linha 2 com acentuação — ção  ";
  fila.adicionar(longo);
  expect(new FilaLocal(a).pendentes()).toEqual([longo]);
  expect(existsSync(a)).toBe(true);
});

test("arquivo corrompido: vai para .corrompido-<ts> com o conteúdo original, a fila recomeça vazia e há um aviso", () => {
  const a = arquivo();
  const original = '[{"id":"1","texto":"texto ditado importante"},';
  writeFileSync(a, original, "utf8");
  const fila = new FilaLocal(a);
  expect(fila.pendentes()).toEqual([]);
  fila.adicionar("novo");
  expect(fila.pendentes()).toEqual(["novo"]);
  const copias = readdirSync(join(a, "..")).filter((n) => n.startsWith("fila-local.json.corrompido-"));
  expect(copias).toHaveLength(1);
  expect(readFileSync(join(a, "..", copias[0]!), "utf8")).toBe(original);
  expect(fila.obterAvisos()).toEqual([copias[0]]);
  expect(fila.obterAvisos()).toEqual([]); // o aviso sai uma vez só
});

test("JSON válido que não é lista também conta como corrompido", () => {
  const a = arquivo();
  writeFileSync(a, '{"x":1}', "utf8");
  const fila = new FilaLocal(a);
  expect(fila.pendentes()).toEqual([]);
  expect(fila.obterAvisos()).toHaveLength(1);
});

test("itens malformados vão para .descartados-<ts>.json e os bons ficam", () => {
  const a = arquivo();
  const bom = { id: "b", texto: "bom", em: "2026-01-01T00:00:00.000Z" };
  writeFileSync(a, JSON.stringify([bom, { id: 7 }, "solto", { id: "c" }]), "utf8");
  const fila = new FilaLocal(a);
  expect(fila.pendentes()).toEqual(["bom"]);
  const desc = readdirSync(join(a, "..")).filter((n) => n.includes(".descartados-"));
  expect(desc).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(a, "..", desc[0]!), "utf8"))).toEqual([{ id: 7 }, "solto", { id: "c" }]);
});

test("falha ao gravar depois de um 200 não reenvia o que já foi aceito", async () => {
  const fila = new FilaLocal(arquivo());
  fila.adicionar("um");
  fila.adicionar("dois");
  const gravar = vi.spyOn(fila as unknown as { gravar(i: unknown): void }, "gravar");
  gravar.mockImplementationOnce(() => {
    throw new Error("disco cheio");
  });
  const c = clienteQue([ok(1), ok(2)]);
  await fila.enviar(c);
  expect(c.enviados).toEqual(["um", "dois"]); // seguiu com o "dois": o "um" não foi reenviado
  const c2 = clienteQue([ok(9)]);
  await fila.enviar(c2);
  expect(c2.enviados).toEqual([]);
  expect(fila.pendentes()).toEqual([]);
});

test("item rejeitado sempre (4xx): vai para a quarentena depois de 5 ciclos e o seguinte é enviado", async () => {
  const a = arquivo();
  const fila = new FilaLocal(a);
  fila.adicionar("venenoso");
  fila.adicionar("bom");
  const enviados: string[] = [];
  const c = {
    anotar: async (t: string): Promise<RespostaAnotar> => {
      enviados.push(t);
      return t === "venenoso" ? { ok: false, tipo: "http", status: 400, mensagem: "inválido" } : ok(1);
    },
  };
  for (let ciclo = 1; ciclo <= 4; ciclo++) {
    const r = await fila.enviar(c);
    expect(r.quarentenados).toEqual([]);
    expect(fila.pendentes()).toEqual(["venenoso", "bom"]); // ordem preservada enquanto ainda tenta
  }
  expect(enviados).not.toContain("bom");
  const quinto = await fila.enviar(c);
  expect(quinto.quarentenados).toEqual(["venenoso"]);
  expect(quinto.enviados.map((e) => e.texto)).toEqual(["bom"]);
  expect(fila.pendentes()).toEqual([]);
  expect(fila.quarentena()).toEqual(["venenoso"]);
  expect(existsSync(join(a, "..", "fila-local.quarentena.json"))).toBe(true);
  expect(fila.arquivoQuarentena).toBe(join(a, "..", "fila-local.quarentena.json"));
});

test("offline e pareamento não contam tentativa", async () => {
  const fila = new FilaLocal(arquivo());
  fila.adicionar("a");
  for (let i = 0; i < 12; i++) await fila.enviar(clienteQue([{ ok: false, tipo: i % 2 ? "offline" : "pareamento", mensagem: "m" } as RespostaAnotar]));
  expect(fila.pendentes()).toEqual(["a"]);
  expect(fila.quarentena()).toEqual([]);
  const c = clienteQue([ok(1)]);
  await fila.enviar(c);
  expect(c.enviados).toEqual(["a"]);
});

test("a contagem de tentativas sobrevive a uma nova instância e zera quando o item é aceito", async () => {
  const a = arquivo();
  const falha: RespostaAnotar = { ok: false, tipo: "http", status: 500, mensagem: "m" };
  const f1 = new FilaLocal(a);
  f1.adicionar("x");
  for (let i = 0; i < 4; i++) await new FilaLocal(a).enviar(clienteQue([falha]));
  const r = await new FilaLocal(a).enviar(clienteQue([falha]));
  expect(r.quarentenados).toEqual(["x"]);
});

test("adicionar devolve o id e remover tira o item", () => {
  const fila = new FilaLocal(arquivo());
  const id = fila.adicionar("a");
  fila.adicionar("b");
  fila.remover(id);
  expect(fila.pendentes()).toEqual(["b"]);
});

test("adicionar durante o envio não perde o item novo", async () => {
  const fila = new FilaLocal(arquivo());
  fila.adicionar("um");
  let adicionou = false;
  const c = {
    anotar: async (_t: string) => {
      if (!adicionou) fila.adicionar("chegou no meio");
      adicionou = true;
      return { ok: false, tipo: "offline" } as RespostaAnotar; // falha depois de entrar item novo: nada se perde
    },
  };
  await fila.enviar(c);
  expect(fila.pendentes()).toEqual(["um", "chegou no meio"]);
  const c2 = clienteQue([ok(1), ok(2)]);
  await fila.enviar(c2);
  expect(c2.enviados).toEqual(["um", "chegou no meio"]);
  expect(fila.pendentes()).toEqual([]);
});

test("envios concorrentes não duplicam", async () => {
  const fila = new FilaLocal(arquivo());
  fila.adicionar("um");
  fila.adicionar("dois");
  const enviados: string[] = [];
  const c = {
    anotar: async (t: string) => {
      enviados.push(t);
      await new Promise((r) => setTimeout(r, 10));
      return ok(1);
    },
  };
  await Promise.all([fila.enviar(c), fila.enviar(c)]);
  expect(enviados).toEqual(["um", "dois"]);
  expect(fila.pendentes()).toEqual([]);
});

test("incerto na fila local vai direto para a quarentena (não é reenviado) e a fila segue", async () => {
  const fila = new FilaLocal(arquivo());
  fila.adicionar("talvez gravado");
  fila.adicionar("seguinte");
  const c = clienteQue([{ ok: false, tipo: "incerto", mensagem: "m" }, ok(2)]);
  const r = await fila.enviar(c);
  expect(c.enviados).toEqual(["talvez gravado", "seguinte"]);
  expect(r.quarentenados).toEqual(["talvez gravado"]);
  expect(r.enviados.map((e) => e.texto)).toEqual(["seguinte"]);
  expect(fila.pendentes()).toEqual([]);
  expect(fila.quarentena()).toEqual(["talvez gravado"]);
});

test("avisos das duas filas: um em-voo corrompido também aparece", () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-fila-"));
  writeFileSync(join(dir, "em-voo.json"), "{corrompido", "utf8");
  const fila = new FilaLocal(join(dir, "fila-local.json"));
  const emVoo = new FilaLocal(join(dir, "em-voo.json"));
  expect(emVoo.pendentes()).toEqual([]); // a subida lê o diário em-voo
  const avisos = avisosDasFilas(fila, emVoo);
  expect(avisos).toHaveLength(1);
  expect(avisos[0]).toMatch(/^em-voo\.json\.corrompido-/);
  expect(avisosDasFilas(fila, emVoo)).toEqual([]);
});
