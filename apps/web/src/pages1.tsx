import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Link2, Sparkles } from "lucide-react";
import { api, type Dashboard, type Integrations, type NoteDetail, type NoteSummary, type Proposal, type SearchHit } from "./api";
import { ClassBadge, Empty, ErrorBox, Markdown, Skeleton, Snippet, StatusBadge, TypeBadge, errMsg, go, href, timeAgo, useData, useDebounced, useToast, TYPE_LABEL } from "./lib";
import { REL_LABEL, RegisterRelation } from "./graphShared";
import { RecentWritesCard } from "./RecentWrites";
import { AssistantBox } from "./AssistantBox";

const LocalGraph = lazy(() => import("./LocalGraph"));
interface Suggestion { src: string; dst: string; dst_title: string; type: string; reason: string; snippet: string; weight: number }

const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Boa madrugada." : h < 12 ? "Bom dia." : h < 18 ? "Boa tarde." : "Boa noite."; };

export function Home() {
  const { data: d, error, loading } = useData<Dashboard>("/api/dashboard", [], 20000);
  const { data: review } = useData<Proposal[]>("/api/proposals");
  if (loading && !d) return <div className="wrap"><Skeleton n={5} /></div>;
  if (!d) return <div className="wrap"><ErrorBox error={error} /></div>;
  const maxN = Math.max(1, ...d.projects.map((p) => p.notes));
  return (
    <div className="wrap">
      <div className="hero">
        <h1>{greeting()} <span className="grad">{d.today.added > 0 ? "Seu cérebro cresceu hoje." : "Seu cérebro está em dia."}</span></h1>
        <p className="sub">{d.today.queries} consultas hoje · {d.today.added} novos · {d.today.updated} atualizações{d.needs_review.pending ? ` · ${d.needs_review.pending} aguardando revisão` : ""}</p>
      </div>
      {d.totals.knowledge === 0 && <Onboarding pending={d.totals.pending} projects={d.totals.projects} />}
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat n={d.totals.knowledge} l="Conhecimentos" /><Stat n={d.totals.projects} l="Projetos" />
        <Stat n={d.today.added} l="Adicionados hoje" /><Stat n={d.totals.pending} l="Precisam de revisão" warn={d.totals.pending > 0} href="review" />
      </div>
      <section className="card" aria-label="Anotar ou perguntar" style={{ marginBottom: 16 }}><AssistantBox /></section>
      <div className="grid cols-2">
        <div className="grid">
          <RecentWritesCard />
          <section className="card flush" aria-label="Fila de revisão">
            <div className="card-h" style={{ padding: "14px 18px 0" }}><h2>Precisa de revisão</h2><a className="btn sm ghost" href={href("review")}>Abrir fila</a></div>
            {review?.length ? review.slice(0, 5).map((p) => (
              <a key={p.id} className="row" href={href(`review/${p.id}`)}>
                <ClassBadge c={p.analysis.classification} />
                <div className="grow"><div className="title">{p.draft.title}</div><div className="meta"><span>{p.proposed_by.name}</span><span>{timeAgo(p.created_at)}</span>{p.analysis.matches[0] && <span>≈ {Math.round(p.analysis.matches[0].similarity * 100)}% {p.analysis.matches[0].title}</span>}</div></div>
              </a>)) : <Empty title="Nada pendente" hint="Propostas dos agentes aparecem aqui." />}
            {d.health.git_dirty > 0 && <a className="row" href={href("settings")}><span className="badge info">Git</span><div className="grow muted">{d.health.git_dirty} edição(ões) manual(is) ainda sem commit (Obsidian?)</div></a>}
            {(d.health.problems.notes_with_issues + d.health.problems.dangling_links + d.health.problems.duplicate_ids + (d.health.problems.sync_conflict_copies ?? 0)) > 0 && <a className="row" href={href("settings")}><span className="badge danger">Saúde</span><div className="grow muted">{d.health.problems.notes_with_issues} nota(s) com problema · {d.health.problems.dangling_links} link(s) quebrado(s) · {d.health.problems.duplicate_ids} id(s) duplicado(s){d.health.problems.sync_conflict_copies ? ` · ${d.health.problems.sync_conflict_copies} cópia(s) de conflito do OneDrive` : ""}</div></a>}
            {d.needs_review.stale > 0 && <div className="row"><span className="badge warn">Antigo</span><div className="grow muted">{d.needs_review.stale} conhecimento(s) sem atualização há muito tempo: {d.needs_review.stale_items.slice(0, 2).map((s) => s.title).join(", ")}</div></div>}
          </section>
          <section className="card flush" aria-label="Conhecimento recente">
            <div className="card-h" style={{ padding: "14px 18px 0" }}><h2>Conhecimento recente</h2></div>
            {d.recent.length ? d.recent.map((n) => <NoteRow key={n.id} n={n} />) : <Empty title="Base vazia" hint="Use ⌘/Ctrl+K → Adicionar conhecimento." />}
          </section>
        </div>
        <div className="grid" style={{ alignContent: "start" }}>
          <section className="card" aria-label="Projetos ativos">
            <div className="card-h"><h2>Projetos ativos</h2><a className="btn sm ghost" href={href("projects")}>Todos</a></div>
            {d.projects.length ? d.projects.slice(0, 6).map((p) => (
              <a key={p.id} href={href(`projects/${p.id}`)} style={{ display: "block", margin: "0 0 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><span>{p.title.replace(/ \(demo\)$/, "")}</span><span className="muted small">{p.notes}</span></div>
                <div className="bar"><i style={{ width: `${(p.notes / maxN) * 100}%` }} /></div>
              </a>)) : <Empty title="Sem projetos" />}
          </section>
          <section className="card" aria-label="Mais usados">
            <div className="card-h"><h2>Mais consultados (30 d)</h2></div>
            {d.most_used.length ? d.most_used.slice(0, 5).map((u) => <a key={u.id} className="row" style={{ padding: "7px 0" }} href={href(`note/${u.id}`)}><div className="grow title">{u.title}</div><span className="muted small">{u.n}×</span></a>) : <Empty title="Ainda sem consultas" />}
          </section>
          <section className="card" aria-label="Agentes">
            <div className="card-h"><h2>Atividade dos agentes</h2><a className="btn sm ghost" href={href("agents")}>Auditoria</a></div>
            {d.agents.length ? d.agents.slice(0, 4).map((a) => <div key={a.name} className="row" style={{ padding: "7px 0" }}><i className="dot" style={{ ["--c" as string]: a.kind === "agent" ? "var(--accent)" : "var(--info)" }} /><div className="grow">{a.name}</div><span className="muted small">{a.reads} leituras · {a.writes} escritas · {timeAgo(a.last)}</span></div>) : <Empty title="Nenhum agente conectou ainda" />}
          </section>
          <a href={href("settings")} className="small muted" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className={`badge ${d.health.ok ? "ok" : "warn"}`}>{d.health.ok ? "Base saudável" : "Atenção"}</span> Git · índice · busca{d.health.embeddings_ok ? "" : " · embeddings incompletos"}</a>
        </div>
      </div>
    </div>
  );
}

function Onboarding({ pending, projects }: { pending: number; projects: number }) {
  const { data: ig } = useData<Integrations>("/api/integrations");
  const toast = useToast();
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast("Copiado")).catch(() => toast(t));
  const step = (done: boolean, title: string, body: React.ReactNode) => (
    <li style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
      <span aria-hidden style={{ width: 20, height: 20, borderRadius: 99, flex: "none", marginTop: 2, display: "grid", placeItems: "center", background: done ? "var(--accent)" : "var(--panel-2)", color: "var(--accent-ink)", fontSize: 12, border: done ? 0 : "1px solid var(--line-2)" }}>{done ? "✓" : ""}</span>
      <div><div style={{ fontWeight: 600 }}>{title}</div><div className="muted small">{body}</div></div>
    </li>);
  const ok = (a?: { mcp: boolean; policy: boolean; skill: boolean }) => !!a && a.mcp && a.policy && a.skill;
  return (
    <section className="card" style={{ marginBottom: 16, borderColor: "color-mix(in srgb, var(--accent) 35%, var(--line))" }} aria-label="Primeiros passos">
      <h2 style={{ color: "var(--accent)" }}>Seu cérebro está pronto</h2>
      <p className="sub" style={{ marginBottom: 6 }}>A base está vazia. Cinco passos, em qualquer ordem:</p>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {step(ok(ig?.claude), "Conectar o Claude Code", ok(ig?.claude) ? "Conectado: MCP, política e skill ativos." : <>Rode <code className="mono">brain integrate --apply</code> (registra o MCP, a política e a skill; faz backup antes). <button className="btn sm ghost" onClick={() => copy("brain integrate --apply")}>copiar</button></>)}
        {step(ok(ig?.codex), "Conectar o Codex", ok(ig?.codex) ? "Conectado: MCP, política e skill ativos." : "Mesmo comando — configura Claude Code e Codex juntos, apontando para esta mesma base.")}
        {step(projects > 0, "Criar o primeiro projeto", <a href={href("projects")} style={{ textDecoration: "underline" }}>Abrir Projetos</a>)}
        {step(pending > 0, "Importar conhecimento", <>{pending > 0 ? <><a href={href("review")} style={{ textDecoration: "underline" }}>{pending} proposta(s) aguardando revisão</a>. </> : null}Cole um texto ou aponte para um repositório: <a href={href("import")} style={{ textDecoration: "underline" }}>Importar</a>. Nada entra sem a sua decisão.</>)}
        {step(false, "Abrir o vault no Obsidian (opcional)", <>“Open folder as vault” em <code className="mono">{ig?.vault ?? "~/second-brain"}</code> <button className="btn sm ghost" onClick={() => ig && copy(ig.vault)}>copiar caminho</button></>)}
      </ol>
    </section>
  );
}

const Stat = ({ n, l, warn, href: h }: { n: number; l: string; warn?: boolean; href?: string }) => {
  const body = <div className="card stat"><span className="n" style={warn ? { color: "var(--warn)" } : undefined}>{n.toLocaleString("pt-BR")}</span><span className="l">{l}</span></div>;
  return h ? <a href={href(h)}>{body}</a> : body;
};

export function NoteRow({ n }: { n: Pick<NoteSummary, "id" | "title" | "type" | "status" | "project" | "updated_at"> }) {
  return (
    <a className="row" href={href(`note/${n.id}`)}>
      <TypeBadge type={n.type} />
      <div className="grow"><div className="title">{n.title}</div><div className="meta">{n.project && <span>{n.project}</span>}<span>{timeAgo(n.updated_at)}</span></div></div>
      <StatusBadge status={n.status} />
    </a>
  );
}

// ---------------- SEARCH ----------------
export function SearchPage({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial);
  const [project, setProject] = useState(""); const [type, setType] = useState(""); const [tag, setTag] = useState("");
  const [since, setSince] = useState(""); const [inactive, setInactive] = useState(false);
  const dq = useDebounced(q, 150);
  const { data: projects } = useData<Array<{ id: string; title: string }>>("/api/projects");
  const qs = new URLSearchParams({ q: dq, ...(project && { project }), ...(type && { type }), ...(tag && { tags: tag }), ...(since && { since: new Date(Date.now() - Number(since) * 864e5).toISOString() }), ...(inactive && { inactive: "1" }) });
  const { data: hits, loading, error } = useData<SearchHit[]>(dq.trim() ? `/api/search?${qs}` : null, [dq]);
  useEffect(() => { setQ(initial); }, [initial]);
  return (
    <div className="wrap">
      <h1>Buscar</h1><p className="sub">Texto completo + similaridade semântica. Ignora acentos.</p>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="ex.: listing mercado livre" aria-label="Buscar conhecimento" style={{ fontSize: 16, padding: "12px 14px", marginBottom: 12 }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        <select aria-label="Projeto" value={project} onChange={(e) => setProject(e.target.value)} style={{ width: "auto" }}><option value="">Todos os projetos</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value)} style={{ width: "auto" }}><option value="">Todos os tipos</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input aria-label="Tag" placeholder="tag" value={tag} onChange={(e) => setTag(e.target.value)} style={{ width: 120 }} />
        <select aria-label="Período" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: "auto" }}><option value="">Qualquer data</option><option value="1">Últimas 24 h</option><option value="7">7 dias</option><option value="30">30 dias</option></select>
        <label style={{ display: "flex", gap: 6, alignItems: "center", margin: 0 }}><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} style={{ width: 16 }} /> incluir substituídos/arquivados</label>
      </div>
      <ErrorBox error={error} />
      {!dq.trim() ? <Empty title="Digite para buscar" hint="Dica: ⌘/Ctrl+K abre a paleta de comandos em qualquer tela." /> : loading && !hits ? <Skeleton n={4} /> : hits?.length ? (
        <div className="card flush">{hits.map((h) => (
          <a key={h.id} className="row" href={href(`note/${h.id}`)} style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}><TypeBadge type={h.type} /><span className="title">{h.title}</span><StatusBadge status={h.status} /></div>
              <div className="muted small" style={{ lineHeight: 1.5 }}><Snippet text={h.snippet} /></div>
              <div className="meta" style={{ marginTop: 4 }}>{h.project && <span>{h.project}</span>}{h.tags.slice(0, 4).map((t) => <span key={t}>#{t}</span>)}<span>{timeAgo(h.updated_at)}</span></div>
            </div>
            <div className="small muted" title={`texto ${h.match.text ?? 0} · semântica ${h.match.semantic ?? 0}`}>{Math.round(Math.min(1, h.score) * 100)}%</div>
          </a>))}</div>
      ) : <Empty title="Nada encontrado" hint="Tente menos termos ou remova filtros." />}
    </div>
  );
}

// ---------------- KNOWLEDGE VIEW ----------------
export function NotePage({ id }: { id: string }) {
  const { data: d, error, loading, reload } = useData<NoteDetail>(`/api/notes/${encodeURIComponent(id)}`, [id]);
  const toast = useToast();
  const [editing, setEditing] = useState(false); const [body, setBody] = useState(""); const [tab, setTab] = useState<"conteudo" | "vizinhanca" | "historico" | "uso">("conteudo");
  const { data: meta } = useData<{ can_review: boolean }>("/api/meta");
  const { data: sugg, reload: reloadSugg } = useData<Suggestion[]>(`/api/notes/${encodeURIComponent(id)}/suggestions`, [id]);
  useEffect(() => { if (d) setBody(d.note.body); }, [d?.note.revision]);
  const known = useMemo(() => { const s = new Set(d?.outgoing.filter((o) => o.exists).map((o) => o.dst)); return (x: string) => s.has(x) || true; }, [d]);
  if (loading && !d) return <div className="wrap"><Skeleton n={6} /></div>;
  if (!d) return <div className="wrap"><ErrorBox error={error} /><a className="btn" href={href("")}>Voltar</a></div>;
  const n = d.note;
  const save = async () => {
    try { await api(`/api/notes/${n.id}`, { method: "PATCH", body: { body, expected_revision: n.revision, reason: "edição manual na UI" } }); setEditing(false); toast("Salvo e commitado"); reload(); }
    catch (e) { toast(errMsg(e), true); }
  };
  const setStatus = async (status: string) => { try { await api(`/api/notes/${n.id}/status`, { method: "POST", body: { status, expected_revision: n.revision } }); toast(`Status: ${status}`); reload(); } catch (e) { toast(errMsg(e), true); } };
  const openObsidian = async () => { try { const o = await api<{ uri: string; windows_path?: string; path: string }>(`/api/obsidian/${n.id}`); await navigator.clipboard?.writeText(o.windows_path ?? o.path).catch(() => undefined); toast(`Caminho copiado: ${o.windows_path ?? o.path}`); location.href = o.uri; } catch (e) { toast(errMsg(e), true); } };
  const superseded = n.status === "superseded";
  return (
    <div className="wrap">
      <div className="muted small" style={{ marginBottom: 8 }}>{n.project ? <><a href={href(`projects/${n.project}`)}>{n.project}</a> / </> : null}{n.path}</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}><TypeBadge type={n.type} /><StatusBadge status={n.status} />{n.confidence && <span className="badge">confiança {n.confidence}</span>}</div>
      <h1 style={{ marginBottom: 12 }}>{n.title}</h1>
      {superseded && n.relations.superseded_by?.[0] && <div className="banner"><Sparkles size={16} />Substituído por <a href={href(`note/${n.relations.superseded_by[0]}`)} style={{ textDecoration: "underline" }}>{n.relations.superseded_by[0]}</a>. Mantido para histórico.</div>}
      {d.issues.length > 0 && <div className="banner info">Problemas no arquivo: {d.issues.join("; ")}</div>}
      <div className="tabs" role="tablist">{(["conteudo", "vizinhanca", "historico", "uso"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>{t === "conteudo" ? "Conteúdo" : t === "vizinhanca" ? "Vizinhança" : t === "historico" ? `Histórico (${d.history.length})` : "Uso e auditoria"}</button>)}</div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 300px", alignItems: "start" }}>
        <div>
          {tab === "conteudo" && (editing ? (
            <div><textarea value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 360 }} aria-label="Corpo da nota" />
              <div className="actions"><button className="btn primary" onClick={save}>Salvar e commitar</button><button className="btn" onClick={() => { setEditing(false); setBody(n.body); }}>Cancelar</button></div></div>
          ) : <><Markdown text={n.body} known={known} /><div className="actions"><button className="btn" onClick={() => setEditing(true)}>Editar</button><button className="btn" onClick={openObsidian}>Abrir no Obsidian</button>{n.status === "active" && <button className="btn" onClick={() => setStatus("deprecated")}>Marcar depreciado</button>}{n.status !== "archived" && <button className="btn" onClick={() => setStatus("archived")}>Arquivar</button>}{(n.status === "deprecated" || n.status === "archived") && <button className="btn" onClick={() => setStatus("active")}>Reativar</button>}</div></>)}
          {tab === "vizinhanca" && <Suspense fallback={<Skeleton n={4} />}><LocalGraph key={n.id} id={n.id} /></Suspense>}
          {tab === "historico" && <div className="card flush">{d.history.length ? d.history.map((h) => <div key={h.hash} className="row"><code className="mono small">{h.hash}</code><div className="grow">{h.subject}<div className="meta"><span>{h.author}</span><span>{new Date(h.date).toLocaleString("pt-BR")}</span></div></div></div>) : <Empty title="Sem commits" hint="O Git registra cada mudança aprovada." />}</div>}
          {tab === "uso" && <div className="card flush">{d.activity.length ? d.activity.map((a) => <div key={a.id} className="row"><span className="badge">{a.actor_name}</span><div className="grow">{a.action}</div><span className="muted small">{timeAgo(a.ts)}</span></div>) : <Empty title="Sem atividade registrada" />}</div>}
        </div>
        <aside className="grid" style={{ position: "sticky", top: 0 }}>
          <div className="card"><h2>Metadados</h2>
            <dl className="kv"><dt>id</dt><dd className="mono small">{n.id}</dd><dt>criado</dt><dd>{new Date(n.created_at).toLocaleDateString("pt-BR")}</dd><dt>alterado</dt><dd>{timeAgo(n.updated_at)}</dd><dt>autor</dt><dd>{n.created_by ? `${n.created_by.name} (${n.created_by.kind})` : "—"}</dd><dt>origem</dt><dd>{n.source ? [n.source.type, n.source.repository, n.source.ref].filter(Boolean).join(" · ") : "—"}</dd><dt>consultas</dt><dd>{d.usage.reads}{d.usage.last_read ? ` · última ${timeAgo(d.usage.last_read)}` : ""}</dd><dt>revisão</dt><dd className="mono small">{n.revision}</dd></dl>
            {n.tags.length > 0 && <div className="tags" style={{ marginTop: 10 }}>{n.tags.map((t) => <a key={t} className="badge" href={href(`search?q=${encodeURIComponent(t)}`)}>#{t}</a>)}</div>}</div>
          <div className="card"><h2>Relações</h2>
            {d.outgoing.length + d.backlinks.length === 0 && <span className="muted small">Nenhuma ainda.</span>}
            {d.outgoing.map((o) => <a key={o.dst + o.type} className="row" style={{ padding: "6px 0" }} href={href(`note/${o.dst}`)}><Link2 size={13} /><div className="grow small">{o.title ?? o.dst}<div className="muted" style={{ fontSize: 11 }}>{o.type}{!o.exists && " · quebrado"}</div></div></a>)}
            {d.backlinks.map((o) => <a key={o.src + o.type} className="row" style={{ padding: "6px 0" }} href={href(`note/${o.src}`)}><Link2 size={13} /><div className="grow small">{o.title}<div className="muted" style={{ fontSize: 11 }}>← {o.type}</div></div></a>)}</div>
          {!!sugg?.length && <div className="card" data-testid="suggestions"><h2>Sugestões de relação</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Derivadas do texto; nada é gravado até você registrar.</p>
            {sugg.map((x) => <div key={x.dst} className="sugg">
              <div className="small"><b>{REL_LABEL[x.type] ?? x.type}</b> → <a href={href(`note/${x.dst}`)}>{x.dst_title}</a> <span className="muted">· {x.reason}</span></div>
              {x.snippet && <q className="muted small sugg-q">{x.snippet}</q>}
              <RegisterRelation src={x.src} dst={x.dst} label={`${n.title.slice(0, 40)} → ${x.dst_title}`} defaultType={x.type} canReview={meta?.can_review} onDone={() => { reload(); reloadSugg(); }} />
            </div>)}
          </div>}
          {d.similar.length > 0 && <div className="card"><h2>Semelhantes</h2>{d.similar.map((s) => <a key={s.id} className="row" style={{ padding: "6px 0" }} href={href(`note/${s.id}`)}><div className="grow small">{s.title}</div><span className="sim small muted">{Math.round(s.similarity * 100)}%</span></a>)}</div>}
        </aside>
      </div>
    </div>
  );
}

export { go };
