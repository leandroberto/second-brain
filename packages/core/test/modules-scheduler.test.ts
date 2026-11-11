import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleContext, ModuleDef, Tarefa, TarefaContext } from "@brain/module-sdk";
import { ModuleRegistry, Scheduler, parseCron } from "../src/index.js";

const L = (a: number, m: number, d: number, h = 0, mi = 0) => new Date(a, m - 1, d, h, mi, 0, 0);
const esperar = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const abertos: Scheduler[] = [];
afterEach(async () => { await Promise.all(abertos.splice(0).map((s) => s.stop())); });

function montar(tarefa: Partial<Tarefa> & { rodar: Tarefa["rodar"] }, inicial: Date, estado?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "brain-sched-"));
  if (estado) writeFileSync(join(root, "_scheduler.json"), JSON.stringify(estado));
  const t: Tarefa = { id: "t", quando: "0 8 * * *", ...tarefa };
  const reg = new ModuleRegistry(root);
  const def = { sdk: 1, id: "mod", nome: "Mod", versao: "1", tarefas: [t] } as ModuleDef;
  reg.add({ id: "mod", def, dir: root, status: "ativo", ctx: {} as ModuleContext });
  const relogio = { agora: inicial };
  const s = new Scheduler(reg, root, { agora: () => relogio.agora, tickMs: 10 });
  abertos.push(s);
  return { s, reg, root, relogio };
}

describe("parseCron", () => {
  it("next/prev em hora local", () => {
    const c = parseCron("30 8 * * 1-5");
    expect(c.next(L(2026, 11, 13, 9, 0))).toEqual(L(2026, 11, 16, 8, 30)); // sexta -> segunda
    expect(c.prev(L(2026, 11, 16, 8, 29))).toEqual(L(2026, 11, 13, 8, 30));
    expect(c.prev(L(2026, 11, 16, 8, 30))).toEqual(L(2026, 11, 16, 8, 30));
    const q = parseCron("*/15 * * * *");
    expect(q.next(L(2026, 11, 11, 10, 14))).toEqual(L(2026, 11, 11, 10, 15));
    expect(q.next(L(2026, 11, 11, 10, 45))).toEqual(L(2026, 11, 11, 11, 0));
  });
  it("lista, passo com início, domingo 0 e 7, dia do mês OU dia da semana", () => {
    expect(parseCron("0 0 1,15 * *").next(L(2026, 11, 2))).toEqual(L(2026, 11, 15));
    expect(parseCron("5/20 * * * *").next(L(2026, 11, 11, 10, 6))).toEqual(L(2026, 11, 11, 10, 25));
    // 2026-11-15 é domingo
    expect(parseCron("0 0 * * 7").next(L(2026, 11, 11))).toEqual(L(2026, 11, 15));
    expect(parseCron("0 0 * * 0").next(L(2026, 11, 11))).toEqual(L(2026, 11, 15));
    // dia 13 OU segunda: de qua 11 chega primeiro na sexta 13
    expect(parseCron("0 0 13 * 1").next(L(2026, 11, 11))).toEqual(L(2026, 11, 13));
    expect(parseCron("0 0 13 * 1").next(L(2026, 11, 13))).toEqual(L(2026, 11, 16));
    expect(parseCron("0 0 29 2 *").next(L(2026, 11, 11))).toEqual(L(2028, 2, 29));
  });
  it("expressão inválida lança invalid", () => {
    for (const e of ["* * * *", "* * * * * *", "", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "5-1 * * * *", "a * * * *", "* * * * 8"]) {
      expect(() => parseCron(e), e).toThrowError(expect.objectContaining({ code: "invalid" }));
    }
  });
});

describe("Scheduler", () => {
  it("primeira subida não roda", async () => {
    let n = 0;
    const { s, relogio } = montar({ recuperar: true, rodar: async () => { n++; } }, L(2026, 11, 11, 9));
    s.start();
    await esperar(); expect(n).toBe(0);
    expect(relogio.agora).toEqual(L(2026, 11, 11, 9));
    expect(s.status("mod")[0]!.ultimaOcorrencia).toBe(L(2026, 11, 11, 8).toISOString());
  });

  it("roda quando uma ocorrência nova chega", async () => {
    let n = 0;
    // passo de relógio menor que 3 × tickMs: tick normal, sem salto
    const { s, relogio } = montar({ rodar: async () => { n++; } }, new Date(L(2026, 11, 12, 8).getTime() - 10));
    s.start(); await esperar(); expect(n).toBe(0);
    relogio.agora = L(2026, 11, 12, 8, 0);
    await esperar(); expect(n).toBe(1);
    await esperar(); expect(n).toBe(1);
  });

  it("recupera uma vez só, com a ocorrência mais recente que ficou para trás", async () => {
    const ocs: Date[] = [];
    const estado = { "mod/t": { ultimaOcorrencia: L(2026, 11, 8, 8).toISOString(), suspensa: false, errosSeguidos: 0 } };
    const { s } = montar({ recuperar: true, rodar: async (c: TarefaContext) => { ocs.push(c.ocorrencia); } }, L(2026, 11, 11, 9), estado);
    s.start();
    await esperar(150);
    expect(ocs).toEqual([L(2026, 11, 11, 8)]);
  });

  it("recuperar false não recupera, mas as próximas rodam", async () => {
    let n = 0;
    const estado = { "mod/t": { ultimaOcorrencia: L(2026, 11, 8, 8).toISOString(), suspensa: false, errosSeguidos: 0 } };
    const { s, relogio } = montar({ recuperar: false, rodar: async () => { n++; } }, L(2026, 11, 11, 9), estado);
    s.start(); await esperar(); expect(n).toBe(0);
    relogio.agora = new Date(L(2026, 11, 12, 8).getTime() - 10);
    await esperar(); expect(n).toBe(0);
    relogio.agora = L(2026, 11, 12, 8, 0);
    await esperar(); expect(n).toBe(1);
  });

  it("falha não gera nova tentativa", async () => {
    let n = 0;
    const estado = { "mod/t": { ultimaOcorrencia: L(2026, 11, 8, 8).toISOString(), suspensa: false, errosSeguidos: 0 } };
    const { s, reg } = montar({ recuperar: true, rodar: async () => { n++; throw new Error("boom"); } }, L(2026, 11, 11, 9), estado);
    s.start(); await esperar(150);
    expect(n).toBe(1);
    const st = s.status("mod")[0]!;
    expect(st.resultado).toBe("erro"); expect(st.erro).toBe("boom"); expect(st.errosSeguidos).toBe(1);
    expect(reg.errors("mod")[0]).toMatchObject({ onde: "tarefa:t", mensagem: "boom" });
  });

  it("grava o marcador antes de rodar (queda do processo não repete)", async () => {
    const estado = { "mod/t": { ultimaOcorrencia: L(2026, 11, 8, 8).toISOString(), suspensa: false, errosSeguidos: 0 } };
    let visto: { ultimaOcorrencia?: string; inicio?: string } | undefined;
    const { s, root } = montar({ recuperar: true, rodar: async () => { visto = JSON.parse(readFileSync(join(root, "_scheduler.json"), "utf8"))["mod/t"]; } }, L(2026, 11, 11, 9), estado);
    s.start(); await esperar(100);
    expect(visto?.ultimaOcorrencia).toBe(L(2026, 11, 11, 8).toISOString());
    expect(visto?.inicio).toBeTruthy();
  });

  it("sem sobreposição: runNow durante execução devolve erro", async () => {
    let solta!: () => void;
    const { s } = montar({ rodar: () => new Promise<void>((r) => { solta = r; }) }, L(2026, 11, 11, 9));
    const p = s.runNow("mod", "t");
    await esperar(5);
    expect(await s.runNow("mod", "t")).toEqual({ resultado: "erro", erro: "já em execução" });
    solta();
    expect((await p).resultado).toBe("ok");
  });

  it("timeout aborta o sinal", async () => {
    let sinal!: AbortSignal;
    const { s } = montar({ timeoutS: 0.05, rodar: (c: TarefaContext) => { sinal = c.sinal; return new Promise<void>(() => undefined); } }, L(2026, 11, 11, 9));
    const r = await s.runNow("mod", "t");
    expect(r.resultado).toBe("timeout");
    expect(sinal.aborted).toBe(true);
    expect(s.status("mod")[0]!.resultado).toBe("timeout");
  });

  it("suspende após 5 erros; runNow reativa e zera", async () => {
    let falha = true; let n = 0;
    const { s, relogio } = montar({ recuperar: true, rodar: async () => { n++; if (falha) throw new Error("x"); } }, L(2026, 11, 11, 9));
    s.start(); await esperar();
    for (let d = 12; d <= 16; d++) { relogio.agora = L(2026, 11, d, 8, 0); await esperar(); }
    expect(n).toBe(5);
    expect(s.status("mod")[0]).toMatchObject({ suspensa: true, errosSeguidos: 5 });
    relogio.agora = L(2026, 11, 17, 8, 0); await esperar();
    expect(n).toBe(5); // suspensa não roda
    falha = false;
    expect((await s.runNow("mod", "t")).resultado).toBe("ok");
    expect(s.status("mod")[0]).toMatchObject({ suspensa: false, errosSeguidos: 0 });
  });

  it("salto de relógio recupera uma vez; sem recuperar só marca", async () => {
    let n = 0, m = 0;
    const a = montar({ recuperar: true, rodar: async () => { n++; } }, L(2026, 11, 11, 9));
    const b = montar({ recuperar: false, rodar: async () => { m++; } }, L(2026, 11, 11, 9));
    a.s.start(); b.s.start(); await esperar(40);
    a.relogio.agora = L(2026, 11, 13, 9); b.relogio.agora = L(2026, 11, 13, 9);
    await esperar(60);
    expect(n).toBe(1); expect(m).toBe(0);
    expect(b.s.status("mod")[0]!.ultimaOcorrencia).toBe(L(2026, 11, 13, 8).toISOString());
  });

  it("runNow sem ocorrência usa a última atendida e não a altera", async () => {
    const ocs: Date[] = [];
    const { s } = montar({ rodar: async (c: TarefaContext) => { ocs.push(c.ocorrencia); } }, L(2026, 11, 11, 9));
    s.start(); await esperar();
    await s.runNow("mod", "t");
    await s.runNow("mod", "t", L(2026, 1, 1, 8));
    expect(ocs).toEqual([L(2026, 11, 11, 8), L(2026, 1, 1, 8)]);
    expect(s.status("mod")[0]!.ultimaOcorrencia).toBe(L(2026, 11, 11, 8).toISOString());
  });

  it("runNow em módulo inativo ou tarefa inexistente lança not_found", async () => {
    const { s, reg } = montar({ rodar: async () => undefined }, L(2026, 11, 11, 9));
    await expect(s.runNow("mod", "nao")).rejects.toMatchObject({ code: "not_found" });
    reg.get("mod")!.status = "falho";
    await expect(s.runNow("mod", "t")).rejects.toMatchObject({ code: "not_found" });
  });

  it("stop aborta execuções em andamento e aguarda", async () => {
    let sinal!: AbortSignal;
    const { s } = montar({ rodar: (c: TarefaContext) => { sinal = c.sinal; return new Promise<void>(() => undefined); } }, L(2026, 11, 11, 9));
    const p = s.runNow("mod", "t");
    await esperar(5);
    await s.stop();
    expect(sinal.aborted).toBe(true);
    expect((await p).resultado).toBe("erro");
  });
});
