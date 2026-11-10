import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { Check, GitMerge, Layers, Replace, X } from "lucide-react";
import { api, type Proposal } from "./api";
import { CLASS_LABEL, ClassBadge, TYPE_LABEL, Diff, Empty, ErrorBox, Markdown, RES_LABEL, Skeleton, TypeBadge, errMsg, go, href, timeAgo, useData, useHotkey, useRoute, useToast } from "./lib";
import { EFFORT_LABEL, FreshBadge, HISTORICAL, ValidityBox, type suggestionAction } from "./Freshness";
import { readGraphQuery, writeGraphQuery, type GraphData } from "./graphShared";

const FLAG_HELP: Record<string, string> = { "heading-based": "O tipo veio do cabeçalho da seção; confira se o conteúdo realmente sustenta", enriched: "Foi anexado contexto do cabeçalho porque o texto dependia dele", "title-synthesized": "O título foi derivado do conteúdo (o cabeçalho era organizacional)", split: "Item separado de uma lista de itens independentes", group: "Lista coesa mantida junta" };
const RES_HELP: Record<string, string> = {
  create: "Cria como conhecimento novo", complement: "Anexa seção ao existente", update: "Corrige valores no existente",
  replace: "Novo substitui; antigo fica superseded", keep_separate: "Cria separado e relacionado", ignore: "Descarta; registra decisão",
};

// ---------------- REVIEW QUEUE / INBOX ----------------
export function ReviewPage({ id, mode }: { id?: string; mode: "review" | "inbox" }) {
  const { data: list, loading, error, reload } = useData<Proposal[]>(`/api/${mode}`, [mode]);
  const toast = useToast();
  const [filter, setFilter] = useState<string>("all"); const [agent, setAgent] = useState<string>("all");
  const shown = useMemo(() => (list ?? []).filter((p) => (filter === "all" || p.analysis.classification === filter) && (agent === "all" || p.proposed_by.name === agent)), [list, filter, agent]);
  const classes = useMemo(() => { const c: Record<string, number> = {}; for (const p of list ?? []) c[p.analysis.classification] = (c[p.analysis.classification] ?? 0) + 1; return c; }, [list]);
  const agents = useMemo(() => [...new Set((list ?? []).map((p) => p.proposed_by.name))], [list]);
  useEffect(() => { if (!id && shown.length && window.innerWidth > 1100 && new RegExp(`^#/${mode}/?$`).test(location.hash)) go(`${mode}/${shown[0]!.id}`); }, [id, shown, mode]);
  const idx = shown.findIndex((p) => p.id === id);
  const move = (d: number) => { const n = shown[Math.min(shown.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + d))]; if (n) go(`${mode}/${n.id}`); };
  useHotkey("j", () => move(1)); useHotkey("k", () => move(-1));
  const nextAfter = (done: string) => { const rest = shown.filter((p) => p.id !== done); const i = shown.findIndex((p) => p.id === done); return rest[Math.min(i, rest.length - 1)]; };
  // mesmo critério do core: nova, extração alta, sem semelhantes E atualidade comprovada (ou sem reconciliação)
  const eligible = (p: Proposal) => p.analysis.classification === "new" && p.draft.confidence === "high" && !p.analysis.matches.some((m) => m.similarity >= 0.42) && (!p.freshness || (p.freshness.state === "current" && p.freshness.confidence !== "low"));
  const efforts = useMemo(() => { const c: Record<string, number> = {}; for (const p of list ?? []) if (p.freshness) c[p.freshness.effort] = (c[p.freshness.effort] ?? 0) + 1; return c; }, [list]);
  const dups = (list ?? []).filter((p) => p.analysis.classification === "duplicate");
  const [chk, setChk] = useState<Set<string>>(new Set());
  const toggleChk = (pid: string) => setChk((c) => { const n = new Set(c); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  const approve = async () => {
    const picked = shown.filter((p) => chk.has(p.id) && eligible(p));
    if (!picked.length || !confirm(`Criar ${picked.length} conhecimento(s) novo(s) agora?\n\n${picked.slice(0, 8).map((p) => "• " + p.draft.title).join("\n")}${picked.length > 8 ? `\n… e mais ${picked.length - 8}` : ""}\n\nUm único commit. Você poderá editar ou reverter depois.`)) return;
    try { const r = await api<{ created: unknown[]; skipped: unknown[] }>("/api/proposals/approve-many", { method: "POST", body: { ids: picked.map((p) => p.id) } }); toast(`${r.created.length} criado(s)${r.skipped.length ? ` · ${r.skipped.length} ignorado(s) (precisam de decisão individual)` : ""}`); setChk(new Set()); reload(); go(mode); } catch (e) { toast(errMsg(e), true); }
  };
  const ignoreDups = async () => {
    if (!confirm(`Ignorar ${dups.length} duplicata(s)? Nada será criado; as decisões ficam registradas em um único commit.`)) return;
    try { const r = await api<{ ignored: number }>("/api/proposals/ignore-many", { method: "POST", body: { ids: dups.map((d) => d.id), note: "duplicatas ignoradas em lote" } }); toast(`${r.ignored} duplicata(s) ignorada(s)`); reload(); go(mode); } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <div className="wrap">
      <h1>{mode === "review" ? "Fila de revisão" : "Inbox"}</h1>
      <p className="sub">{mode === "review" ? "Todas as propostas pendentes (use os filtros por classe). Nada é gravado sem a sua decisão." : "Conhecimento novo, sem semelhantes, aguardando aprovação."} <span className="muted small">Atalhos: <span className="kbd">j</span> <span className="kbd">k</span> navegam.</span></p>
      <ErrorBox error={error} />
      <div className={`review-grid${id ? " has-detail" : ""}`}>
        <div className="review-list">
          {((list?.length ?? 0) > 3 || filter !== "all" || agent !== "all") && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }} role="group" aria-label="Filtros">
            <button className="badge" aria-pressed={filter === "all"} onClick={() => setFilter("all")} style={filter === "all" ? { borderColor: "var(--accent)" } : undefined}>todas {list?.length}</button>
            {Object.entries(classes).map(([k, n]) => <button key={k} className="badge" aria-pressed={filter === k} onClick={() => setFilter(k)} style={filter === k ? { borderColor: "var(--accent)" } : undefined}>{CLASS_LABEL[k] ?? k} {n}</button>)}
            {Object.keys(efforts).length > 0 && <span className="small muted" style={{ alignSelf: "center" }} title="Esforço de revisão estimado pela verificação de atualidade">{Object.entries(efforts).map(([k, n]) => `${EFFORT_LABEL[k] ?? k} ${n}`).join(" · ")}</span>}
            {agents.length > 1 && <select aria-label="Filtrar por origem" value={agent} onChange={(e) => setAgent(e.target.value)} style={{ width: "auto", padding: "1px 8px", fontSize: 12 }}><option value="all">todas as origens</option>{agents.map((a) => <option key={a}>{a}</option>)}</select>}
          </div>}
          {shown.some(eligible) && <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => setChk(chk.size ? new Set() : new Set(shown.filter(eligible).map((p) => p.id)))}>{chk.size ? "Limpar seleção" : "Selecionar elegíveis (novas, confiança alta, atuais)"}</button>
            <button className="btn sm primary" disabled={!chk.size} onClick={approve}>Aprovar {chk.size || ""} em lote</button></div>}
          <nav className="card flush" aria-label="Propostas" style={{ maxHeight: "68vh", overflow: "auto" }}>
            {loading && !list ? <Skeleton n={4} /> : shown.length ? shown.map((p) => (
              <a key={p.id} className="row" href={href(`${mode}/${p.id}`)} aria-current={p.id === id ? "true" : undefined} style={p.id === id ? { background: "var(--hover)", boxShadow: "inset 2px 0 0 var(--accent)" } : undefined}>
                {eligible(p) && <input type="checkbox" aria-label={`Selecionar ${p.draft.title} para aprovação em lote`} checked={chk.has(p.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleChk(p.id)} style={{ width: 15, alignSelf: "flex-start", marginTop: 4 }} />}
                <div className="grow">
                  <div style={{ display: "flex", gap: 6, marginBottom: 3, flexWrap: "wrap" }}><ClassBadge c={p.analysis.classification} />{p.state === "stale" && <span className="badge danger">desatualizada</span>}{p.import && <span className="badge info">import</span>}{p.draft.confidence && p.draft.confidence !== "high" && <span className={`badge ${p.draft.confidence === "low" ? "danger" : "warn"}`}>confiança {p.draft.confidence === "low" ? "baixa" : "média"}</span>}<FreshBadge f={p.freshness} /><TypeBadge type={p.draft.type} /></div>
                  <div className="title" style={{ whiteSpace: "normal" }}>{p.draft.title}</div>
                  <div className="meta"><span>{p.proposed_by.name}</span><span>{timeAgo(p.created_at)}</span>{p.analysis.matches[0] && p.analysis.classification !== "new" && <span className="sim">{Math.round(p.analysis.matches[0].similarity * 100)}%</span>}</div>
                </div>
              </a>)) : <Empty title={list?.length ? "Nenhuma proposta neste filtro" : mode === "review" ? "Fila vazia" : "Inbox vazio"} hint={list?.length ? "Limpe o filtro acima." : "Quando um agente usar brain_propose (ou você importar), a proposta aparece aqui."} />}
          </nav>

          {dups.length > 1 && mode === "review" && <button className="btn sm" style={{ marginTop: 8 }} onClick={ignoreDups}>Ignorar {dups.length} duplicatas de uma vez</button>}
        </div>
        {id ? <div><a className="btn sm ghost back-link" href={href(mode)} style={{ marginBottom: 8 }}>← Voltar à lista</a><ProposalDetail key={id} id={id} onDone={() => { reload(); const n = nextAfter(id); go(n ? `${mode}/${n.id}` : mode); }} /></div> : <Empty title="Selecione uma proposta" hint="Use j/k para navegar." />}
      </div>
    </div>
  );
}

function effect(res: string, p: Proposal, target?: string, note?: string, historical?: boolean): React.ReactNode {
  const t = target ? <b>“{target}”</b> : "o alvo";
  switch (res) {
    case "create": return historical ? <>cria um conhecimento <b>histórico</b> ({p.draft.type}, status <code>superseded</code>): fica fora do contexto e da busca padrão, mas continua no vault e pesquisável com histórico. 1 commit.</> : <>cria um novo conhecimento ({p.draft.type}{p.draft.project ? ` em ${p.draft.project}` : ""}). 1 commit.</>;
    case "complement": return <>anexa uma seção “{historical ? "Histórico" : "Complemento"}” ao fim de {t}. Nada existente é removido ou alterado.</>;
    case "update": return <>altera {t} conforme a prévia{note ? ` (${note})` : ""}. A versão anterior continua no histórico do Git e pode ser revertida.</>;
    case "replace": return <>cria um <b>novo</b> conhecimento e marca {t} como <code>superseded</code> (com <code>superseded_by</code> apontando para o novo). <b>O antigo NÃO é apagado:</b> continua no vault e no histórico, apenas some das buscas por padrão.</>;
    case "keep_separate": return <>cria um novo conhecimento independente{target ? <>, relacionado a {t} (<code>related_to</code>)</> : null}. Nada existente muda.</>;
    case "ignore": return <>descarta a proposta. Nada é criado ou alterado; a decisão fica registrada no histórico.</>;
    default: return "—";
  }
}

function ProposalDetail({ id, onDone }: { id: string; onDone: () => void }) {
  const { data: p, error, reload } = useData<Proposal>(`/api/proposals/${id}`, [id]);
  const toast = useToast();
  const [res, setRes] = useState<string>(""); const [target, setTarget] = useState<string>(""); const [edited, setEdited] = useState<string>(); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState(false);
  useEffect(() => { setHist(!!p?.freshness && HISTORICAL.includes(p.freshness.state)); }, [p?.id, p?.freshness?.state]);
  const [editing, setEditing] = useState(false); const [ed, setEd] = useState({ title: "", body: "", tags: "", type: "learning" });
  useEffect(() => { if (p) { setRes(p.analysis.suggested_resolution); setTarget(p.target_id ?? p.analysis.target_id ?? p.analysis.matches[0]?.id ?? ""); setEdited(undefined); } }, [p?.id, p?.analysis.suggested_resolution]);
  const needsTarget = ["complement", "update", "replace"].includes(res);
  const previewable = res === "complement" || res === "update";
  const { data: prev } = useData<{ before?: string; after: string; notes: string[] }>(p && res && (!needsTarget || target) && p.state !== "accepted" ? `/api/proposals/${id}/preview?resolution=${res}${target ? `&target=${target}` : ""}` : null, [res, target, p?.target_revision, p?.state]);
  const existing = useData<{ note: { title: string; body: string; updated_at: string; revision: string } }>(target ? `/api/notes/${target}` : null, [target, p?.target_revision, p?.state]);
  const m = useMemo(() => p?.analysis.matches.find((x) => x.id === target), [p, target]);
  useEffect(() => { setEdited(undefined); }, [res, target, p?.draft.body, p?.target_revision, p?.state]); // qualquer mudança invalida o corpo final editado
  if (!p) return error ? <ErrorBox error={error} /> : <Skeleton n={5} />;
  const decided = p.state === "accepted" || p.state === "ignored";

  const submit = async () => {
    setBusy(true);
    try {
      const out = await api<{ note?: { id: string }; commit?: string }>(`/api/proposals/${id}/resolve`, { method: "POST", body: { resolution: res, target_id: needsTarget || res === "keep_separate" ? target || undefined : undefined, final_body: previewable ? edited : undefined, note: note || undefined, ...(p.freshness ? { as_historical: hist } : {}) } });
      toast(res === "ignore" ? "Proposta ignorada" : `Persistido${out.commit ? ` · commit ${out.commit}` : ""}`); onDone();
    } catch (e) { toast(errMsg(e), true); reload(); } finally { setBusy(false); }
  };
  /** "Aceitar sugestão" da verificação de atualidade: uma decisão completa num clique (reversível pelo Git). */
  const acceptSuggestion = async (a: NonNullable<ReturnType<typeof suggestionAction>>) => {
    setBusy(true);
    try {
      const out = await api<{ commit?: string }>(`/api/proposals/${id}/resolve`, { method: "POST", body: { resolution: a.resolution, target_id: a.target, as_historical: a.as_historical, note: a.note } });
      toast(a.resolution === "ignore" ? "Proposta ignorada (sugestão aceita)" : `Sugestão aceita${out.commit ? ` · commit ${out.commit}` : ""}`); onDone();
    } catch (e) { toast(errMsg(e), true); reload(); } finally { setBusy(false); }
  };
  const startEdit = () => { setEd({ title: p.draft.title, body: p.draft.body, tags: p.draft.tags.join(", "), type: p.draft.type }); setEditing(true); };
  const saveEdit = async () => { try { await api(`/api/proposals/${id}`, { method: "PATCH", body: { title: ed.title, body: ed.body, type: ed.type, tags: ed.tags.split(",").map((t) => t.trim()).filter(Boolean) } }); toast("Proposta atualizada e reanalisada"); setEditing(false); setEdited(undefined); reload(); } catch (e) { toast(errMsg(e), true); } };
  const reanalyze = async () => { try { await api(`/api/proposals/${id}/reanalyze`, { method: "POST" }); toast("Análise atualizada"); reload(); } catch (e) { toast(errMsg(e), true); } };

  const opts: Array<{ r: string; icon: React.ReactNode }> = [
    { r: "complement", icon: <Layers size={14} /> }, { r: "update", icon: <GitMerge size={14} /> }, { r: "replace", icon: <Replace size={14} /> },
    { r: "keep_separate", icon: <Check size={14} /> }, { r: "ignore", icon: <X size={14} /> },
  ];
  if (!p.analysis.matches.length) opts.unshift({ r: "create", icon: <Check size={14} /> });
  return (
    <div>
      {p.state === "stale" && <div className="banner danger" role="alert">O conhecimento alvo mudou depois da análise. <button className="btn sm" onClick={reanalyze}>Reanalisar</button></div>}
      {p.analysis.warnings.map((w) => <div key={w} className="banner">{w}</div>)}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <ClassBadge c={p.analysis.classification} /><span className="muted small">sugestão: <b>{RES_LABEL[p.analysis.suggested_resolution]}</b> (confiança {p.analysis.confidence})</span>
        {m && <span className="sim badge info">similaridade {Math.round(m.similarity * 100)}%</span>}
        {p.analysis.matches.length > 1 && <select aria-label="Conhecimento existente alvo" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: "auto", marginLeft: "auto" }}>{p.analysis.matches.map((x) => <option key={x.id} value={x.id}>{x.title} ({Math.round(x.similarity * 100)}%)</option>)}</select>}
      </div>
      <div className="split">
        <div className="pane">
          <h2>Conhecimento existente {m && <span className="small muted" style={{ textTransform: "none" }}>atualizado {timeAgo(m.updated_at)}</span>}</h2>
          {target && existing.data ? <><h3 style={{ marginBottom: 8 }}><a href={href(`note/${target}`)}>{existing.data.note.title}</a></h3><Markdown text={existing.data.note.body} /></> : <span className="muted">Nenhum candidato semelhante.</span>}
        </div>
        <div className="pane proposed">
          <h2>Proposto <span className="small muted" style={{ textTransform: "none" }}>por {p.proposed_by.name} · {timeAgo(p.created_at)}</span></h2>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}><TypeBadge type={p.draft.type} />{p.draft.project && <span className="badge">{p.draft.project}</span>}</div>
          {editing ? (<div>
            <div className="field"><label htmlFor="et">Título</label><input id="et" value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><div className="field"><label htmlFor="ety">Tipo</label><select id="ety" value={ed.type} onChange={(e) => setEd({ ...ed, type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><div className="field"><label htmlFor="etg">Tags</label><input id="etg" value={ed.tags} onChange={(e) => setEd({ ...ed, tags: e.target.value })} /></div></div>
            <div className="field"><label htmlFor="eb">Conteúdo</label><textarea id="eb" value={ed.body} onChange={(e) => setEd({ ...ed, body: e.target.value })} style={{ minHeight: 180 }} /></div>
            <div className="actions" style={{ marginTop: 0 }}><button className="btn primary sm" onClick={saveEdit}>Salvar e reanalisar</button><button className="btn sm" onClick={() => setEditing(false)}>Cancelar</button></div>
          </div>) : (<><h3 style={{ marginBottom: 8 }}>{p.draft.title}</h3><Markdown text={p.draft.body} />{!decided && <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={startEdit}>Editar proposta</button>}{p.edited && <span className="small muted"> · editada por {p.edited.by.name}</span>}</>)}
          {p.reason && <p className="small muted">Motivo: {p.reason}</p>}
          {p.draft.confidence && <p className="small muted">Confiança declarada: {p.draft.confidence}</p>}
          {p.import && <div className="small" style={{ marginTop: 8, padding: "8px 10px", background: "var(--bg-2)", borderRadius: 8, border: "1px solid var(--line)" }}>
            <b>Por que virou proposta</b> · regra <code>{p.import.rule}</code>
            {p.import.why?.length ? <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{p.import.why.map((w) => <li key={w}>{w}</li>)}</ul> : null}
            {p.import.parent && <div className="muted" style={{ marginTop: 4 }}>Seção: {p.import.parent}</div>}
            {p.import.flags?.length ? <div className="tags" style={{ marginTop: 6 }}>{p.import.flags.map((f) => <span key={f} className={`badge ${f === "heading-based" || f === "enriched" || f === "title-synthesized" ? "warn" : ""}`} title={FLAG_HELP[f]}>{f}</span>)}</div> : null}
            <div className="muted" style={{ marginTop: 4 }}>Trecho que sustentou a extração: “{p.import.evidence}”</div></div>}
          {p.draft.source && <p className="small muted">Origem: {[p.draft.source.type, p.draft.source.repository, p.draft.source.ref].filter(Boolean).join(" · ")}</p>}
        </div>
      </div>
      {p.freshness && <ValidityBox f={p.freshness} extraction={p.draft.confidence} classification={p.analysis.classification} onAccept={decided ? undefined : acceptSuggestion} busy={busy} />}
      {decided ? <div className="banner info" style={{ marginTop: 16 }}>Decidida: <b>{RES_LABEL[p.decided?.resolution ?? ""]}</b> por {p.decided?.by.name} {p.decided?.commit && <>· commit <code>{p.decided.commit}</code></>}</div> : (
        <>
          <h2 style={{ marginTop: 20 }}>Decisão</h2>
          <div className="actions" role="group" aria-label="Escolha a resolução" style={{ marginTop: 0 }}>
            {opts.map(({ r, icon }) => <button key={r} className={`choice ${r === p.analysis.suggested_resolution ? "suggested" : ""}`} aria-pressed={res === r} onClick={() => setRes(r)}><span style={{ display: "flex", gap: 6, alignItems: "center" }}>{icon}{RES_LABEL[r]}</span><small>{RES_HELP[r]}</small></button>)}
          </div>
          {needsTarget && !target && <div className="banner" style={{ marginTop: 12 }}>Esta resolução precisa de um conhecimento alvo.</div>}
          {p.freshness && ["create", "keep_separate", "complement", "update", "replace"].includes(res) && <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}><input type="checkbox" checked={hist} onChange={(e) => setHist(e.target.checked)} style={{ width: 15 }} />Registrar como histórico (não representa o estado atual)</label>}
          {previewable && prev && (<div style={{ marginTop: 16 }}>
            <h2>Prévia do resultado {prev.notes[0] && <span className="small muted" style={{ textTransform: "none" }}>{prev.notes[0]}</span>}</h2>
            {edited === undefined ? <Diff before={prev.before ?? ""} after={prev.after} /> : <textarea value={edited} onChange={(e) => setEdited(e.target.value)} aria-label="Corpo final editável" style={{ minHeight: 240 }} />}
            <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setEdited(edited === undefined ? prev.after : undefined)}>{edited === undefined ? "Editar o resultado antes de salvar" : "Voltar à prévia"}</button>
          </div>)}
          <div className="banner info" style={{ marginTop: 14, alignItems: "flex-start" }} aria-live="polite"><div><b>O que acontecerá ao confirmar:</b> {effect(res, p, m?.title, prev?.notes[0], hist)}</div></div>
          <div className="field" style={{ marginTop: 16 }}><label htmlFor="rn">Nota da decisão (opcional, vai para o commit)</label><input id="rn" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="actions" style={{ marginTop: 0 }}><button className="btn primary" disabled={busy || !res || (needsTarget && !target)} onClick={submit}>{RES_LABEL[res] ?? "Confirmar"} e persistir</button></div>
        </>
      )}
    </div>
  );
}

// ---------------- PROJECTS ----------------
interface ProjectDetail { id: string; overview_id?: string; notes: Array<{ id: string; title: string; type: string; status: string; updated_at: string; summary: string; tags: string[] }>; pending: Proposal[]; history: Array<{ hash: string; date: string; author: string; subject: string }>; graph: Graph }
export function ProjectsPage({ id }: { id?: string }) {
  return id ? <ProjectPage id={id} /> : <ProjectList />;
}
function ProjectList() {
  const { data, loading, reload } = useData<Array<{ id: string; title: string; notes: number; last_updated: string; by_type: Record<string, number> }>>("/api/projects");
  const [name, setName] = useState(""); const toast = useToast();
  const create = async () => { try { const slug = name.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); await api("/api/projects", { method: "POST", body: { slug, title: name.trim(), summary: "Descreva o projeto." } }); setName(""); toast("Projeto criado"); reload(); go(`projects/${slug}`); } catch (e) { toast(errMsg(e), true); } };
  return (
    <div className="wrap"><h1>Projetos</h1><p className="sub">Cada projeto reúne decisões, aprendizados, referências e perguntas em aberto.</p>
      {loading && !data ? <Skeleton n={3} /> : data?.length ? <div className="grid cols-2e">{data.map((p) => (
        <a key={p.id} className="card" href={href(`projects/${p.id}`)}><h3>{p.title.replace(/ \(demo\)$/, "")}</h3><div className="muted small" style={{ margin: "4px 0 10px" }}>{p.notes} conhecimentos · atualizado {timeAgo(p.last_updated)}</div>
          <div className="tags">{Object.entries(p.by_type).map(([t, n]) => <span key={t} className="badge type" style={{ ["--c" as string]: `var(--t-${t})` }}>{t} {n}</span>)}</div></a>))}</div> : <Empty title="Nenhum projeto" hint="Crie o primeiro abaixo." />}
      <div className="card" style={{ marginTop: 18, display: "flex", gap: 10 }}><input placeholder="Novo projeto (ex.: Promo Watcher)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} aria-label="Nome do novo projeto" /><button className="btn primary" disabled={!name.trim()} onClick={create}>Criar</button></div>
    </div>
  );
}
const SECTIONS: Array<[string, string, string[]]> = [["decisions", "Decisões", ["decision"]], ["arch", "Arquitetura e padrões", ["pattern", "concept"]], ["learnings", "Aprendizados", ["learning", "fact", "preference"]], ["refs", "Referências", ["reference"]], ["questions", "Perguntas em aberto", ["open-question"]]];
function ProjectPage({ id }: { id: string }) {
  const { data: d, loading, error } = useData<ProjectDetail>(`/api/projects/${id}`, [id]);
  const [tab, setTab] = useState("overview");
  const overview = d?.notes.find((n) => n.id === d.overview_id);
  const full = useData<{ note: { body: string } }>(d?.overview_id ? `/api/notes/${d.overview_id}` : null, [d?.overview_id]);
  if (loading && !d) return <div className="wrap"><Skeleton n={5} /></div>;
  if (!d) return <div className="wrap"><ErrorBox error={error} /></div>;
  return (
    <div className="wrap"><div className="muted small"><a href={href("projects")}>Projetos</a> /</div><h1>{overview?.title.replace(/ \(demo\)$/, "") ?? id}</h1>
      <div className="tabs" role="tablist">{[["overview", "Visão geral"], ...SECTIONS.map(([k, l]) => [k, l]), ["history", "Histórico"], ["related", "Relacionados"]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className="tab" onClick={() => setTab(k!)}>{l}{SECTIONS.find((s) => s[0] === k) ? ` (${d.notes.filter((n) => SECTIONS.find((s) => s[0] === k)![2].includes(n.type)).length})` : ""}</button>)}</div>
      {tab === "overview" && <div className="grid cols-2"><div>{full.data ? <Markdown text={full.data.note.body} /> : <Empty title="Sem visão geral" />}</div>
        <div className="grid" style={{ alignContent: "start" }}><div className="card"><h2>Recentes</h2>{d.notes.slice(0, 6).map((n) => <a key={n.id} className="row" style={{ padding: "6px 0" }} href={href(`note/${n.id}`)}><div className="grow small">{n.title}</div><span className="muted small">{timeAgo(n.updated_at)}</span></a>)}</div>
          {d.pending.length > 0 && <div className="card"><h2>Aguardando revisão</h2>{d.pending.map((p) => <a key={p.id} className="row" style={{ padding: "6px 0" }} href={href(`review/${p.id}`)}><ClassBadge c={p.analysis.classification} /><div className="grow small">{p.draft.title}</div></a>)}</div>}</div></div>}
      {SECTIONS.map(([k, , types]) => tab === k && <div key={k} className="card flush">{d.notes.filter((n) => types.includes(n.type)).map((n) => <a key={n.id} className="row" href={href(`note/${n.id}`)} style={{ alignItems: "flex-start" }}><TypeBadge type={n.type} /><div className="grow"><div className="title">{n.title}</div><div className="muted small">{n.summary.slice(0, 140)}</div></div><span className="muted small">{timeAgo(n.updated_at)}</span></a>)}{!d.notes.some((n) => types.includes(n.type)) && <Empty title="Nada aqui ainda" />}</div>)}
      {tab === "history" && <div className="card flush">{d.history.length ? d.history.map((h) => <div key={h.hash} className="row"><code className="mono small">{h.hash}</code><div className="grow">{h.subject}<div className="meta"><span>{h.author}</span><span>{timeAgo(h.date)}</span></div></div></div>) : <Empty title="Sem histórico" />}</div>}
      {tab === "related" && (d.graph.edges.length ? <GraphView graph={d.graph} height={420} /> : <Empty title="Sem relações ainda" hint="Use relações (applies_to, depends_on...) para conectar conhecimentos." />)}
    </div>
  );
}

// ---------------- TIMELINE / AGENTS ----------------
export function TimelinePage({ actor }: { actor?: string }) {
  const { data, loading } = useData<Array<{ id: number; ts: string; actor_name: string; actor_kind: string; action: string; target_id: string | null; detail: Record<string, unknown> }>>(`/api/timeline?limit=200${actor ? `&actor=${encodeURIComponent(actor)}` : ""}`, [actor], 10000);
  const groups = useMemo(() => { const g: Array<[string, typeof data]> = []; for (const e of data ?? []) { const d = new Date(e.ts).toDateString(); const last = g[g.length - 1]; if (last && last[0] === d) last[1]!.push(e); else g.push([d, [e]]); } return g; }, [data]);
  const text = (e: { action: string; detail: Record<string, unknown>; target_id: string | null }) => {
    const t = e.target_id ? <a href={href(e.action.startsWith("propos") || e.action === "propose" ? `review/${e.target_id}` : `note/${e.target_id}`)} style={{ textDecoration: "underline" }}>{String(e.detail.title ?? e.target_id)}</a> : null;
    switch (e.action) {
      case "search": return <>Buscou “{String(e.detail.query)}” ({String(e.detail.results)} resultados)</>;
      case "context": return <>Pediu contexto {e.detail.project ? <>de {String(e.detail.project)}</> : null}</>;
      case "read": return <>Leu {t}</>; case "propose": return <>Propôs {String(e.detail.title)} <span className="badge">{String(e.detail.classification)}</span></>;
      case "resolve": return <>Decidiu <b>{RES_LABEL[String(e.detail.resolution)] ?? String(e.detail.resolution)}</b> {t}</>;
      case "create": return <>Criou {t}</>; case "update": return <>Atualizou {t}</>; case "link": return <>Relacionou {t} → {String(e.detail.dst)}</>;
      case "import": return <>Importou {String(e.detail.queued)} candidato(s) de <b>{String(e.detail.source).split("/").pop()}</b> para revisão</>;
      case "import_preview": return <>Analisou uma fonte para importação ({String(e.detail.candidates)} candidatos, nada gravado)</>;
      case "git_revert": return <>Reverteu o commit {String(e.detail.rev)}</>;
      case "config_update": return <>Alterou configurações ({Array.isArray(e.detail.keys) ? (e.detail.keys as string[]).join(", ") : ""})</>;
      case "external_edit": return <>Edição externa (Obsidian) {t}</>; case "git_commit": return <>Commit manual ({String(e.detail.files)} arquivos)</>;
      default: return <>{e.action} {t}</>;
    }
  };
  return (
    <div className="wrap"><h1>Timeline{actor ? ` · ${actor}` : ""}</h1><p className="sub">Atividade operacional (SQLite). O conhecimento durável e suas mudanças ficam no Git.</p>
      {loading && !data ? <Skeleton n={5} /> : !data?.length ? <Empty title="Sem atividade" /> : <div className="timeline">{groups.map(([day, items]) => <div key={day}><div className="day">{new Date(items![0]!.ts).toDateString() === new Date().toDateString() ? "Hoje" : new Date(items![0]!.ts).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}</div>
        {items!.map((e) => <div key={e.id} className="tl" style={{ ["--c" as string]: e.actor_kind === "agent" ? "var(--accent)" : e.actor_kind === "human" ? "var(--info)" : "var(--faint)" }}><span className="t">{new Date(e.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span><b>{e.actor_name}</b> <span className="muted">{text(e)}</span></div>)}</div>)}</div>}
    </div>
  );
}
export function AgentsPage() {
  const { data } = useData<Array<{ name: string; kind: string; n: number; last: string; reads: number; writes: number }>>("/api/agents", [], 10000);
  return (
    <div className="wrap"><h1>Agentes</h1><p className="sub">Quem consulta e contribui. Serve para auditoria, não para ranking.</p>
      <div className="card flush">{data?.length ? <><div className="row muted small" style={{ fontWeight: 600 }}><div className="grow">Agente</div><div style={{ width: 90 }}>Consultas</div><div style={{ width: 100 }}>Contribuições</div><div style={{ width: 110 }}>Última atividade</div></div>
        {data.map((a) => <a key={a.name} className="row" href={href(`timeline?actor=${a.name}`)}><i className="dot" style={{ ["--c" as string]: a.kind === "agent" ? "var(--accent)" : "var(--info)" }} /><div className="grow">{a.name} <span className="muted small">{a.kind}</span></div><div style={{ width: 90 }} className="sim">{a.reads}</div><div style={{ width: 100 }} className="sim">{a.writes}</div><div style={{ width: 110 }} className="muted small">{timeAgo(a.last)}</div></a>)}</> : <Empty title="Nenhum agente conectou" hint="Configure o MCP (Configurações → Conectar agentes)." />}</div></div>
  );
}

// ---------------- GRAPH ----------------
type Graph = GraphData;
// three.js só é baixado quando o grafo 3D é aberto
const Graph3D = lazy(() => import("./Graph3D"));
const Graph2D = lazy(() => import("./Graph2D"));
const VIEW_KEY = "brain.graph.view";
const hasWebGL = () => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") ?? c.getContext("webgl")); } catch { return false; } };
export function GraphView({ graph, height = 560 }: { graph: Graph; height?: number }) {
  const W = 960; const H = height;
  const pos = useMemo(() => {
    const ids = graph.nodes.map((n) => n.id);
    const p = new Map(ids.map((id, i) => [id, { x: W / 2 + Math.cos(i * 2.399) * (60 + i * 4), y: H / 2 + Math.sin(i * 2.399) * (60 + i * 4), vx: 0, vy: 0 }]));
    for (let it = 0; it < 260; it++) {
      for (const a of ids) for (const b of ids) { if (a >= b) continue; const A = p.get(a)!; const B = p.get(b)!; let dx = A.x - B.x; let dy = A.y - B.y; const d2 = dx * dx + dy * dy + 0.01; const f = 5200 / d2; const d = Math.sqrt(d2); dx /= d; dy /= d; A.vx += dx * f; A.vy += dy * f; B.vx -= dx * f; B.vy -= dy * f; }
      for (const e of graph.edges) { const A = p.get(e.src); const B = p.get(e.dst); if (!A || !B) continue; const dx = B.x - A.x; const dy = B.y - A.y; const d = Math.sqrt(dx * dx + dy * dy) || 1; const f = (d - 110) * 0.02; A.vx += (dx / d) * f; A.vy += (dy / d) * f; B.vx -= (dx / d) * f; B.vy -= (dy / d) * f; }
      for (const n of p.values()) { n.vx += (W / 2 - n.x) * 0.004; n.vy += (H / 2 - n.y) * 0.004; n.x = Math.min(W - 40, Math.max(40, n.x + n.vx * 0.6)); n.y = Math.min(H - 24, Math.max(24, n.y + n.vy * 0.6)); n.vx *= 0.7; n.vy *= 0.7; }
    }
    return p;
  }, [graph, W, H]);
  const [hover, setHover] = useState<string>();
  const near = useMemo(() => { const s = new Set<string>(); if (hover) { s.add(hover); for (const e of graph.edges) { if (e.src === hover) s.add(e.dst); if (e.dst === hover) s.add(e.src); } } return s; }, [hover, graph]);
  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Grafo de conhecimento" style={{ height }}>
      {graph.edges.map((e, i) => { const a = pos.get(e.src); const b = pos.get(e.dst); if (!a || !b) return null; return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={{ opacity: hover && !(near.has(e.src) && near.has(e.dst)) ? 0.12 : 1, stroke: e.type === "supersedes" || e.type === "superseded_by" ? "var(--warn)" : e.type === "contradicts" ? "var(--danger)" : undefined }} />; })}
      {graph.nodes.map((n) => { const p = pos.get(n.id)!; const dim = hover && !near.has(n.id); return (
        <g key={n.id} style={{ opacity: dim ? 0.2 : 1 }} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(undefined)} onClick={() => go(`note/${n.id}`)}>
          <circle cx={p.x} cy={p.y} r={n.type === "project" ? 11 : 7} fill={`var(--t-${n.type})`} /><text x={p.x + 12} y={p.y + 4}>{n.title.length > 28 ? n.title.slice(0, 27) + "…" : n.title}</text></g>); })}
    </svg>
  );
}
export function GraphPage() {
  // um link #/graph?… aberto de dentro do grafo é navegação real (hashchange): remonta com o novo estado
  const route = useRoute(); const navKey = route.query.toString();
  const { data, loading, reload } = useData<Graph>("/api/graph");
  const { data: meta } = useData<{ can_review: boolean }>("/api/meta");
  // visão: URL (?view=) > preferência do navegador > 3D se houver WebGL
  const [view, setView] = useState<"3d" | "2d">(() => { const v = readGraphQuery().get("view"); if (v === "2d" || (v === "3d" && hasWebGL())) return v; try { return localStorage.getItem(VIEW_KEY) === "2d" || !hasWebGL() ? "2d" : "3d"; } catch { return hasWebGL() ? "3d" : "2d"; } });
  const pick = (v: "3d" | "2d") => { setView(v); writeGraphQuery({ view: v }); try { localStorage.setItem(VIEW_KEY, v); } catch { /* preferência só desta sessão */ } };
  const unsupported = useCallback(() => setView("2d"), []);
  return <div className="wrap wide"><div className="row-head"><div><h1>Grafo</h1><p className="sub">{view === "3d" ? "Cada projeto é um núcleo e seus conhecimentos orbitam ao redor. Projetos ligados se citam nas notas: passe o mouse na linha para ver o porquê e clique para fixar. Arraste para girar, role para aproximar, clique para abrir." : "Cada projeto é um agrupamento com suas notas dentro. As linhas ligam projetos que se citam (tracejada = só derivada das notas; cheia = relação registrada): passe o mouse para ver o porquê e clique para fixar e registrar. Filtre por tipo na legenda, use a linha do tempo, role para aproximar e arraste para mover. A URL guarda a visão."}</p></div>
    <div className="view-toggle" role="group" aria-label="Visualização"><button aria-pressed={view === "3d"} onClick={() => pick("3d")} disabled={!hasWebGL()} title={hasWebGL() ? undefined : "WebGL indisponível neste navegador"}>3D</button><button aria-pressed={view === "2d"} onClick={() => pick("2d")}>2D</button></div></div>
    {loading && !data ? <Skeleton n={4} /> : !data?.nodes.length ? <Empty title="Sem conhecimento" /> : view === "3d"
      ? <Suspense fallback={<div className="g3d" style={{ height: "calc(100vh - 236px)" }}><div className="g3d-boot"><i /> carregando</div></div>}><Graph3D graph={data} height="calc(100vh - 236px)" onUnsupported={unsupported} canReview={meta?.can_review} onChanged={reload} /></Suspense>
      : <Suspense fallback={<Skeleton n={4} />}><Graph2D key={navKey} graph={data} height="calc(100vh - 236px)" canReview={meta?.can_review} onChanged={reload} /></Suspense>}
  </div>;
}
