import { useEffect, useState } from "react";
import { api, setToken, getToken, type Analysis, type ModulosResp, type ModuloInfo } from "./api";
import { ClassBadge, ErrorBox, timeAgo, Skeleton, TYPE_LABEL, errMsg, go, href, useData, useDebounced, useToast } from "./lib";

interface Settings {
  config: { vault_name: string; embeddings: { provider: string; external_opt_in: boolean; base_url: string; model: string; dimensions: number; api_key_env: string }; governance: { duplicate_threshold: number; candidate_threshold: number; stale_days: number }; agents: { commit_policy: string; can_link: boolean; per_type?: Record<string, string> }; git: { auto_commit: boolean; auto_commit_external: boolean }; limits: { max_chars: number; max_code_lines: number }; retention: { activity_days: number } };
  vault: string; embedder: { id: string; external: boolean };
}
interface Check { id: string; name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string }
interface Health { vault: string; git: { repo: boolean; head?: string; dirty_files: number; auto_commit: boolean }; index: { notes: number }; embeddings: { provider: string; external: boolean; covered: number; total: number }; problems: { notes_with_issues: number; dangling_links: number; duplicate_ids: number; sync_conflict_copies?: number }; pending_proposals: number; ok: boolean }

export function SettingsPage() {
  const { data: s, error, reload } = useData<Settings>("/api/settings");
  const { data: h, reload: reloadH } = useData<Health>("/api/health");
  const { data: dirty, reload: reloadD } = useData<string[]>("/api/git/dirty");
  const { data: log, reload: reloadL } = useData<Array<{ hash: string; date: string; subject: string }>>("/api/git/log?limit=8");
  const toast = useToast();
  const [busy, setBusy] = useState(""); const [checks, setChecks] = useState<Check[]>();
  if (!s) return <div className="wrap">{error ? <ErrorBox error={error} /> : <Skeleton n={5} />}</div>;
  const c = s.config;
  const patch = async (p: unknown, msg = "Configuração salva") => { try { await api("/api/settings", { method: "PUT", body: p }); toast(msg); reload(); reloadH(); } catch (e) { toast(errMsg(e), true); } };
  const run = async (name: string, path: string, body?: unknown) => { setBusy(name); try { const r = await api<Record<string, unknown>>(path, { method: "POST", body }); toast(`${name}: ${JSON.stringify(r).slice(0, 120)}`); reloadH(); reloadD(); reloadL(); } catch (e) { toast(errMsg(e), true); } finally { setBusy(""); } };
  const bin = "node <repo>/packages/cli/dist/bin.js";
  const runDoctor = async () => { setBusy("doctor"); try { setChecks(await api<Check[]>("/api/doctor")); } catch (e) { toast(errMsg(e), true); } finally { setBusy(""); } };
  return (
    <div className="wrap"><h1>Configurações</h1><p className="sub">Vault: <code className="mono">{s.vault}</code></p>
      <div className="grid cols-2e" style={{ alignItems: "start" }}>
        <div className="grid">
          <section className="card"><h2>Saúde</h2>
            {h && <dl className="kv"><dt>Git</dt><dd>{h.git.repo ? <span className="badge ok">ok · {h.git.head}</span> : <span className="badge danger">sem repositório</span>} {h.git.dirty_files > 0 && <span className="badge warn">{h.git.dirty_files} arquivo(s) não commitado(s)</span>}</dd>
              <dt>Índice</dt><dd>{h.index.notes} notas (SQLite, reconstruível)</dd><dt>Embeddings</dt><dd>{h.embeddings.provider} · {h.embeddings.covered}/{h.embeddings.total} {h.embeddings.external ? <span className="badge warn">externo</span> : <span className="badge ok">local</span>}</dd>
              <dt>Problemas</dt><dd>{h.problems.notes_with_issues + h.problems.dangling_links + h.problems.duplicate_ids + (h.problems.sync_conflict_copies ?? 0) === 0 ? "nenhum" : `${h.problems.notes_with_issues} notas · ${h.problems.dangling_links} links quebrados · ${h.problems.duplicate_ids} ids duplicados${h.problems.sync_conflict_copies ? ` · ${h.problems.sync_conflict_copies} cópia(s) de conflito do OneDrive` : ""}`}</dd></dl>}
            <div className="actions"><button className="btn" disabled={!!busy} onClick={() => run("Reindexar", "/api/reindex")}>Reindexar tudo</button>
              <button className="btn" disabled={!!busy || !dirty?.length} onClick={() => run("Commit", "/api/git/commit", {})}>Commitar edições manuais{dirty?.length ? ` (${dirty.length})` : ""}</button></div>
            <div className="actions"><button className="btn" disabled={busy === "doctor"} onClick={runDoctor}>{busy === "doctor" ? "Diagnosticando…" : "Executar diagnóstico completo"}</button></div>
            {checks && <div style={{ marginTop: 12 }} role="list" aria-label="Resultado do diagnóstico">{checks.map((k) => <div key={k.id} role="listitem" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}><span className={`badge ${k.status === "ok" ? "ok" : k.status === "warn" ? "warn" : "danger"}`}>{k.status === "ok" ? "ok" : k.status === "warn" ? "aviso" : "falha"}</span> <b>{k.name}</b> <span className="muted small">{k.detail}</span>{k.status !== "ok" && k.fix && <div className="small" style={{ marginTop: 2 }}>↳ correção: <code className="mono">{k.fix}</code></div>}</div>)}</div>}
            {log && <div style={{ marginTop: 14 }}><h2>Últimos commits</h2>{log.map((l) => <div key={l.hash} className="small" style={{ padding: "3px 0", display: "flex", gap: 8 }}><code className="mono">{l.hash}</code><span className="grow" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.subject}</span><button className="btn sm ghost" title="Reverter (cria novo commit)" onClick={() => confirm(`Reverter ${l.hash}?`) && run("Reverter", "/api/git/revert", { rev: l.hash })}>↩</button></div>)}</div>}
          </section>
          <ModulesSection />
          <section className="card"><h2>Busca e embeddings</h2>
            <div className="field"><label htmlFor="prov">Provider de embeddings</label>
              <select id="prov" value={c.embeddings.provider} onChange={(e) => patch({ embeddings: { provider: e.target.value } })}><option value="hash">Local offline (hash) — padrão, nada sai da máquina</option><option value="openai-compatible">Endpoint OpenAI-compatível (OpenAI, Ollama, LM Studio…)</option></select></div>
            {c.embeddings.provider === "openai-compatible" && <>
              <div className="field"><label htmlFor="bu">Base URL</label><input id="bu" defaultValue={c.embeddings.base_url} onBlur={(e) => e.target.value !== c.embeddings.base_url && patch({ embeddings: { base_url: e.target.value } })} /></div>
              <div className="field"><label htmlFor="md">Modelo</label><input id="md" defaultValue={c.embeddings.model} onBlur={(e) => e.target.value !== c.embeddings.model && patch({ embeddings: { model: e.target.value } })} /></div>
              <div className="switch"><div><b>Permitir envio a servidor externo</b><div className="muted small">Envia título+corpo das notas (nunca segredos) para {c.embeddings.base_url}. Chave lida da variável {c.embeddings.api_key_env}. Localhost dispensa opt-in.</div></div><input type="checkbox" checked={c.embeddings.external_opt_in} onChange={(e) => patch({ embeddings: { external_opt_in: e.target.checked } })} aria-label="Opt-in embeddings externos" /></div></>}
            <p className="small muted">Sem embeddings a busca continua funcionando por texto completo (FTS5). Provider atual: <code>{s.embedder.id}</code>.</p></section>
        </div>
        <div className="grid">
          <section className="card"><h2>Git</h2>
            <div className="switch"><div><b>Auto-commit</b><div className="muted small">Cada decisão aprovada vira um commit agrupado.</div></div><input type="checkbox" checked={c.git.auto_commit} onChange={(e) => patch({ git: { auto_commit: e.target.checked } })} aria-label="Auto-commit" /></div>
            <div className="switch"><div><b>Auto-commit de edições do Obsidian</b><div className="muted small">Desligado: você agrupa e commita manualmente.</div></div><input type="checkbox" checked={c.git.auto_commit_external} onChange={(e) => patch({ git: { auto_commit_external: e.target.checked } })} aria-label="Auto-commit externo" /></div></section>
          <section className="card"><h2>Permissões dos agentes</h2>
            <div className="field"><label htmlFor="cp">Persistir sem revisão humana (brain_commit)</label><select id="cp" value={c.agents.commit_policy} onChange={(e) => patch({ agents: { commit_policy: e.target.value } })}><option value="never">Nunca — tudo passa pela revisão (recomendado)</option><option value="new_only">Somente conhecimento novo, sem semelhantes</option><option value="additive">Aditiva — nota nova e complemento direto</option><option value="all">Qualquer resolução</option></select>{c.agents.commit_policy === "additive" && <div className="muted small" data-testid="additive-hint">Agentes gravam nota nova e complemento direto; atualização, substituição e conflito vão para a fila.</div>}</div>
            <div className="field"><label>Permissão por tipo (vale só se a política acima permitir; conflitos e substituições sempre exigem revisão)</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>{Object.keys(TYPE_LABEL).filter((t) => t !== "project").map((t) => <div key={t} style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ flex: 1 }} className="small">{TYPE_LABEL[t]}</span>
                <select aria-label={`Permissão para ${TYPE_LABEL[t]}`} style={{ width: "auto", padding: "2px 6px" }} disabled={c.agents.commit_policy === "never"} value={c.agents.per_type?.[t] ?? (c.agents.commit_policy === "additive" ? "auto" : "review")} onChange={(e) => patch({ agents: { per_type: { [t]: e.target.value } } })}><option value="review">revisão</option><option value="auto">auto</option></select></div>)}</div></div>
            <div className="switch"><div><b>Agentes podem criar relações</b><div className="muted small">brain_link é aditivo e auditado.</div></div><input type="checkbox" checked={c.agents.can_link} onChange={(e) => patch({ agents: { can_link: e.target.checked } })} aria-label="Agentes podem relacionar" /></div></section>
          <section className="card"><h2>Governança e privacidade</h2>
            <div className="field"><label htmlFor="dt">Limiar de duplicata ({c.governance.duplicate_threshold})</label><input id="dt" type="range" min="0.5" max="0.98" step="0.01" defaultValue={c.governance.duplicate_threshold} onMouseUp={(e) => patch({ governance: { duplicate_threshold: Number((e.target as HTMLInputElement).value) } })} /></div>
            <div className="field"><label htmlFor="ct">Limiar de candidato semelhante ({c.governance.candidate_threshold})</label><input id="ct" type="range" min="0.2" max="0.8" step="0.01" defaultValue={c.governance.candidate_threshold} onMouseUp={(e) => patch({ governance: { candidate_threshold: Number((e.target as HTMLInputElement).value) } })} /></div>
            <div className="field"><label htmlFor="sd">Considerar antigo após (dias)</label><input id="sd" type="number" defaultValue={c.governance.stale_days} onBlur={(e) => patch({ governance: { stale_days: Number(e.target.value) } })} /></div>
            <div className="field"><label htmlFor="rt">Retenção da atividade (dias)</label><input id="rt" type="number" defaultValue={c.retention.activity_days} onBlur={(e) => patch({ retention: { activity_days: Number(e.target.value) } })} /></div>
            <p className="small muted">Segredos (chaves, tokens, senhas) são sempre rejeitados antes de qualquer gravação ou envio.</p></section>
          <section className="card"><h2>Conectar agentes (MCP)</h2>
            <p className="small muted">Rode no terminal; o MCP funciona mesmo com esta interface fechada.</p>
            <pre className="mono small" style={{ whiteSpace: "pre-wrap", margin: 0, background: "var(--bg-2)", padding: 10, borderRadius: 8 }}>{`${bin} integrate          # mostra os comandos\n${bin} integrate --apply  # Claude Code + Codex + skill`}</pre></section>
          <section className="card"><h2>Interface</h2>
            <div className="field"><label htmlFor="th">Tema</label><select id="th" defaultValue={localStorage.getItem("theme") ?? "dark"} onChange={(e) => { localStorage.setItem("theme", e.target.value); document.documentElement.dataset.theme = e.target.value; }}><option value="dark">Escuro</option><option value="light">Claro</option></select></div>
            <div className="field"><label htmlFor="tk">Token da API</label><input id="tk" type="password" defaultValue={getToken()} onBlur={(e) => { setToken(e.target.value); toast("Token atualizado"); }} /></div></section>
        </div>
      </div>
    </div>
  );
}

// ---------------- MÓDULOS (Saúde) ----------------
const STATUS_MODULO: Record<ModuloInfo["status"], [string, string]> = { ativo: ["ok", "ativo"], falho: ["danger", "falho"], inativo: ["", "inativo"], ausente: ["warn", "ausente"] };
const quando = (iso?: string) => { if (!iso) return "—"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };

function ModulesSection() {
  const { data, reload } = useData<ModulosResp>("/api/modules", [], 15000);
  // "rodar agora" exige a sessão humana `full` da UI (canal ui); api-token e outras credenciais recebem 403, então nem mostra
  const { data: meta } = useData<{ principal: { kind: string; channel: string } }>("/api/meta");
  const podeRodar = meta?.principal.kind === "human" && meta.principal.channel === "ui";
  const toast = useToast();
  const [rodando, setRodando] = useState(""); const [resultados, setResultados] = useState<Record<string, string>>({});
  if (!data || (data.modulos.length === 0 && !data.reiniciar)) return null;
  const rodar = async (m: ModuloInfo, tarefa: string) => {
    if (!confirm(`Rodar agora a tarefa "${tarefa}" do módulo "${m.nome}"?\n\nA tarefa pode causar uma ação externa (enviar mensagem, chamar um serviço) e não pode ser desfeita por aqui.`)) return;
    const k = `${m.id}/${tarefa}`; setRodando(k);
    try {
      const r = await api<{ resultado: string; erro?: string }>(`/api/modules/${m.id}/_tarefas/${encodeURIComponent(tarefa)}/rodar`, { method: "POST", body: {} });
      const txt = r.erro ? `${r.resultado}: ${r.erro}` : r.resultado; setResultados((x) => ({ ...x, [k]: txt })); toast(`${tarefa}: ${txt}`, r.resultado !== "ok"); reload();
    } catch (e) { setResultados((x) => ({ ...x, [k]: errMsg(e) })); toast(errMsg(e), true); } finally { setRodando(""); }
  };
  return (
    <section className="card" data-testid="modules-section"><h2>Módulos</h2>
      {data.reiniciar && <div className="banner" role="status">a configuração de módulos mudou: reinicie o brain serve</div>}
      {data.modulos.map((m) => { const [cls, lbl] = STATUS_MODULO[m.status] ?? ["", m.status]; return (
        <div key={m.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div><b>{m.nome}</b> <code className="mono small">{m.id}</code> <span className={`badge ${cls}`}>{lbl}</span> {m.versao && <span className="muted small">v{m.versao}</span>}</div>
          <div className="small muted" style={{ marginTop: 2 }}>{m.sdk !== undefined && <>sdk {m.sdk} · </>}{m.iaBloqueada ? <span style={{ color: "var(--danger)" }}>IA {m.iaBloqueio ?? "bloqueada"}</span> : <>IA hoje: US$ {(m.iaHojeUsd ?? 0).toFixed(2)}</>}{m.pasta && <> · <code className="mono" title="pasta do módulo">{m.pasta}</code></>}</div>
          {m.causa && <div className="small" style={{ color: "var(--danger)", marginTop: 2 }}>{m.causa}</div>}
          {m.tarefas.map((t) => { const k = `${m.id}/${t.tarefa}`; const res = resultados[k]; return (
            <div key={t.tarefa} className="small" style={{ marginTop: 8, paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><b>{t.tarefa}</b> <code className="mono">{t.quando}</code>{t.suspensa && <span className="badge warn" title={`${t.errosSeguidos} erros seguidos`}>suspensa</span>}
                {podeRodar && <button className="btn sm" style={{ marginLeft: "auto" }} disabled={!!rodando} onClick={() => rodar(m, t.tarefa)}>{rodando === k ? "Rodando…" : "Rodar agora"}</button>}</div>
              <div className="muted">próxima: {quando(t.proxima)} · última: {t.fim || t.inicio ? `${quando(t.fim ?? t.inicio)} (${timeAgo(t.fim ?? t.inicio)})` : "nunca"} {t.resultado && <span className={`badge ${t.resultado === "ok" ? "ok" : "danger"}`}>{t.resultado}</span>}</div>
              {t.erro && <div style={{ color: "var(--danger)" }}>{t.erro}</div>}
              {res && <div role="status">resultado agora: {res}</div>}
            </div>); })}
          {m.erros.length > 0 && <details style={{ marginTop: 8 }}><summary className="small muted">Erros recentes ({m.erros.length})</summary>
            {m.erros.map((e, i) => <div key={i} className="small" style={{ padding: "3px 0" }}><span className="muted">{quando(e.em)}</span> <code className="mono">{e.onde}</code> {e.mensagem}</div>)}</details>}
        </div>); })}
    </section>
  );
}

// ---------------- ADD KNOWLEDGE (com checagem de semelhantes ao vivo) ----------------
export function AddKnowledge({ onClose, project }: { onClose: () => void; project?: string }) {
  const toast = useToast();
  const { data: projects } = useData<Array<{ id: string; title: string }>>("/api/projects");
  const [f, setF] = useState({ title: "", type: "learning", project: project ?? "", body: "", tags: "" });
  const dbt = useDebounced(f.title + f.body, 450);
  const [an, setAn] = useState<Analysis>();
  useEffect(() => { if (f.title.trim().length < 3 || f.body.trim().length < 10) { setAn(undefined); return; } api<Analysis>("/api/analyze", { method: "POST", body: { title: f.title, body: f.body, type: f.type, project: f.project || undefined } }).then(setAn).catch(() => setAn(undefined)); }, [dbt, f.type, f.project]);
  const body = () => ({ title: f.title.trim(), type: f.type, project: f.project || undefined, body: f.body, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) });
  const [err, setErr] = useState<string>();
  const createDirect = async () => { try { const n = await api<{ id: string }>("/api/notes", { method: "POST", body: body() }); toast("Conhecimento criado"); onClose(); go(`note/${n.id}`); } catch (e) { setErr(errMsg(e)); } };
  const propose = async () => { try { const p = await api<{ id: string }>("/api/proposals", { method: "POST", body: body() }); toast("Enviado para revisão"); onClose(); go(`review/${p.id}`); } catch (e) { setErr(errMsg(e)); } };
  const similar = an && an.matches.some((m) => m.similarity >= 0.42);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Adicionar conhecimento" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal wide" style={{ padding: 22 }}>
        <h1 style={{ fontSize: 20 }}>Adicionar conhecimento</h1><p className="sub" style={{ marginBottom: 14 }}>Salve apenas conhecimento durável. Nada de segredos ou código copiado.</p>
        <ErrorBox error={err} />
        <div className="field"><label htmlFor="t">Título</label><input id="t" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Frase nominal específica" /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <div className="field"><label htmlFor="ty">Tipo</label><select id="ty" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label htmlFor="pr">Projeto</label><select id="pr" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })}><option value="">(global)</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
          <div className="field"><label htmlFor="tg">Tags</label><input id="tg" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="a, b" /></div></div>
        <div className="field"><label htmlFor="bd">Conteúdo (Markdown) — inclua o porquê e a origem</label><textarea id="bd" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
        {an && (similar ? <div className="banner">
          <div><b>Parece existir conhecimento semelhante</b> — <ClassBadge c={an.classification} />{an.matches.filter((m) => m.similarity >= 0.42).slice(0, 3).map((m) => <div key={m.id}><a href={href(`note/${m.id}`)} style={{ textDecoration: "underline" }}>{m.title}</a> ({Math.round(m.similarity * 100)}%)</div>)}Prefira “Enviar para revisão” para complementar/atualizar em vez de duplicar.</div></div> : <div className="small muted" style={{ marginBottom: 10 }}>Nenhum semelhante encontrado.</div>)}
        <div className="actions" style={{ marginTop: 6 }}><button className="btn primary" disabled={!f.title.trim() || !f.body.trim()} onClick={createDirect}>Criar agora</button><button className="btn" disabled={!f.title.trim() || !f.body.trim()} onClick={propose}>Enviar para revisão</button><button className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </div>
    </div>
  );
}
