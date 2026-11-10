import { BrainError, type Actor, type Channel, type NoteType, type Principal, type Proposal } from "@brain/shared";
import type { BrainConfig } from "./config.js";
import { checkReviewerPassphrase, hasReviewerPassphrase, isHumanSession, type SessionStoreOptions } from "./sessions.js";

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
  if ((kind as string) === "human" || HUMAN_CHANNELS.has(channel)) throw new BrainError("forbidden", "identidade humana só vem de sessão humana válida ou de terminal interativo (humanFromSession/humanFromTerminal)");
  if (kind === "system" && channel === "seed") throw new BrainError("forbidden", "use seedPrincipal() (só vale num vault DEMO)");
  return mint(kind, name, channel);
}
/** Canal do vault DEMO (`brain seed`): escreve direto, mas o Core só aceita num vault marcado como demo. */
export const seedPrincipal = () => mint("system", "demo-seed", "seed");

/** Humano pela UI: o token apresentado é uma sessão válida (hash no armazenamento de sessões, dentro da validade). */
export function humanFromSession(vault: string, token: string, name: string, o: SessionStoreOptions = {}): Principal | undefined {
  return isHumanSession(vault, token, o) ? mint("human", name, "ui") : undefined;
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
/** Canais em que um HUMANO decide (revisão). `cli` comum não é: agentes chamam a CLI. */
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
  | "admin";         // config, revert, commit de edições manuais

const deny = (msg: string): never => { throw new BrainError("forbidden", msg); };

export function authorize(who: unknown, op: Operation, ctx: { config: BrainConfig; proposal?: Proposal; resolution?: string; type?: NoteType } ): Principal {
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
      if (who.kind === "agent" && ctx.proposal) { assertAgentMayCommit(ctx.config, ctx.proposal, ctx.resolution); return who; }
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
    case "admin": if (human) return who; return deny("operação administrativa: exige o revisor humano (UI com sessão humana ou brain admin)");
  }
}

/** Política opcional por tipo (ADR 0011): desligada por padrão; conflito e substituição SEMPRE exigem humano. */
function assertAgentMayCommit(config: BrainConfig, p: Proposal, resolution?: string) {
  const pol = config.agents.commit_policy;
  if (pol === "never") deny("política do vault: agentes não podem persistir; aprove na Review Queue");
  if (p.analysis.classification === "conflict" || resolution === "replace" || resolution === "update") deny("conflitos, atualizações e substituições sempre exigem revisão humana");
  if (p.maintenance) deny("propostas de manutenção (revalidação/título) exigem revisão humana");
  if ((config.agents.per_type[p.draft.type] ?? "review") !== "auto") deny(`política do vault: o tipo "${p.draft.type}" exige revisão humana`);
  if (pol === "new_only" && !(p.analysis.classification === "new" && resolution === "create")) deny("política do vault: agentes só persistem conhecimento classificado como 'new'");
}
