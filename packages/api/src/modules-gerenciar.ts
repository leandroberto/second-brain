import type { ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { MODULE_ID_RE, caminhoRealDePasta, checkReviewerPassphrase, hasReviewerPassphrase, loadConfig, resolveModuleDir, validarConfigDoModulo, writeFileAtomic, type Brain, type BrainConfig, type ModuleEntry, type ResultadoConfig, type ResumoDoModulo, type SessionStoreOptions } from "@brain/core";
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
const MAX_CONFERENCIAS = 2;
/** Horários dos erros de frase-senha, em `modulesStateRoot`: o limite sobrevive ao reinício do serve. */
const ARQUIVO_ERROS_FRASE = "_frase-erros.json";
const REINICIO = "O brain serve será reiniciado para aplicar as alterações.";
const MSG_ADICIONADO = `Módulo adicionado. ${REINICIO}`;
const MSG_YAML = "o .brain/config.yaml tem um erro de edição; corrija-o antes de mudar os módulos";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const mesmoHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function responder(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

/** Recusa com status e corpo próprios (`frase_senha`, `tentativas`, `id_existente`...), respondida por `tratar`. */
class Recusa extends Error {
  constructor(readonly status: number, readonly corpo: Record<string, unknown>) { super(String(corpo.error)); }
}

/** Ticket de conferência: emitido por `inspecionar` para a pasta conferida e a sessão que conferiu. */
interface Ticket { caminhoReal: string; sessaoHash: string; expira: number }

/** `tem` = frase gravada; `ausente` = `review.passphrase_required` sem a frase nesta máquina (falha fechada); `nao` = sem frase. */
type ModoFrase = "tem" | "ausente" | "nao";

/** O módulo roda NESTA máquina com esta entrada (ligado e sem `host` de outra máquina). */
const carregaAqui = (e: ModuleEntry): boolean => e.enabled !== false && (!e.host || e.host === hostname());

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
 * reiniciar. Tickets e o contador de conferências ficam em memória deste processo (reiniciar invalida os tickets); os erros de
 * frase-senha ficam num arquivo do estado (o limite sobrevive ao reinício). Toda gravação passa por `Brain.setModuleEntry` com
 * um atualizador (lido dentro do lock, auditoria `config_update`); nada aqui toca a pasta ou o estado do módulo.
 */
export class GerenciarModulos {
  private readonly tickets = new Map<string, Ticket>();
  private conferencias = 0;
  private readonly agora: () => number;
  private readonly arquivoErros: string;

  constructor(private readonly brain: Brain, private readonly o: ModulesApiOptions, private readonly sessions: SessionStoreOptions | undefined) {
    this.agora = o.relogio ?? Date.now;
    this.arquivoErros = join(o.root, ARQUIVO_ERROS_FRASE);
  }

  async tratar(r: ReqGerenciar): Promise<true> {
    try { return await this.rotear(r); }
    catch (e) { if (e instanceof Recusa) return responder(r.res, e.status, e.corpo); throw e; }
  }

  private async rotear(r: ReqGerenciar): Promise<true> {
    const { metodo, sub } = r;
    if (sub === "/inspecionar" && metodo === "POST") return this.inspecionar(r);
    if (sub === "/adicionar" && metodo === "POST") return this.adicionar(r);
    if (sub === "/reiniciar" && metodo === "POST") {
      this.recusarReinicioComErrosDeFrase();
      return this.responderEReiniciar(r.res, { mensagem: "O brain serve será reiniciado." });
    }
    const m = /^\/([^/]+)$/.exec(sub);
    if (m && (metodo === "PUT" || metodo === "DELETE")) {
      const id = m[1]!;
      if (!MODULE_ID_RE.test(id)) throw new BrainError("not_found", `módulo "${id}" não está configurado`);
      return metodo === "PUT" ? this.atualizar(r, id) : this.remover(r, id);
    }
    throw new BrainError("not_found", `rota ${metodo} /api/modules/_gerenciar${sub}`);
  }

  // ---- frase-senha (adicionar e ligar) ----

  private modoFrase(): ModoFrase {
    if (hasReviewerPassphrase(this.sessions)) return "tem";
    let exigida = this.brain.config.review.passphrase_required;
    try { exigida = loadConfig(this.brain.vault.configPath).review.passphrase_required; } catch { /* yaml com erro: vale o da memória */ }
    return exigida ? "ausente" : "nao";
  }

  /**
   * Erros de frase-senha dentro da janela. Arquivo ausente = nenhum; ilegível (diretório no lugar, sem permissão, conteúdo que não
   * é a lista) = `"ilegivel"`: o limite falha fechado, senão as tentativas deixariam de contar.
   */
  private errosNaJanela(): number[] | "ilegivel" {
    const agora = this.agora();
    let v: unknown;
    try { v = JSON.parse(readFileSync(this.arquivoErros, "utf8")); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : "ilegivel"; }
    if (!Array.isArray(v)) return "ilegivel";
    return v.filter((t): t is number => typeof t === "number" && agora - t < JANELA_FRASE_MS && t <= agora);
  }

  private gravarErros(erros: number[]): void { writeFileAtomic(this.arquivoErros, JSON.stringify(erros), 0o600); }

  /**
   * Exige a frase-senha do revisor quando ela existe (ou é exigida pela config e falta: recusa sempre). Até 5 erros por janela de
   * 60 s; passou disso, 429 até a janela passar, mesmo com a frase certa. A tentativa é registrada como erro ANTES de a frase ser
   * conferida: sem conseguir registrar, 429 sem conferir (certa e errada respondem igual; nada de tentativa sem limite). A frase
   * certa zera a janela (só quem a conhece zera); se zerar falhar, segue sem bloquear o dono. Síncrono do começo ao fim: duas
   * requisições deste processo não intercalam a leitura e a gravação do registro.
   */
  private exigirFrase(frase: unknown): void {
    const modo = this.modoFrase();
    if (modo === "nao") return;
    if (modo === "ausente") throw new Recusa(403, { error: "frase_senha", motivo: "ausente", message: "este vault exige a frase-senha do revisor, mas ela não foi encontrada nesta máquina" });
    const erros = this.errosNaJanela();
    if (erros === "ilegivel") throw registroIlegivel(this.arquivoErros);
    if (erros.length >= MAX_ERROS_FRASE) throw new Recusa(429, { error: "tentativas", message: "muitas tentativas de frase-senha; espere um minuto e tente de novo" });
    if (typeof frase !== "string" || !frase) throw new Recusa(403, { error: "frase_senha", motivo: "exigida", message: "este vault exige a frase-senha do revisor" });
    try { this.gravarErros([...erros, this.agora()]); }
    catch { throw new Recusa(429, { error: "tentativas", message: "não foi possível registrar a tentativa; tente mais tarde" }); }
    if (!checkReviewerPassphrase(frase, this.sessions)) throw new Recusa(403, { error: "frase_senha", motivo: "errada", message: "frase-senha incorreta" });
    try { this.gravarErros([]); } catch { /* segue: a tentativa registrada sai da janela sozinha */ }
  }

  /** Com frase-senha errada na janela, nada reinicia o serve (um reinício não serve para escapar do limite). */
  private recusarReinicioComErrosDeFrase(): void {
    const erros = this.errosNaJanela();
    if (erros === "ilegivel") { if (this.modoFrase() === "tem") throw registroIlegivel(this.arquivoErros); return; }
    if (erros.length) throw new Recusa(429, { error: "tentativas", message: "houve frase-senha errada há pouco; espere um minuto antes de mudar os módulos ou reiniciar o brain serve" });
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

  /**
   * Retira do mapa o ticket vivo emitido para esta mesma sessão (um segundo `adicionar` simultâneo com ele já não o acha);
   * `undefined` = inexistente (outro processo), expirado ou de outra sessão (este continua no mapa, para a sessão dona).
   */
  private tomarTicket(ticket: unknown, token: string): Ticket | undefined {
    this.descartarExpirados();
    if (typeof ticket !== "string" || !ticket) return undefined;
    const t = this.tickets.get(ticket);
    if (!t || !mesmoHash(t.sessaoHash, sha(token))) return undefined;
    this.tickets.delete(ticket);
    return t;
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
    this.exigirFrase(b.fraseSenha);
    const real = caminhoRealDePasta(b.caminho);
    const c = await this.conferir(real);
    const ticket = c.ok ? this.emitirTicket(real, r.token) : undefined;
    return responder(r.res, 200, { ok: c.ok, causas: c.causas, resumo: c.resumo, caminho: real, ...(ticket ? { ticket } : {}) });
  }

  private async adicionar(r: ReqGerenciar): Promise<true> {
    this.recusarReinicioComErrosDeFrase();
    const b = corpo(r.body);
    const soNestaMaquina = opcionalBool(b.soNestaMaquina, "soNestaMaquina");
    const config = b.config === undefined ? {} : b.config;
    const t = this.tomarTicket(b.ticket, r.token);
    if (!t) throw new Recusa(409, { error: "ticket_invalido", message: "a conferência expirou ou é de outra sessão; confira a pasta de novo" });
    // o ticket volta ao mapa só quando dá para tentar de novo com ele (config inválida, conferências demais)
    let devolver = false;
    try {
      // o código pode ter mudado desde a conferência: confere de novo, agora com a config, e o id vem daqui
      let c: ResultadoConferencia;
      try { c = await this.conferir(t.caminhoReal, config); }
      catch (e) { devolver = e instanceof Recusa && e.status === 429; throw e; }
      if (!c.ok || !c.resumo) throw new Recusa(400, { error: "modulo_invalido", message: "a pasta deixou de ser um módulo válido; confira de novo", causas: c.causas });
      const id = c.resumo.id;
      const existente = this.modulosEmDisco()[id];
      if (existente) throw idExistente(id, existente);
      const erros = await this.errosDaConfig(config, c.config);
      if (erros) { devolver = true; throw new Recusa(400, { error: "config_invalida", erros }); }
      const entrada = { enabled: true, path: t.caminhoReal, config, ...(soNestaMaquina ? { host: hostname() } : {}) } as ModuleEntry;
      await this.gravar(id, (atual) => { if (atual) throw idExistente(id, atual); return entrada; }, r.who);
    } catch (e) {
      if (devolver && !this.tickets.has(String(b.ticket))) this.tickets.set(String(b.ticket), t);
      throw e;
    }
    return this.responderEReiniciar(r.res, { mensagem: MSG_ADICIONADO });
  }

  private async atualizar(r: ReqGerenciar, id: string): Promise<true> {
    const b = corpo(r.body);
    const enabled = opcionalBool(b.enabled, "enabled");
    const soNestaMaquina = opcionalBool(b.soNestaMaquina, "soNestaMaquina");
    if (b.config === undefined && enabled === undefined && soNestaMaquina === undefined) throw new BrainError("invalid", "nada para mudar (config, enabled ou soNestaMaquina)");
    const atual = this.modulosEmDisco()[id];
    if (!atual) throw new BrainError("not_found", `módulo "${id}" não está configurado`);

    const aplicar = (e: ModuleEntry): ModuleEntry => {
      const { host: _host, ...semHost } = e;
      return {
        ...(soNestaMaquina === false ? semHost : e),
        ...(soNestaMaquina ? { host: hostname() } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(b.config !== undefined ? { config: b.config } : {}),
      } as ModuleEntry;
    };
    const liga = (antes: ModuleEntry) => ampliaOndeRoda(antes, aplicar(antes));
    const modo = this.modoFrase();
    let fraseValida = false;
    if (liga(atual)) { this.exigirFrase(b.fraseSenha); fraseValida = modo === "tem"; }
    // depois da frase: a certa zera os erros, e quem a digitou errado antes não fica preso
    this.recusarReinicioComErrosDeFrase();

    if (b.config !== undefined) {
      // rodar o código (num filho) para validar pelo schema só quando já está autorizado: sem frase no vault, ligando com a frase
      // ou já rodando aqui. Configurar um desligado num vault com frase: só o detector de segredos (o loader valida ao ligar)
      const autorizado = modo === "nao" || fraseValida || carregaAqui(atual);
      const dir = autorizado ? pastaDoModulo(id, atual) : undefined;
      const c = dir ? await this.conferir(dir, b.config) : undefined;
      // não carrega (falho, ausente): grava sem o schema
      const erros = await this.errosDaConfig(b.config, c?.ok ? c.config : undefined);
      if (erros) throw new Recusa(400, { error: "config_invalida", erros });
    }
    await this.gravar(id, (fresca) => {
      if (!fresca) throw new BrainError("not_found", `módulo "${id}" não está configurado`);
      // a entrada mudou desde a leitura e agora este PUT ligaria o módulo: só com a frase já conferida
      if (liga(fresca) && modo !== "nao" && !fraseValida) throw new Recusa(403, { error: "frase_senha", motivo: "exigida", message: "este vault exige a frase-senha do revisor" });
      return aplicar(fresca);
    }, r.who);
    return this.responderEReiniciar(r.res, { mensagem: `Módulo atualizado. ${REINICIO}` });
  }

  private async remover(r: ReqGerenciar, id: string): Promise<true> {
    this.recusarReinicioComErrosDeFrase();
    // só a entrada da config: a pasta e o estado do módulo ficam (adicionar de novo recupera tudo)
    await this.gravar(id, (atual) => {
      if (!atual) throw new BrainError("not_found", `módulo "${id}" não está configurado`);
      return null;
    }, r.who);
    return this.responderEReiniciar(r.res, { mensagem: `Módulo removido. ${REINICIO}` });
  }

  // ---- apoio ----

  /** No máximo 2 conferências (processos filhos) ao mesmo tempo neste processo; a 3ª → 429. */
  private async conferir(caminho: string, config?: unknown): Promise<ResultadoConferencia> {
    const conferir = this.o.conferir;
    if (!conferir) throw new BrainError("state_unavailable", "a conferência de módulos só existe no brain serve");
    if (this.conferencias >= MAX_CONFERENCIAS) throw new Recusa(429, { error: "conferencias", message: "já há conferências de módulo em andamento; tente de novo em instantes" });
    this.conferencias++;
    try { return await conferir(caminho, config); } finally { this.conferencias--; }
  }

  private async gravar(id: string, atualizar: (atual: ModuleEntry | undefined) => ModuleEntry | null, who: Principal): Promise<BrainConfig> {
    return this.brain.setModuleEntry(id, atualizar, who);
  }

  /**
   * Bloco `modules` do config.yaml em disco (edições manuais depois da subida contam). Ilegível: recusa com a mesma mensagem
   * do `setModuleEntry` (decidir pela cópia da memória podia, por exemplo, deixar adicionar um id que o arquivo já tem).
   */
  private modulosEmDisco(): Record<string, ModuleEntry> {
    try { return loadConfig(this.brain.vault.configPath).modules; }
    catch { throw new BrainError("invalid", MSG_YAML); }
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

/**
 * "Ligar" (exige a frase quando existe) = qualquer mudança que AMPLIE onde o módulo roda: desligado → ligado (em qualquer host:
 * num vault sincronizado ele passa a rodar na máquina do `host`); passa a rodar nesta máquina; ou, ligado, perde ou troca o
 * `host` (passa a rodar em outras máquinas do vault). Restringir (pôr o `host` desta máquina, desligar) não é ligar.
 */
function ampliaOndeRoda(antes: ModuleEntry, depois: ModuleEntry): boolean {
  if (antes.enabled === false && depois.enabled !== false) return true;
  if (carregaAqui(depois) && !carregaAqui(antes)) return true;
  return depois.enabled !== false && antes.enabled !== false && !!antes.host && depois.host !== antes.host;
}

const registroIlegivel = (arquivo: string) =>
  new Recusa(429, { error: "tentativas", message: `o registro de tentativas de frase-senha está ilegível (${arquivo}); apague-o para liberar` });

const idExistente = (id: string, e: ModuleEntry) => new Recusa(409, { error: "id_existente", message: `o módulo "${id}" já está configurado`, caminho: e.path });

/** Pasta do módulo como o loader a resolve; `undefined` se não resolve ou não existe (não carrega: nada a conferir). */
function pastaDoModulo(id: string, e: ModuleEntry): string | undefined {
  try { const dir = resolveModuleDir(id, e); return existsSync(dir) ? dir : undefined; } catch { return undefined; }
}

/** Definição sem schema: `validarConfigDoModulo` fica só com o detector de segredos (mensagem e campo iguais aos do módulo). */
const SEM_SCHEMA = {} as ModuleDef;

const corpo = (b: unknown): Record<string, unknown> => (b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {});
function opcionalBool(v: unknown, nome: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new BrainError("invalid", `${nome} deve ser verdadeiro ou falso`);
  return v;
}
