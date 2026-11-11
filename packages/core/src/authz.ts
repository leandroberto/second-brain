import { BrainError, type Actor, type Channel, type NoteType, type Principal, type Proposal } from "@brain/shared";
import type { BrainConfig } from "./config.js";
import { checkReviewerPassphrase, hasReviewerPassphrase, sessionScope, type SessionStoreOptions } from "./sessions.js";

/**
 * Autorização no CORE: toda operação mutativa passa por `authorize(quem, operação, contexto)`, qualquer que seja o adapter
 * (MCP, API, CLI, UI). A identidade é ator + canal e só vale se foi CUNHADA por `principal()` — um objeto vindo de JSON/HTTP
 * ({kind:"human"}) nunca é aceito, e chamar o Core sem identidade é negado.
 *
 * Modelo de ameaça (local): protege os caminhos SUPORTADOS contra agentes bem-comportados, erros e pedidos ambíguos ("aprove
 * tudo"). Um processo do mesmo usuário do SO pode sempre editar os arquivos do vault direto (o Git registra); isolamento real
 * exigiria separação no SO e está fora do escopo. Por isso a identidade humana só nasce de um canal que um agente não usa por
 * acidente: sessão humana da UI (emitida num terminal interativo) ou CLI administrativa (terminal interativo + confirmação).
 */
const MINTED = new WeakSet<object>();

function mint(kind: Actor["kind"], name: string, channel: Channel): Principal {
  const p: Principal = Object.freeze({ kind, name: name.slice(0, 80) || "desconhecido", channel });
  MINTED.add(p);
  return p;
}
/**
 * Identidades de AGENTE e de SISTEMA (adapters, importador, manutenção). Humano NÃO nasce aqui: só de uma sessão válida
 * (`humanFromSession`) ou de um terminal real (`humanFromTerminal`, com a frase-senha do revisor quando definida).
 */
export function principal(kind: "agent" | "system", name: string, channel: Channel): Principal {
  // "desktop" também é canal humano (restrito): só nasce de uma sessão com escopo desktop
  if ((kind as string) === "human" || HUMAN_CHANNELS.has(channel) || channel === "desktop") throw new BrainError("forbidden", "identidade humana só vem de sessão humana válida ou de terminal interativo (humanFromSession/humanFromTerminal)");
  if (kind === "system" && channel === "seed") throw new BrainError("forbidden", "use seedPrincipal() (só vale num vault DEMO)");
  return mint(kind, name, channel);
}
/** Canal do vault DEMO (`brain seed`): escreve direto, mas o Core só aceita num vault marcado como demo. */
export const seedPrincipal = () => mint("system", "demo-seed", "seed");

/**
 * Humano pela UI: o token apresentado é uma sessão válida (hash no armazenamento de sessões, dentro da validade). Sessão de
 * escopo `full` → canal `ui` (revisor); de escopo `desktop` → canal `desktop` (só `propose`/`read`/`assist`).
 */
export function humanFromSession(vault: string, token: string, name: string, o: SessionStoreOptions = {}): Principal | undefined {
  const scope = sessionScope(vault, token, o);
  return scope ? mint("human", name, scope === "desktop" ? "desktop" : "ui") : undefined;
}
/**
 * Humano pelo terminal: stdin e stdout precisam ser TTY de verdade (ferramentas de agente e scripts não têm) e, se o revisor
 * definiu uma frase-senha, ela é pedida. Sem frase-senha a barreira é só o terminal — `brain doctor` avisa.
 */
export async function humanFromTerminal(io: { ask(q: string, o?: { hidden?: boolean }): Promise<string>; user: string; sessions?: SessionStoreOptions }, what: string, o: { passphraseRequired?: boolean } = {}): Promise<Principal> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new BrainError("forbidden", `"${what}" é uma ação privilegiada e exige um terminal interativo (stdin/stdout TTY). Agentes e scripts não podem executá-la: peça ao usuário que rode o comando num terminal, ou que decida pela UI.`);
  // o vault exige frase-senha: sem o arquivo do revisor (HOME/armazenamento trocado), nega — nunca cai para "só terminal"
  if (o.passphraseRequired && !hasReviewerPassphrase(io.sessions)) throw new BrainError("forbidden", "este vault exige a frase-senha do revisor, mas ela não foi encontrada neste ambiente (HOME/armazenamento diferente?)");
  if (hasReviewerPassphrase(io.sessions)) {
    const pass = await io.ask("Frase-senha do revisor: ", { hidden: true });
    if (!checkReviewerPassphrase(pass, io.sessions)) throw new BrainError("forbidden", "frase-senha incorreta");
  }
  return mint("human", io.user, "cli-admin");
}
export const isPrincipal = (p: unknown): p is Principal => !!p && typeof p === "object" && MINTED.has(p);
/** Canais em que um HUMANO decide (revisão). `cli` comum não é: agentes chamam a CLI. `desktop` também não: é a credencial restrita do atalho. */
export const HUMAN_CHANNELS: ReadonlySet<Channel> = new Set(["ui", "cli-admin"]);
export const isHumanReviewer = (p: Principal) => p.kind === "human" && HUMAN_CHANNELS.has(p.channel);
/** Leitor anônimo do próprio processo (logs de leitura sem identidade): nunca escreve. */
export const INTERNAL_READER = mint("system", "core", "internal");

export type Operation =
  | "read" | "propose"
  | "amend"          // corrigir o rascunho de uma proposta pendente
  | "decide"         // aprovar/ignorar/substituir (inclui lote)
  | "write"          // criar/editar nota direto (sem proposta)
  | "link"           // relação entre notas
  | "verify"         // anexar verificação de atualidade (calculada pelo sistema)
  | "assist"         // assistente: capturar, perguntar, reprocessar, desfazer captura (revisor ou humano do desktop)
  | "admin";         // config, revert, commit de edições manuais

const deny = (msg: string): never => { throw new BrainError("forbidden", msg); };

export function authorize(who: unknown, op: Operation, ctx: { config: BrainConfig; proposal?: Proposal; resolution?: string; type?: NoteType; target?: { id: string; type: NoteType } } ): Principal {
  if (!isPrincipal(who)) return deny(`operação "${op}" sem identidade confiável (o adapter precisa informar quem age); negado por padrão`);
  const human = isHumanReviewer(who);
  switch (op) {
    case "read": case "propose": return who;
    case "amend": {
      if (human) return who;
      // o agente corrige a PRÓPRIA proposta antes da revisão (título ruim, texto inseguro); a de outro agente/humano, não
      const p = ctx.proposal;
      if (who.kind === "agent" && p && p.proposed_by.kind === "agent" && p.proposed_by.name === who.name) return who;
      return deny("só o revisor humano (UI/CLI admin) ou o agente autor da proposta pode alterar o rascunho");
    }
    case "decide": {
      if (human) return who;
      if (who.kind === "agent" && ctx.proposal) { assertAgentMayCommit(who, ctx.config, ctx.proposal, ctx.resolution, ctx.target); return who; }
      return deny(who.kind === "human"
        ? `decidir propostas exige um canal humano de revisão (UI com sessão humana ou "brain admin" num terminal); canal atual: ${who.channel}`
        : "política do vault: agentes e processos do sistema não decidem propostas; a revisão é humana");
    }
    case "write": if (human || (who.kind === "system" && who.channel === "seed")) return who; return deny("escrita direta de conhecimento é só do revisor humano; agentes usam brain_propose");
    case "link":
      if (human || (who.kind === "system" && who.channel === "seed")) return who;
      // relação é escrita no Markdown: além de can_link, exige que o vault aceite persistência de agentes (padrão: never)
      if (who.kind === "agent" && ctx.config.agents.can_link && ctx.config.agents.commit_policy !== "never") return who;
      return deny("política do vault: agentes não gravam relações (proponha-as no texto; o revisor cria a relação)");
    case "verify": if (human || (who.kind === "system" && (who.channel === "importer" || who.channel === "maintenance"))) return who; return deny("a verificação de atualidade é calculada pelo sistema, não informada por quem chama");
    case "assist": if (human || (who.kind === "human" && who.channel === "desktop")) return who; return deny("o assistente é usado pelo revisor humano ou pelo atalho desktop (sessão desktop); agentes e processos do sistema não o acionam");
    case "admin": if (human) return who; return deny("operação administrativa: exige o revisor humano (UI com sessão humana ou brain admin)");
  }
}

/**
 * Sob `additive` (ADR 0014), a única combinação classificação → resolução que um agente aplica. A classificação é a do Core
 * (heurística independente; a dica do agente só escala), nunca a que o agente declara.
 */
export const ADDITIVE_RESOLUTION: Readonly<Partial<Record<Proposal["analysis"]["classification"], "create" | "complement" | "ignore">>> = Object.freeze({ new: "create", complement: "complement", duplicate: "ignore" });

/** Política opcional por tipo (ADR 0011/0014): desligada por padrão; conflito e substituição SEMPRE exigem humano. */
function assertAgentMayCommit(who: Principal, config: BrainConfig, p: Proposal, resolution?: string, target?: { id: string; type: NoteType }) {
  const pol = config.agents.commit_policy;
  if (pol === "never") deny("política do vault: agentes não podem persistir; aprove na Review Queue");
  if (p.analysis.classification === "conflict" || resolution === "replace" || resolution === "update") deny("conflitos, atualizações e substituições sempre exigem revisão humana");
  if (p.maintenance) deny("propostas de manutenção (revalidação/título) exigem revisão humana");
  if (pol === "additive") {
    // as decisões da fila continuam humanas: o agente só decide a PRÓPRIA proposta (nunca a de humano, do importador ou de outro agente)
    if (p.proposed_by.kind !== "agent" || p.proposed_by.name !== who.name) deny("política do vault (additive): o agente só decide as próprias propostas; as demais são decididas pelo revisor humano");
    // `p.analysis` aqui é a classificação feita SEM confiança na dica (o Core reclassifica antes de autorizar; ver resolveLocked)
    if (!resolution || ADDITIVE_RESOLUTION[p.analysis.classification] !== resolution) deny(`política do vault (additive): agentes só aplicam new→create, complement→complement e duplicate→ignore; "${p.analysis.classification}" com "${resolution ?? "?"}" exige revisão humana`);
    // tipo sem entrada vale "auto"; "review" explícito é a válvula para tipos sensíveis
    if (config.agents.per_type[p.draft.type] === "review") deny(`política do vault: o tipo "${p.draft.type}" exige revisão humana`);
    if (resolution === "complement") {
      // o complemento só vai para o alvo que o Core analisou, e a nota alterada também não pode ser de um tipo marcado "review"
      if (!target || target.id !== p.analysis.target_id) deny("política do vault (additive): o agente só complementa o alvo da análise do Core");
      if (config.agents.per_type[target!.type] === "review") deny(`política do vault: notas do tipo "${target!.type}" exigem revisão humana para serem alteradas`);
    }
    return;
  }
  if ((config.agents.per_type[p.draft.type] ?? "review") !== "auto") deny(`política do vault: o tipo "${p.draft.type}" exige revisão humana`);
  if (pol === "new_only" && !(p.analysis.classification === "new" && resolution === "create")) deny("política do vault: agentes só persistem conhecimento classificado como 'new'");
}
