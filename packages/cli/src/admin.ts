import { createInterface } from "node:readline";
import { Brain, humanFromTerminal, issueHumanSession, revokeHumanSessions, setReviewerPassphrase, type SessionStoreOptions } from "@brain/core";
import type { Principal } from "@brain/shared";

/**
 * Ações PRIVILEGIADAS da CLI (decidir propostas, commit de edições manuais, emitir sessão humana da UI).
 * Barreira: terminal interativo (stdin e stdout TTY — ferramentas de agente e scripts não têm) + frase-senha do revisor, se
 * definida (`brain admin passphrase`) + confirmação digitada. Não é autenticação corporativa: é o mínimo para que "aprovar" nunca
 * aconteça por um comando que um agente rode por acidente ou por um pedido ambíguo.
 */
export interface AdminIO {
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  out(line: string): void;
  user: string;
  sessions?: SessionStoreOptions;
}

export interface HiddenInput { buf: string; pending?: string; done?: boolean; abort?: boolean }
const ESC = String.fromCharCode(27);
// teclas especiais: CSI (ESC [ … final, ex. setas) e SS3 (ESC O x, setas no modo "application cursor" do tmux)
const ESCAPE_SEQ = new RegExp(`^${ESC}(?:\\[[0-9;]*[A-Za-z~]|O.)`);
const ESCAPE_PREFIX = new RegExp(`^${ESC}(?:\\[[0-9;]*|O)?$`); // sequência cortada no fim do bloco: continua no próximo
/**
 * Um bloco lido em modo raw, caractere a caractere (por code point): colar "frase⏎" chega num bloco só e o Enter não pode
 * entrar na frase. Teclas especiais e caracteres de controle (C0, DEL, C1) não são texto; o que vier depois do Enter é descartado.
 */
export function hiddenInput(buf: string, chunk: string, pending = ""): HiddenInput {
  const text = pending + chunk;
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC) {
      const rest = text.slice(i);
      const seq = ESCAPE_SEQ.exec(rest);
      if (seq) { i += seq[0].length; continue; }
      if (ESCAPE_PREFIX.test(rest)) return { buf, pending: rest };
      i += 1; continue; // ESC solto
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!); i += ch.length;
    if (ch === "\r" || ch === "\n" || ch === "\u0004") return { buf, done: true };
    if (ch === "\u0003") return { buf, abort: true };
    if (ch === "\u007f" || ch === "\b") buf = [...buf].slice(0, -1).join("");
    else if (ch >= " " && !(ch >= "\u0080" && ch <= "\u009f")) buf += ch;
  }
  return { buf };
}

/** `promptTo`: onde saem avisos e prompts (stderr quando o stdout é só para um valor, como o token do `pair-desktop`). */
export function realIO(promptTo: NodeJS.WriteStream = process.stdout): AdminIO {
  return {
    user: process.env.BRAIN_USER ?? process.env.USER ?? "user",
    out: (l) => { if (promptTo === process.stdout) console.log(l); else promptTo.write(`${l}\n`); },
    ask: (q, o) => new Promise((resolve) => {
      if (!o?.hidden) { const rl = createInterface({ input: process.stdin, output: promptTo }); rl.question(q, (a) => { rl.close(); resolve(a.trim()); }); return; }
      // entrada oculta (frase-senha): modo raw, sem eco
      promptTo.write(q); const stdin = process.stdin; let st: HiddenInput = { buf: "" };
      stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding("utf8");
      const on = (chunk: string) => {
        st = hiddenInput(st.buf, chunk, st.pending);
        if (st.abort) {
          stdin.setRawMode?.(false); promptTo.write("\n");
          // Ctrl+C no modo raw não gera SIGINT: quem trata o sinal (o `brain serve`, que precisa fechar) o recebe; senão, sai
          if (process.listenerCount("SIGINT") > 0) { stdin.off("data", on); stdin.pause(); process.emit("SIGINT", "SIGINT"); return; }
          process.exit(130);
        }
        if (st.done) { stdin.setRawMode?.(false); stdin.pause(); stdin.off("data", on); promptTo.write("\n"); resolve(st.buf); }
      };
      stdin.on("data", on);
    }),
  };
}

/** Garante que há um humano no terminal (TTY real + frase-senha, se definida); devolve a identidade de revisor (canal cli-admin). */
export const requireHuman = (io: AdminIO, what: string, brain?: Brain): Promise<Principal> => humanFromTerminal(io, what, { passphraseRequired: brain?.config.review.passphrase_required });
async function confirm(io: AdminIO, summary: string[]): Promise<boolean> {
  for (const l of summary) io.out(l);
  return (await io.ask("Confirmar? digite 'sim': ")).toLowerCase() === "sim";
}

export async function adminCommand(brain: Brain, args: string[], flags: { note?: string; eligible?: boolean; port?: number }, io: AdminIO): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "approve": case "ignore": {
      const pending = brain.listProposals("pending");
      const ids = flags.eligible && sub === "approve" ? pending.filter((p) => Brain.bulkEligible(p, brain.config.governance.candidate_threshold)).map((p) => p.id) : rest;
      const chosen = ids.map((id) => pending.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
      if (!chosen.length) { io.out("nenhuma proposta pendente correspondente"); return 1; }
      const who = await requireHuman(io, `brain admin ${sub}`, brain);
      if (!(await confirm(io, [`${sub === "approve" ? "APROVAR (criar conhecimento)" : "IGNORAR"} ${chosen.length} proposta(s):`, ...chosen.slice(0, 30).map((p) => `  ${p.id}  ${p.analysis.classification.padEnd(10)} ${p.draft.title.slice(0, 80)}`), ...(chosen.length > 30 ? [`  … e mais ${chosen.length - 30}`] : [])]))) { io.out("cancelado"); return 1; }
      if (sub === "ignore") { const r = await brain.ignoreMany(chosen.map((p) => p.id), flags.note, who); io.out(`ignoradas: ${r.ignored}${r.commit ? ` (commit ${r.commit})` : ""}`); return 0; }
      // uma a uma, com a resolução SUGERIDA pela análise (create/complement/update...): o lote "new" usa approveMany
      let ok = 0; const fails: string[] = [];
      for (const p of chosen) {
        try { await brain.resolve(p.id, { resolution: p.analysis.suggested_resolution === "ignore" ? "create" : p.analysis.suggested_resolution, target_id: p.analysis.target_id, note: flags.note }, who); ok++; }
        catch (e) { fails.push(`${p.id}: ${(e as Error).message}`); }
      }
      io.out(`aprovadas: ${ok} de ${chosen.length}`); for (const f of fails) io.out(`  falhou ${f}`);
      return fails.length ? 1 : 0;
    }
    case "commit": {
      const who = await requireHuman(io, "brain admin commit", brain);
      const dirty = await brain.git.dirty("knowledge");
      if (!dirty.length) { io.out("nada a commitar"); return 0; }
      if (!(await confirm(io, [`commitar ${dirty.length} arquivo(s) editado(s) à mão:`, ...dirty.slice(0, 20).map((f) => `  ${f}`)]))) { io.out("cancelado"); return 1; }
      const r = await brain.commitPending(rest.join(" ") || undefined, who);
      io.out(r.commit ? `commit ${r.commit} (${r.files.length} arquivos)${r.skipped.length ? ` — ${r.skipped.length} com possível segredo ficaram de fora` : ""}` : "nada a commitar"); return 0;
    }
    case "ui": {
      const who = await requireHuman(io, "brain ui", brain);
      const t = issueHumanSession(brain.vault.root, who, { ...io.sessions, label: "brain ui" });
      io.out(`UI com permissão de revisão (válida por 30 dias; não compartilhe):\nhttp://127.0.0.1:${flags.port ?? 3737}/#token=${t}`); return 0;
    }
    case "revoke-sessions": { const who = await requireHuman(io, "brain admin revoke-sessions", brain); io.out(`sessões humanas revogadas: ${revokeHumanSessions(brain.vault.root, who, io.sessions)}`); return 0; }
    case "passphrase": {
      const who = await requireHuman(io, "brain admin passphrase", brain);
      const a = await io.ask("Nova frase-senha do revisor (mín. 8): ", { hidden: true });
      if (a.length < 8) { io.out("frase-senha: mínimo 8 caracteres (nada foi alterado)"); return 1; }
      const b = await io.ask("Repita: ", { hidden: true });
      if (a !== b) { io.out("as frases não conferem (nada foi alterado)"); return 1; }
      setReviewerPassphrase(a, who, io.sessions);
      // registrado no vault (versionado): a partir daqui, sem a frase-senha a ação é negada mesmo se o arquivo do revisor sumir
      await brain.updateConfig({ review: { passphrase_required: true } }, who);
      io.out("frase-senha definida: brain ui e brain admin passam a pedi-la (e o vault passa a exigi-la)"); return 0;
    }
    default:
      io.out("uso: brain admin <approve <id...>|--eligible | ignore <id...> [--note texto] | commit [mensagem] | ui | revoke-sessions | passphrase>");
      return 2;
  }
}
