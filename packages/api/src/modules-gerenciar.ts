import type { ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { MODULE_ID_RE, caminhoRealDePasta, checkReviewerPassphrase, hasReviewerPassphrase, loadConfig, validarConfigDoModulo, type Brain, type ModuleEntry, type ResultadoConfig, type ResumoDoModulo, type SessionStoreOptions } from "@brain/core";
import type { ModuleDef } from "@brain/module-sdk";
import { BrainError, type Principal } from "@brain/shared";
import type { ModulesApiOptions } from "./modules.js";

/** Resultado do `brain modules check --json` rodado num processo filho (Tarefa 1). `ok` reflete só as causas do módulo. */
export interface ResultadoConferencia { ok: boolean; causas: string[]; resumo?: ResumoDoModulo; config?: ResultadoConfig }
/** Confere a pasta (e a config, quando vem) sem carregar nada no serve: `conferirEmProcessoFilho`, da CLI. */
export type Conferir = (caminho: string, config?: unknown) => Promise<ResultadoConferencia>;

const TICKET_MS = 15 * 60_000;
const MAX_TICKETS = 50;
const JANELA_FRASE_MS = 60_000;
const MAX_ERROS_FRASE = 5;
const REINICIO = "O brain serve será reiniciado para aplicar as alterações.";
const MSG_ADICIONADO = `Módulo adicionado. ${REINICIO}`;

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const mesmoHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function responder(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

/** Ticket de conferência: emitido por `inspecionar` para a pasta conferida e a sessão que conferiu. */
interface Ticket { caminhoReal: string; sessaoHash: string; expira: number }

export interface ReqGerenciar {
  metodo: string; body: unknown; res: ServerResponse;
  /** sub-rota depois de `/api/modules/_gerenciar` (`/inspecionar`, `/<id>`...) */
  sub: string;
  /** a sessão humana `full` que chama (a matriz já recusou as outras credenciais) */
  who: Principal;
  /** token da sessão apresentado: o ticket guarda só o hash dele */
  token: string;
}

/**
 * Rotas `/api/modules/_gerenciar/*` (spec de gerenciar módulos §7.2, §7.3): adicionar, configurar, ligar/desligar, remover e
 * reiniciar. Estado só em memória deste processo (tickets e tentativas de frase-senha): reiniciar o serve invalida os tickets.
 * Toda gravação passa por `Brain.setModuleEntry` (lock, auditoria `config_update`); nada aqui toca a pasta ou o estado do módulo.
 */
export class GerenciarModulos {
  private readonly tickets = new Map<string, Ticket>();
  private errosFrase: number[] = [];
  private readonly agora: () => number;

  constructor(private readonly brain: Brain, private readonly o: ModulesApiOptions, private readonly sessions: SessionStoreOptions | undefined) {
    this.agora = o.relogio ?? Date.now;
  }

  async tratar(r: ReqGerenciar): Promise<true> {
    const { metodo, sub } = r;
    if (sub === "/inspecionar" && metodo === "POST") return this.inspecionar(r);
    if (sub === "/adicionar" && metodo === "POST") return this.adicionar(r);
    if (sub === "/reiniciar" && metodo === "POST") return this.responderEReiniciar(r.res, { mensagem: "O brain serve será reiniciado." });
    const m = /^\/([^/]+)$/.exec(sub);
    if (m && (metodo === "PUT" || metodo === "DELETE")) {
      const id = m[1]!;
      if (!MODULE_ID_RE.test(id)) throw new BrainError("not_found", `módulo "${id}" não está configurado`);
      return metodo === "PUT" ? this.atualizar(r, id) : this.remover(r, id);
    }
    throw new BrainError("not_found", `rota ${metodo} /api/modules/_gerenciar${sub}`);
  }

  // ---- frase-senha (adicionar e ligar) ----

  /**
   * Exige a frase-senha do revisor quando ela existe. Até 5 erros por janela de 60 s neste processo; passou disso, 429 até a
   * janela passar, mesmo com a frase certa. `true` = já respondeu (recusa).
   */
  private recusaFrase(res: ServerResponse, frase: unknown): boolean {
    if (!hasReviewerPassphrase(this.sessions)) return false;
    const agora = this.agora();
    this.errosFrase = this.errosFrase.filter((t) => agora - t < JANELA_FRASE_MS);
    if (this.errosFrase.length >= MAX_ERROS_FRASE) return responder(res, 429, { error: "tentativas", message: "muitas tentativas de frase-senha; espere um minuto e tente de novo" });
    if (typeof frase !== "string" || !frase) return responder(res, 403, { error: "frase_senha", message: "este vault exige a frase-senha do revisor" });
    if (checkReviewerPassphrase(frase, this.sessions)) return false;
    this.errosFrase.push(agora);
    return responder(res, 403, { error: "frase_senha", message: "frase-senha incorreta" });
  }

  // ---- tickets ----

  private emitirTicket(caminhoReal: string, token: string): string {
    this.descartarExpirados();
    // teto: os mais antigos saem primeiro (a ordem de inserção do Map)
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!);
    const t = randomBytes(32).toString("base64url");
    this.tickets.set(t, { caminhoReal, sessaoHash: sha(token), expira: this.agora() + TICKET_MS });
    return t;
  }

  /** Ticket vivo emitido para esta mesma sessão; `undefined` = inexistente (outro processo), expirado ou de outra sessão. */
  private ticketValido(ticket: unknown, token: string): Ticket | undefined {
    this.descartarExpirados();
    if (typeof ticket !== "string" || !ticket) return undefined;
    const t = this.tickets.get(ticket);
    return t && mesmoHash(t.sessaoHash, sha(token)) ? t : undefined;
  }

  private descartarExpirados(): void {
    const agora = this.agora();
    for (const [k, t] of this.tickets) if (t.expira <= agora) this.tickets.delete(k);
  }

  // ---- rotas ----

  private async inspecionar(r: ReqGerenciar): Promise<true> {
    const b = corpo(r.body);
    if (typeof b.caminho !== "string" || !b.caminho.trim()) throw new BrainError("invalid", "informe o caminho da pasta do módulo");
    // a frase vem antes de qualquer código da pasta rodar (é aqui que a conferência carrega o módulo)
    if (this.recusaFrase(r.res, b.fraseSenha)) return true;
    const real = caminhoRealDePasta(b.caminho);
    const c = await this.conferir()(real);
    const ticket = c.ok ? this.emitirTicket(real, r.token) : undefined;
    return responder(r.res, 200, { ok: c.ok, causas: c.causas, resumo: c.resumo, caminho: real, ...(ticket ? { ticket } : {}) });
  }

  private async adicionar(r: ReqGerenciar): Promise<true> {
    const b = corpo(r.body);
    const t = this.ticketValido(b.ticket, r.token);
    if (!t) return responder(r.res, 409, { error: "ticket_invalido", message: "a conferência expirou ou é de outra sessão; confira a pasta de novo" });
    const soNestaMaquina = opcionalBool(b.soNestaMaquina, "soNestaMaquina");
    const config = b.config === undefined ? {} : b.config;
    // o código pode ter mudado desde a conferência: confere de novo, agora com a config, e o id vem daqui
    const c = await this.conferir()(t.caminhoReal, config);
    if (!c.ok || !c.resumo) return responder(r.res, 400, { error: "modulo_invalido", message: "a pasta deixou de ser um módulo válido; confira de novo", causas: c.causas });
    const id = c.resumo.id;
    const existente = this.modulosEmDisco()[id];
    if (existente) return responder(r.res, 409, { error: "id_existente", message: `o módulo "${id}" já está configurado`, caminho: existente.path });
    const erros = await this.errosDaConfig(config, c.config);
    if (erros) return responder(r.res, 400, { error: "config_invalida", erros });
    const entrada = { enabled: true, path: t.caminhoReal, config, ...(soNestaMaquina ? { host: hostname() } : {}) } as ModuleEntry;
    await this.brain.setModuleEntry(id, entrada, r.who);
    this.tickets.delete(String(b.ticket));
    return this.responderEReiniciar(r.res, { mensagem: MSG_ADICIONADO });
  }

  private async atualizar(r: ReqGerenciar, id: string): Promise<true> {
    const b = corpo(r.body);
    const atual = this.modulosEmDisco()[id];
    if (!atual) throw new BrainError("not_found", `módulo "${id}" não está configurado`);
    const enabled = opcionalBool(b.enabled, "enabled");
    const soNestaMaquina = opcionalBool(b.soNestaMaquina, "soNestaMaquina");
    if (b.config === undefined && enabled === undefined && soNestaMaquina === undefined) throw new BrainError("invalid", "nada para mudar (config, enabled ou soNestaMaquina)");
    // ligar (inclusive junto com a config) é como adicionar: exige a frase quando existe
    if (enabled === true && atual.enabled === false && this.recusaFrase(r.res, b.fraseSenha)) return true;
    if (b.config !== undefined) {
      // só confere pelo schema o módulo cujo código já roda neste serve; falho, ausente ou desligado: só o detector de segredos
      const m = this.o.registry.get(id);
      const carrega = !!m?.def && !!m.dir && !!this.o.conferir;
      const c = carrega ? await this.o.conferir!(m.dir, b.config) : undefined;
      const erros = await this.errosDaConfig(b.config, c?.ok ? c.config : undefined);
      if (erros) return responder(r.res, 400, { error: "config_invalida", erros });
    }
    const { host: _host, ...semHost } = atual;
    const proxima = {
      ...(soNestaMaquina === false ? semHost : atual),
      ...(soNestaMaquina ? { host: hostname() } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(b.config !== undefined ? { config: b.config } : {}),
    } as ModuleEntry;
    await this.brain.setModuleEntry(id, proxima, r.who);
    return this.responderEReiniciar(r.res, { mensagem: `Módulo atualizado. ${REINICIO}` });
  }

  private async remover(r: ReqGerenciar, id: string): Promise<true> {
    if (!this.modulosEmDisco()[id]) throw new BrainError("not_found", `módulo "${id}" não está configurado`);
    // só a entrada da config: a pasta e o estado do módulo ficam (adicionar de novo recupera tudo)
    await this.brain.setModuleEntry(id, null, r.who);
    return this.responderEReiniciar(r.res, { mensagem: `Módulo removido. ${REINICIO}` });
  }

  // ---- apoio ----

  private conferir(): Conferir {
    if (!this.o.conferir) throw new BrainError("state_unavailable", "a conferência de módulos só existe no brain serve");
    return this.o.conferir;
  }

  /**
   * Bloco `modules` do config.yaml em disco (edições manuais depois da subida contam). Ilegível: recusa com a mesma mensagem
   * do `setModuleEntry` (decidir pela cópia da memória podia, por exemplo, deixar adicionar um id que o arquivo já tem).
   */
  private modulosEmDisco(): Record<string, ModuleEntry> {
    try { return loadConfig(this.brain.vault.configPath).modules; }
    catch { throw new BrainError("invalid", "o .brain/config.yaml tem um erro de edição; corrija-o antes de mudar os módulos"); }
  }

  /**
   * Erros da config: os da conferência (schema do módulo + segredos) e, sempre, o detector de segredos local (vale também
   * quando o módulo não pôde ser conferido). `undefined` = pode gravar.
   */
  private async errosDaConfig(config: unknown, conferida: ResultadoConfig | undefined): Promise<Array<{ campo: string; mensagem: string }> | undefined> {
    const erros = conferida && !conferida.ok ? [...conferida.erros] : [];
    const local = await validarConfigDoModulo(SEM_SCHEMA, config);
    if (!local.ok) for (const e of local.erros) if (!erros.some((x) => x.campo === e.campo)) erros.push(e);
    return erros.length ? erros : undefined;
  }

  /**
   * Responde ANTES de reiniciar: o fechamento da API derruba todas as conexões. Sem `reiniciarServe` (API fora do `brain
   * serve`), a resposta pede o reinício manual. Recusa depois da resposta (o serve ainda subindo ou encerrando) só vai ao log;
   * a UI percebe pelo pid, que não muda.
   */
  private responderEReiniciar(res: ServerResponse, corpo: Record<string, unknown>): true {
    const reiniciar = this.o.reiniciarServe;
    if (!reiniciar) return responder(res, 200, { ...corpo, reiniciar: true });
    res.on("finish", () => {
      reiniciar().catch((e: unknown) => { console.error(`[api] reinício do brain serve recusado: ${(e as Error)?.message ?? String(e)}`); });
    });
    return responder(res, 200, corpo);
  }
}

/** Definição sem schema: `validarConfigDoModulo` fica só com o detector de segredos (mensagem e campo iguais aos do módulo). */
const SEM_SCHEMA = {} as ModuleDef;

const corpo = (b: unknown): Record<string, unknown> => (b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {});
function opcionalBool(v: unknown, nome: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new BrainError("invalid", `${nome} deve ser verdadeiro ou falso`);
  return v;
}
