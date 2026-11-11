import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RespostaRenovar } from "../src/main/cliente-api";
import { criarCredencial, type Cripto } from "../src/main/credencial";
import { IDADE_RENOVAR_MS, renovarSeNecessario } from "../src/main/renovacao";

const cripto: Cripto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").toString("hex"), "utf8"),
  decryptString: (b) => Buffer.from(b.toString("utf8"), "hex").toString("utf8"),
};
const credencial = () => criarCredencial(join(mkdtempSync(join(tmpdir(), "desktop-renova-")), "credencial.bin"), cripto);
const DIA = 864e5;
const T0 = Date.parse("2026-11-01T12:00:00Z");
const NOVO = `hs_${"b".repeat(64)}`;

/** Cliente falso da renovação: registra o token apresentado e devolve a resposta dada. */
const falso = (resposta: RespostaRenovar) => {
  const chamadas: string[] = [];
  return { chamadas, renovar: async (token: string) => { chamadas.push(token); return resposta; } };
};

test("renova depois de 7 dias: chama a API com o token atual e guarda o novo com a data nova", async () => {
  const c = credencial();
  c.salvar("hs_antigo", T0);
  const api = falso({ ok: true, token: NOVO });
  const agora = T0 + 8 * DIA;
  expect(await renovarSeNecessario(c, api.renovar, agora)).toEqual({ estado: "renovada", token: NOVO });
  expect(api.chamadas).toEqual(["hs_antigo"]);
  expect(c.lerTudo()).toEqual({ token: NOVO, emitidaEm: agora });
  expect(c.ler()).toBe(NOVO);
});

test("não renova antes de 7 dias", async () => {
  const c = credencial();
  c.salvar("hs_antigo", T0);
  const api = falso({ ok: true, token: NOVO });
  expect(await renovarSeNecessario(c, api.renovar, T0 + IDADE_RENOVAR_MS - 1)).toEqual({ estado: "em-dia" });
  expect(api.chamadas).toEqual([]);
  expect(c.ler()).toBe("hs_antigo");
});

test("401 na renovação cai no pareamento e mantém a credencial; offline tenta depois", async () => {
  const c = credencial();
  c.salvar("hs_antigo", T0);
  expect(await renovarSeNecessario(c, falso({ ok: false, tipo: "pareamento", mensagem: "m" }).renovar, T0 + 10 * DIA)).toEqual({ estado: "pareamento" });
  expect(await renovarSeNecessario(c, falso({ ok: false, tipo: "offline" }).renovar, T0 + 10 * DIA)).toEqual({ estado: "falhou" });
  expect(c.lerTudo()).toEqual({ token: "hs_antigo", emitidaEm: T0 });
});

test("sem credencial não chama a API", async () => {
  const api = falso({ ok: true, token: NOVO });
  expect(await renovarSeNecessario(credencial(), api.renovar, T0)).toEqual({ estado: "sem-credencial" });
  expect(api.chamadas).toEqual([]);
});

test("credencial gravada antes da data existir (só o token) é renovada", async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), "desktop-renova-")), "credencial.bin");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(arquivo, cripto.encryptString("hs_legado"));
  const c = criarCredencial(arquivo, cripto);
  expect(c.lerTudo()).toEqual({ token: "hs_legado", emitidaEm: null });
  const api = falso({ ok: true, token: NOVO });
  expect(await renovarSeNecessario(c, api.renovar, T0)).toEqual({ estado: "renovada", token: NOVO });
  expect(api.chamadas).toEqual(["hs_legado"]);
});

test("falha ao guardar o token novo: segue com ele na memória e avisa", async () => {
  const c = credencial();
  c.salvar("hs_antigo", T0);
  const quebrada = { ...c, salvar: () => { throw new Error("disco cheio"); } };
  expect(await renovarSeNecessario(quebrada, falso({ ok: true, token: NOVO }).renovar, T0 + 8 * DIA)).toEqual({ estado: "renovada", token: NOVO, erroAoGuardar: "disco cheio" });
});
