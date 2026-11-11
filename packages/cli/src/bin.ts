#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Assistant, Brain, createClaudeEngine, bundleHistory, loadConfig, auditTitles, migrateFlat, importPath, importText, knowledgeAudit, reconcilePending, revalidateNotes, type ImportReport } from "@brain/core";
import type { Freshness } from "@brain/shared";
import { startApi } from "@brain/api";
import { humanFromTerminal, issueHumanSession, principal } from "@brain/core";
import { runStdio } from "@brain/mcp";
import { BrainError, NOTE_TYPES, type NoteType } from "@brain/shared";
import { integrate, policyPlan } from "./integrate.js";
import { printChecks, runDoctor } from "./doctor.js";
import { seedDemo } from "./seed.js";
import { adminCommand, realIO, requireHuman } from "./admin.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
/** Identidade do build em execução (o doctor compara com o build em disco para avisar "reinicie o brain serve"). */
export function buildInfo(): { commit?: string; id?: string } {
  let commit: string | undefined; try { commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* fora do git */ }
  let id: string | undefined; try { id = String(Math.round(statSync(join(REPO_ROOT, "packages/core/dist/brain.js")).mtimeMs)); } catch { /* sem build */ }
  return { commit, id };
}
/** Prova de humano no terminal respeitando a exigência de frase-senha registrada no vault (se o vault existir). */
async function humanHere(what: string) {
  let required = false; try { required = loadConfig(join(vaultPath(), ".brain", "config.yaml")).review.passphrase_required; } catch { /* vault ausente */ }
  return humanFromTerminal(realIO(), what, { passphraseRequired: required });
}
const tpl = (p: string) => { try { return readFileSync(join(REPO_ROOT, "templates", p), "utf8"); } catch { return undefined; } };

const HELP = `brain — Second Brain CLI

Uso: brain <comando> [opções]

  init [caminho]        cria um vault (Markdown+Git). Padrão: ~/second-brain
  mcp                   servidor MCP via stdio (Claude Code, Codex, ...)
  serve                 API local + UI web (http://127.0.0.1:3737); num terminal interativo já imprime a URL de revisão
  pair-desktop          emite a credencial do atalho desktop (escopo restrito: só assistente) e imprime SÓ o token (terminal interativo)
  ui                    emite uma sessão HUMANA da UI e imprime a URL (só em terminal interativo)
  doctor                diagnóstico completo (vault, Git, SQLite, FTS, API, MCP, integrações)
  health                status de git/índice/embeddings
  search <texto>        busca no terminal
  backup-history        grava o histórico git em .brain/backup/history.bundle (pula se não mudou)
  reindex               reconstrói o índice SQLite a partir do Markdown
  review                lista propostas pendentes (somente leitura)
  admin <ação>          AÇÕES PRIVILEGIADAS (terminal interativo + frase-senha do revisor, se definida + confirmação):
                          approve <id...> | approve --eligible · ignore <id...> [--note t] · commit [mensagem]
                          ui · revoke-sessions · passphrase
  commit [mensagem]     atalho de "admin commit" (commita edições manuais pendentes)
  import <caminho|->    analisa repo/pasta/arquivo .md (ou texto via stdin com "-") e cria PROPOSTAS (nada entra direto)
                        opções: --project slug  --dry-run  --max N  --include-duplicates  --git-log  --loose  --show-rejected  --show-evidence
  reconcile <repo>      reverifica a ATUALIDADE das propostas pendentes vindas desse repositório (somente leitura;
                        --apply grava só a verificação nas propostas pendentes; nunca aprova nem altera rascunhos)
  revalidate <repo>     reverifica o conhecimento APROVADO ligado ao repositório contra o HEAD (somente leitura; --apply cria
                        PROPOSTAS de revalidação com a evidência — nunca altera notas)
  maintain titles       detecta títulos pouco recuperáveis e sugere outros (somente leitura; --apply cria propostas)
  audit                 métricas de saúde da base (atual/histórico/temporal/incerto/títulos/órfãs/duplicatas) — somente leitura
  update-policy         atualiza AGENTS.md e a skill do vault a partir dos templates (e os blocos globais do Codex/Claude);
                        --dry-run mostra o que mudaria sem gravar
  seed [caminho]        cria um vault DEMO separado (dados fictícios)
  migrate-flat <pasta>  migra um vault antigo (pastas por tema, cabeçalho titulo/tags/criado/atualizado) preservando o texto;
                        dry-run por padrão (mostra a tabela e o type sugerido); --apply grava num único commit (só humano, em terminal);
                        --type id=tipo corrige o tipo sugerido (repetível)
  integrate             dry-run da integração Claude Code/Codex; --apply aplica (com backup); --remove desfaz

Opções globais: --vault <dir> (ou BRAIN_VAULT)  --agent <nome>  --port <n>

Governança: agentes (MCP, API com o api-token, CLI comum) leem e PROPÕEM; decidir é do humano (UI com sessão humana ou brain admin).
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { vault: { type: "string" }, agent: { type: "string" }, port: { type: "string" }, apply: { type: "boolean" }, remove: { type: "boolean" }, host: { type: "string" }, name: { type: "string" }, help: { type: "boolean", short: "h" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, max: { type: "string" }, "include-duplicates": { type: "boolean" }, "git-log": { type: "boolean" }, loose: { type: "boolean" }, "show-rejected": { type: "boolean" }, "show-evidence": { type: "boolean" }, project: { type: "string" }, eligible: { type: "boolean" }, note: { type: "string" }, type: { type: "string", multiple: true } },
});

function vaultPath(explicit?: string): string {
  const fromCfg = () => { try { return (JSON.parse(readFileSync(join(homedir(), ".config", "second-brain", "config.json"), "utf8")) as { vault?: string }).vault; } catch { return undefined; } };
  return resolve(explicit ?? values.vault ?? process.env.BRAIN_VAULT ?? fromCfg() ?? join(homedir(), "second-brain"));
}

function printImport(r: ImportReport) {
  console.log(`${r.dry_run ? "[DRY-RUN] " : ""}Import ${r.run} — ${r.repo}${r.project ? ` (projeto ${r.project})` : ""}`);
  console.log(`  arquivos lidos: ${r.files} · candidatos: ${r.candidates} · seções sem sinal ignoradas: ${r.skipped_sections} · quase-idênticos descartados: ${r.dropped_similar}`);
  const sk = Object.entries(r.skipped_files); if (sk.length) console.log(`  arquivos ignorados: ${sk.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`  classificação: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}`);
  if (r.freshness) console.log(`  atualidade${r.freshness.against ? ` (verificada contra ${r.freshness.against})` : ""}: ${Object.entries(r.freshness.states).map(([k, v]) => `${k}=${v}`).join(" ") || "—"} · esforço de revisão: ${Object.entries(r.freshness.effort).map(([k, v]) => `${EFFORT[k] ?? k}=${v}`).join(" ")} · ${r.freshness.ms} ms`);
  if (r.rejected?.length) {
    const by: Record<string, number> = {}; for (const x of r.rejected) { const k = x.reason.replace(/\d+ de \d+ itens da lista não propostos:.*/, "itens de lista não propostos (curtos/detalhe de implementação/acima do limite)"); by[k] = (by[k] ?? 0) + 1; }
    console.log(`  descartados pelos filtros de qualidade: ${r.rejected.length} → ${Object.entries(by).map(([k, v]) => `${k} (${v})`).join("; ")}`);
    if (values["show-rejected"]) for (const x of r.rejected) console.log(`     ✗ ${x.title.slice(0, 60)} — ${x.reason}  ← ${x.source.path}${x.source.heading ? "#" + x.source.heading.slice(0, 40) : ""}`);
  }
  for (const it of r.items) {
    const a = it.analysis; const tag = it.status === "queued" ? "FILA " : it.status === "dry-run" ? "PROP " : it.status === "already-queued" ? "JÁ   " : it.status === "duplicate-skipped" ? "DUP  " : it.status === "over-limit" ? "LIMIT" : "REJ  ";
    const f = it.candidate.freshness;
    console.log(`  ${tag} ${a.classification.padEnd(10)} ${(f ? `${f.state}/${f.confidence}` : "—").padEnd(16)} ${it.candidate.type.padEnd(13)} ${it.candidate.title.slice(0, 60).padEnd(60)} ← ${it.source_ref}${it.reason ? `  (${it.reason})` : ""}`);
    if (f && values["show-evidence"]) printFreshness(f, "        ");
  }
  console.log(`\n${r.dry_run ? "Nada foi gravado. Remova --dry-run para criar propostas." : `${r.queued} proposta(s) na Review Queue. Revise em: brain ui`}`);
}

const EFFORT: Record<string, string> = { auto_clear: "evidência-clara", quick: "revisão-rápida", investigate: "investigar" };
function printFreshness(f: Freshness, pad: string) {
  console.log(`${pad}${f.summary} [intenção=${f.intent} implementação=${f.implementation} · sugestão=${f.suggestion} · ${EFFORT[f.effort] ?? f.effort}]`);
  for (const e of f.evidence) console.log(`${pad}  ${e.stance === "supports" ? "✓" : e.stance === "contradicts" ? "✗" : "·"} ${e.ref}: ${e.detail}`);
}

async function main() {
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help || cmd === "help") return console.log(HELP);
  switch (cmd) {
    case "init": {
      const root = vaultPath(rest[0]);
      const b = await Brain.init(root, { agentsMd: tpl("AGENTS.md"), skillMd: tpl("skills/second-brain/SKILL.md"), readme: tpl("README.vault.md") });
      const cfg = join(homedir(), ".config", "second-brain", "config.json");
      if (!existsSync(cfg)) { mkdirSync(dirname(cfg), { recursive: true }); writeFileSync(cfg, JSON.stringify({ vault: root }, null, 2)); }
      console.log(`Vault pronto em ${root}\nPróximos passos:\n  brain integrate          # Claude Code + Codex\n  brain serve              # UI em http://127.0.0.1:3737\n  Obsidian: "Open folder as vault" → ${root}`);
      b.close(); break;
    }
    case "mcp": await runStdio(vaultPath(), values.agent ?? process.env.BRAIN_AGENT); break; // permanece vivo
    case "serve": {
      const b = await Brain.open(vaultPath());
      const webRoot = join(REPO_ROOT, "apps/web/dist");
      // assistente: o motor roda `claude -p` com o MCP deste mesmo cli (`brain mcp`) como única fonte de ferramentas
      const assistant = new Assistant(b, createClaudeEngine(b, undefined, { command: process.execPath, args: [fileURLToPath(import.meta.url), "mcp"] }));
      const h = await startApi(b, { port: Number(values.port ?? process.env.BRAIN_PORT ?? 3737), host: values.host, webRoot, build: buildInfo(), assistant });
      // só um humano num terminal recebe a URL de REVISÃO; iniciado por agente/script, a API sobe sem emitir sessão humana
      const io = realIO(); let reviewUrl: string | undefined;
      if (process.stdin.isTTY && process.stdout.isTTY) { try { const who = await requireHuman(io, "brain serve", b); reviewUrl = `${h.url}/#token=${issueHumanSession(b.vault.root, who, { label: "brain serve" })}`; } catch (e) { console.error(`(sem sessão de revisão: ${(e as Error).message})`); } }
      console.log(`Second Brain  ${reviewUrl ?? h.url}\nvault: ${b.vault.root}${reviewUrl ? "" : "\nPara revisar pela UI, rode num terminal: brain ui"}\n(Ctrl+C para sair — o MCP não depende deste processo)`);
      // capturas que ficaram pendentes (claude deslogado, queda): reprocessa em segundo plano, sem atrasar o listen
      assistant.retryPending().then(
        (n) => { console.log(`assistente: ${n} captura(s) pendente(s) processada(s) na subida`); },
        (e) => { console.error(`assistente: falha ao reprocessar capturas pendentes: ${(e as Error).message}`); },
      );
      const stop = async () => { await h.close(); b.close(); process.exit(0); };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      break;
    }
    case "pair-desktop": {
      // stdout leva SÓ o token (para colar uma vez no desktop); avisos e prompts vão para stderr
      const b = await Brain.open(vaultPath());
      try {
        const who = await requireHuman(realIO(process.stderr), "brain pair-desktop", b);
        const token = issueHumanSession(b.vault.root, who, { label: "desktop", scope: "desktop" });
        console.error("Credencial do desktop (válida por 30 dias; escopo restrito: capturar, perguntar e desfazer as próprias capturas). Cole-a uma vez no desktop e não a compartilhe:");
        console.log(token);
      } finally { b.close(); }
      break;
    }
    case "ui": { const b = await Brain.open(vaultPath()); process.exitCode = await adminCommand(b, ["ui"], { port: values.port ? Number(values.port) : undefined }, realIO()); b.close(); break; }
    case "admin": case "commit": {
      const b = await Brain.open(vaultPath());
      process.exitCode = await adminCommand(b, cmd === "commit" ? ["commit", ...rest] : rest, { note: values.note, eligible: !!values.eligible, port: values.port ? Number(values.port) : undefined }, realIO());
      b.close(); break;
    }
    case "health": { const b = await Brain.open(vaultPath()); const h = await b.health(); console.log(JSON.stringify({ ...h, details: undefined }, null, 2)); b.close(); if (!h.ok) process.exitCode = 1; break; }
    case "search": {
      const b = await Brain.open(vaultPath());
      const hits = await b.search(rest.join(" "), {}, 10);
      for (const h of hits) console.log(`${h.score.toFixed(2)}  [${h.type}] ${h.title}  (${h.id})\n      ${h.snippet}`);
      if (!hits.length) console.log("nenhum resultado");
      b.close(); break;
    }
    case "backup-history": { const b = await Brain.open(vaultPath()); const r = await bundleHistory(b); b.close(); console.log(r.skipped ? `backup do histórico: sem mudanças (${r.path})` : `backup do histórico gravado em ${r.path}`); break; }
    case "reindex": { const b = await Brain.open(vaultPath()); const r = await b.reindex(true); console.log(`reindexado: +${r.added.length} ~${r.changed.length} -${r.removed.length}, embeddings: ${r.embedded}`); b.close(); break; }
    case "review": {
      const b = await Brain.open(vaultPath());
      for (const p of b.listProposals()) console.log(`${p.id}  ${p.analysis.classification.padEnd(10)} ${p.proposed_by.name.padEnd(12)} ${p.draft.title}${p.analysis.target_id ? `  → ${p.analysis.target_id}` : ""}`);
      b.close(); break;
    }
    case "seed": {
      const root = resolve(rest[0] ?? join(REPO_ROOT, "seed", "demo-vault"));
      await seedDemo(root, { agentsMd: tpl("AGENTS.md"), skillMd: tpl("skills/second-brain/SKILL.md"), readme: tpl("README.vault.md") });
      console.log(`Vault DEMO (dados fictícios) em ${root}\nUse:  brain serve --vault ${root}`); break;
    }
    case "import": {
      const src = rest[0];
      if (!src) { console.error("uso: brain import <caminho|-> [--project slug] [--dry-run]"); process.exitCode = 2; break; }
      const b = await Brain.open(vaultPath());
      const opts = { project: values.project, dryRun: !!values["dry-run"], max: values.max ? Number(values.max) : undefined, includeDuplicates: !!values["include-duplicates"], gitLog: !!values["git-log"], loose: !!values.loose };
      let rep: ImportReport;
      if (src === "-") { const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c as Buffer); rep = await importText(b, Buffer.concat(chunks).toString("utf8"), opts); }
      else rep = await importPath(b, resolve(src), opts);
      if (values.json) console.log(JSON.stringify(rep, null, 2)); else printImport(rep);
      b.close(); break;
    }
    case "reconcile": {
      const src = rest[0];
      if (!src) { console.error("uso: brain reconcile <repo> [--project slug] [--apply] [--json]"); process.exitCode = 2; break; }
      const b = await Brain.open(vaultPath());
      const r = await reconcilePending(b, resolve(src), { apply: !!values.apply, project: values.project });
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.applied ? "" : "[SOMENTE LEITURA] "}Atualidade de ${r.items.length} proposta(s) pendente(s) de ${r.repo}${r.against ? ` — verificado contra ${r.against}` : ""} (${r.ms} ms)`);
        for (const it of r.items) { console.log(`  ${(it.freshness ? `${it.freshness.state}/${it.freshness.confidence}` : "—").padEnd(16)} ${it.title.slice(0, 70)}  ← ${it.path ?? "?"}`); if (it.freshness && values["show-evidence"]) printFreshness(it.freshness, "      "); }
        console.log(r.applied ? "\nVerificação gravada nas propostas pendentes (rascunhos e decisões intactos)." : "\nNada foi gravado. Use --apply para anexar a verificação às propostas pendentes.");
      }
      b.close(); break;
    }
    case "revalidate": {
      const src = rest[0];
      if (!src) { console.error("uso: brain revalidate <repo> [--project slug] [--apply] [--json]"); process.exitCode = 2; break; }
      const b = await Brain.open(vaultPath());
      const r = await revalidateNotes(b, resolve(src), { apply: !!values.apply, project: values.project });
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.applied ? "" : "[SOMENTE LEITURA] "}Revalidação de ${r.items.length} nota(s) ligadas a ${r.repo}${r.against ? ` — contra ${r.against}` : ""} (${r.ms} ms)`);
        for (const it of r.items) { console.log(`  ${it.needs ? "REVALIDAR" : "ok       "} ${(it.freshness ? `${it.freshness.state}/${it.freshness.confidence}` : "—").padEnd(16)} ${it.temporal ? "[temporal] " : ""}${it.title.slice(0, 70)}${it.proposal ? `  → ${it.proposal}` : it.skipped ? `  (${it.skipped})` : ""}`); if (it.freshness && (values["show-evidence"] || it.needs)) printFreshness(it.freshness, "      "); }
        const n = r.items.filter((x) => x.needs).length;
        console.log(r.applied ? `\n${r.items.filter((x) => x.proposal).length} proposta(s) de revalidação na Review Queue.` : `\n${n} precisam de revalidação. Nada foi gravado; use --apply para criar as propostas.`);
      }
      b.close(); break;
    }
    case "maintain": {
      if (rest[0] !== "titles") { console.error("uso: brain maintain titles [--project slug] [--apply] [--json]"); process.exitCode = 2; break; }
      const b = await Brain.open(vaultPath());
      const r = await auditTitles(b, { apply: !!values.apply, project: values.project });
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const it of r.items) console.log(`  ✗ ${it.title}\n    → ${it.suggestion}\n      (${it.issues.join("; ")})${it.proposal ? `  proposta ${it.proposal}` : it.skipped ? `  ${it.skipped}` : ""}`);
        console.log(`\n${r.items.length} título(s) pouco recuperáveis.${r.applied ? " Sugestões na Review Queue (Confirmar · Editar · Ignorar)." : " Nada foi gravado; use --apply para criar as propostas."}`);
      }
      b.close(); break;
    }
    case "audit": {
      const b = await Brain.open(vaultPath()); const a = await knowledgeAudit(b);
      if (values.json) console.log(JSON.stringify(a, null, 2));
      else console.log([`notas: ${a.total} (${Object.entries(a.by_status).map(([k, v]) => `${k}=${v}`).join(" ")})`, `atuais: ${a.current} · históricas: ${a.historical} · substituídas: ${a.superseded} · temporais: ${a.temporal} · incertas/conflito/planejadas: ${a.uncertain}`, `verificação: ${Object.entries(a.verification).map(([k, v]) => `${k}=${v}`).join(" ")}`, `títulos genéricos: ${a.generic_titles.length} · sem projeto: ${a.without_project.length} · órfãs: ${a.orphans.length} · relações explícitas: ${a.explicit_relations}`, `possíveis duplicatas fortes: ${a.possible_duplicates.length}${a.possible_duplicates.slice(0, 5).map((d) => `\n  ${d.a} ≈ ${d.b} (${d.similarity})`).join("")}`, `manutenção pendente: ${JSON.stringify(a.pending_maintenance)}`].join("\n"));
      b.close(); break;
    }
    case "migrate-flat": {
      const src = rest[0];
      if (!src) { console.error("uso: brain migrate-flat <pasta> [--apply] [--type id=tipo ...]"); process.exitCode = 2; break; }
      const typeOverrides: Record<string, NoteType> = {};
      for (const kv of values.type ?? []) {
        const [id, t] = kv.split("=");
        if (!id || !t || !(NOTE_TYPES as readonly string[]).includes(t)) { console.error(`--type inválido: "${kv}" (use id=tipo, com tipo em ${NOTE_TYPES.join(", ")})`); process.exitCode = 2; return; }
        typeOverrides[id] = t as NoteType;
      }
      const apply = !!values.apply && !values["dry-run"];
      const b = await Brain.open(vaultPath());
      // o dry-run não grava nada: não exige humano. Aplicar escreve conhecimento direto e move os originais: só o revisor, num terminal
      const who = apply ? await requireHuman(realIO(), "brain migrate-flat --apply", b) : undefined;
      const plan = await migrateFlat(b, resolve(src), who ?? principal("system", "migrate-flat", "cli"), { apply, typeOverrides });
      if (values.json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`${apply ? "" : "[DRY-RUN] "}Migração de ${resolve(src)} → ${b.vault.root}`);
        console.log(`  ${"id".padEnd(28)} ${"tipo".padEnd(10)} ${"projeto".padEnd(14)} origem → destino`);
        for (const it of plan.items) console.log(`  ${it.id.padEnd(28)} ${(it.type + (it.inferred ? "?" : "")).padEnd(10)} ${(it.project ?? "—").padEnd(14)} ${it.from} → ${it.to}  [${it.tags.join(", ")}]`);
        console.log(`  capturas → .brain/captures/: ${plan.captures.join(", ") || "—"}`);
        console.log(`  descartados (.desfazer): ${plan.discarded.join(", ") || "—"}`);
        console.log(apply
          ? `\n${plan.items.length} nota(s) migradas${plan.commit ? ` (commit ${plan.commit})` : ""}. Originais em _legado/ até você aprovar.`
          : "\nNada foi gravado. Os tipos com ? são sugestões: corrija com --type id=tipo. Aplicar (num terminal, como revisor): --apply");
      }
      b.close(); break;
    }
    case "integrate":
      // aplicar/remover muda a configuração GLOBAL do Claude Code e do Codex (e a política que eles leem): ação do revisor
      if (values.apply || values.remove) await humanHere(`brain integrate --${values.apply ? "apply" : "remove"}`);
      await integrate({ vault: vaultPath(), repoRoot: REPO_ROOT, apply: !!values.apply, remove: !!values.remove }); break;
    case "update-policy": {
      const vault = vaultPath();
      const files: Array<[string, string | undefined]> = [["AGENTS.md", tpl("AGENTS.md")], ["skills/second-brain/SKILL.md", tpl("skills/second-brain/SKILL.md")]];
      if (values["dry-run"]) { // só lê: mostra o que o revisor aplicaria
        const plan = policyPlan(vault, files);
        console.log("[SOMENTE LEITURA] brain update-policy mudaria:");
        for (const rel of plan.vault) console.log(`  vault  ${rel}   (ver: diff -u ${join(vault, rel)} ${join(REPO_ROOT, "templates", rel)})`);
        console.log(`  Codex  ~/.codex/AGENTS.md (bloco gerenciado): ${plan.codex === "change" ? "recebe a política nova" : plan.codex === "same" ? "já está igual" : "não integrado"}`);
        console.log(`  Claude Code: ${plan.claude ? "importa o AGENTS.md do vault por @ (vale a partir da próxima sessão)" : "não integrado"}`);
        console.log(plan.vault.length || plan.codex === "change" ? "\nNada foi gravado. Aplicar (num terminal, como revisor): brain update-policy" : "\njá está atualizado");
        break;
      }
      // a política dos agentes é configuração do revisor: um agente não a reescreve
      await humanHere("brain update-policy");
      const b = await Brain.open(vault);
      const { writeFileSync, mkdirSync: mk } = await import("node:fs");
      const changed: string[] = [];
      for (const [rel, content] of files) { if (!content) continue; const f = join(vault, rel); let cur = ""; try { cur = readFileSync(f, "utf8"); } catch { /* novo */ } if (cur !== content) { mk(dirname(f), { recursive: true }); writeFileSync(f, content); changed.push(rel); } }
      if (changed.length) { const c = await b.git.commitPaths(changed, "brain: update agent policy and skill from templates"); console.log(`atualizado: ${changed.join(", ")}${c ? ` (commit ${c})` : ""}`); } else console.log("já está atualizado");
      await integrate({ vault, repoRoot: REPO_ROOT, apply: false, remove: false, policyOnly: true });
      b.close(); break;
    }
    case "doctor": { const checks = await runDoctor(vaultPath(), REPO_ROOT, Number(values.port ?? process.env.BRAIN_PORT ?? 3737)); if (values.json) console.log(JSON.stringify(checks, null, 2)); else printChecks(checks); if (checks.some((k) => k.status === "fail")) process.exitCode = 1; break; }
    default: console.error(`comando desconhecido: ${cmd}\n`); console.log(HELP); process.exitCode = 2;
  }
}

main().catch((e) => {
  if (e instanceof BrainError) console.error(`erro (${e.code}): ${e.message}`); else console.error(e);
  process.exit(1);
});
