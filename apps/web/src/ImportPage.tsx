import { useState } from "react";
import { api, type Analysis } from "./api";
import { ClassBadge, Empty, ErrorBox, Markdown, TypeBadge, errMsg, go, href, useData, useToast } from "./lib";
import type { Freshness } from "@brain/shared";
import { EFFORT_LABEL, FRESH_LABEL, FreshBadge } from "./Freshness";

interface Cand { id: string; title: string; type: string; body: string; tags: string[]; confidence: string; rule: string; evidence: string; source: { path: string; heading?: string }; why?: string[]; parent?: string; flags?: string[]; freshness?: Freshness }
interface Item { candidate: Cand; analysis: Analysis; status: string; reason?: string; source_ref: string }
interface Report { run: string; repo: string; project?: string; source: string; files: number; skipped_files: Record<string, number>; skipped_sections: number; candidates: number; dropped_similar: number; counts: Record<string, number>; items: Item[]; rejected?: Array<{ title: string; reason: string; source: { path: string; heading?: string } }>; freshness?: { against?: string; states: Record<string, number>; effort: Record<string, number>; ms: number } }

const CONF_LABEL: Record<string, string> = { high: "alta", medium: "média", low: "baixa" };

export function ImportPage() {
  const toast = useToast();
  const { data: projects } = useData<Array<{ id: string; title: string }>>("/api/projects");
  const [kind, setKind] = useState<"text" | "path">("text");
  const [text, setText] = useState(""); const [path, setPath] = useState(""); const [project, setProject] = useState(""); const [gitLog, setGitLog] = useState(false);
  const [rep, setRep] = useState<Report>(); const [sel, setSel] = useState<Set<string>>(new Set()); const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string>();

  const analyze = async () => {
    setBusy(true); setErr(undefined); setRep(undefined);
    try {
      const r = await api<Report>("/api/import/preview", { method: "POST", body: { kind, text, path, project: project || undefined, gitLog } });
      setRep(r); setSel(new Set(r.items.filter((i) => i.status !== "rejected" && i.analysis.classification !== "duplicate" && i.candidate.freshness?.suggestion !== "ignore").map((i) => i.candidate.id))); // plano sem implementação / doc desatualizada: desmarcados (podem ser marcados)
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!rep) return; setBusy(true);
    try {
      const chosen = rep.items.filter((i) => sel.has(i.candidate.id)).map((i) => ({ ...i.candidate, source_ref: i.source_ref }));
      const out = await api<{ queued: number; items: Array<{ status: string; reason?: string }> }>("/api/import/submit", { method: "POST", body: { candidates: chosen, project: rep.project, repo: rep.repo, source: rep.source } });
      const rej = out.items.filter((i) => i.status === "rejected").length;
      toast(`${out.queued} proposta(s) enviadas para a revisão${rej ? ` · ${rej} rejeitada(s) (segredo/tamanho)` : ""}`); go("review");
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const rows = rep?.items.filter((i) => i.status !== "rejected") ?? []; const rejected = rep?.items.filter((i) => i.status === "rejected") ?? [];
  const valid = kind === "text" ? text.trim().length >= 40 : path.trim().startsWith("/");

  return (
    <div className="wrap">
      <h1>Importar conhecimento</h1>
      <p className="sub">Analisa uma fonte, extrai <b>candidatos</b> a conhecimento durável e os envia à Review Queue. Nada entra na base sem a sua decisão — e documentos inteiros nunca são copiados.</p>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>
          <button role="tab" className="tab" aria-selected={kind === "text"} onClick={() => setKind("text")}>Texto / Markdown colado</button>
          <button role="tab" className="tab" aria-selected={kind === "path"} onClick={() => setKind("path")}>Pasta ou repositório Git</button>
        </div>
        {kind === "text" ? <div className="field"><label htmlFor="it">Cole Markdown ou notas (seções com cabeçalhos rendem mais candidatos)</label><textarea id="it" value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 160 }} placeholder="## Decisão: …" /></div>
          : <div className="field"><label htmlFor="ip">Caminho absoluto (dentro da sua home, no WSL)</label><input id="ip" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/voce/projetos/meu-projeto" />
              <div className="small muted" style={{ marginTop: 6 }}>Lê README, AGENTS.md, ADRs e docs/ respeitando .gitignore; ignora node_modules, binários, arquivos grandes e segredos. Não modifica o repositório.</div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0 0" }}><input type="checkbox" checked={gitLog} onChange={(e) => setGitLog(e.target.checked)} style={{ width: 16 }} /> incluir decisões encontradas no histórico Git (baixa confiança)</label></div>}
        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <div className="field" style={{ margin: 0, minWidth: 220 }}><label htmlFor="ipr">Projeto</label>
            <input id="ipr" list="projs" value={project} onChange={(e) => setProject(e.target.value)} placeholder={kind === "path" ? "(nome do repositório)" : "(global)"} /><datalist id="projs">{projects?.map((p) => <option key={p.id} value={p.id} />)}</datalist></div>
          <button className="btn primary" disabled={!valid || busy} onClick={analyze}>{busy && !rep ? "Analisando…" : "Analisar"}</button>
        </div>
      </div>
      <ErrorBox error={err} />
      {rep && (
        <section aria-label="Resultado da análise">
          <div className="card" style={{ marginBottom: 12 }}>
            <b>{rep.candidates} candidato(s)</b> em {rep.files} arquivo(s) de <code className="mono">{rep.repo}</code>
            <span className="muted small"> · {rep.skipped_sections} seção(ões) sem sinal de conhecimento durável ignoradas · {rep.dropped_similar} quase-idêntico(s) descartado(s)</span>
            {rep.freshness && <div className="small muted" style={{ marginTop: 4 }}>Atualidade{rep.freshness.against ? <> verificada contra <code>{rep.freshness.against}</code></> : ""}: {Object.entries(rep.freshness.states).map(([k, n]) => `${FRESH_LABEL[k] ?? k} ${n}`).join(" · ")} — revisão: {Object.entries(rep.freshness.effort).map(([k, n]) => `${EFFORT_LABEL[k] ?? k} ${n}`).join(" · ")}</div>}
            <div className="tags" style={{ marginTop: 8 }}>{Object.entries(rep.counts).map(([k, v]) => <span key={k} className="badge">{k} {v}</span>)}{Object.entries(rep.skipped_files).map(([k, v]) => <span key={k} className="badge">{k}: {v}</span>)}</div>
          </div>
          {rows.length ? (
            <div className="card flush">
              <div className="row" style={{ position: "sticky", top: 0, background: "var(--panel)", zIndex: 1 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}><input type="checkbox" style={{ width: 16 }} checked={sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.candidate.id)) : new Set())} aria-label="Selecionar todos" /> {sel.size} de {rows.length} selecionado(s)</label>
                <div className="grow" /><button className="btn primary sm" disabled={!sel.size || busy} onClick={submit}>Enviar {sel.size} para a Review Queue</button>
              </div>
              {rows.map((i) => { const c = i.candidate; const top = i.analysis.matches[0]; return (
                <div key={c.id} style={{ borderTop: "1px solid var(--line)" }}>
                  <div className="row" style={{ borderTop: 0, alignItems: "flex-start" }}>
                    <input type="checkbox" style={{ width: 16, marginTop: 4 }} checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Selecionar ${c.title}`} />
                    <div className="grow">
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><TypeBadge type={c.type} /><ClassBadge c={i.analysis.classification} /><button className="btn ghost sm" style={{ padding: 0, fontWeight: 500, textAlign: "left" }} onClick={() => setOpen(open === c.id ? undefined : c.id)} aria-expanded={open === c.id}>{c.title}</button></div>
                      <div className="meta" style={{ marginTop: 3 }}><span className="mono">{i.source_ref.length > 70 ? i.source_ref.slice(0, 70) + "…" : i.source_ref}</span><span className={c.confidence === "low" ? "badge danger" : c.confidence === "medium" ? "badge warn" : "badge ok"}>confiança {CONF_LABEL[c.confidence] ?? c.confidence}</span><FreshBadge f={c.freshness} />{c.flags?.includes("heading-based") && <span className="badge warn" title="Tipo sugerido pelo cabeçalho">baseado em cabeçalho</span>}<span>regra {c.rule}</span>{top && i.analysis.classification !== "new" && <span>≈ {Math.round(top.similarity * 100)}% <a href={href(`note/${top.id}`)} style={{ textDecoration: "underline" }}>{top.title}</a></span>}</div>
                    </div>
                  </div>
                  {open === c.id && <div style={{ padding: "0 18px 14px 44px" }}><div className="pane"><Markdown text={c.body} />{c.why?.length ? <div className="small" style={{ marginTop: 8 }}><b>Por que virou candidato:</b><ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>{c.why.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}{c.parent && <div className="small muted" style={{ marginTop: 4 }}>Seção: {c.parent}</div>}<div className="small muted" style={{ marginTop: 4 }}><b>Trecho que sustentou a extração:</b> “{c.evidence}”</div>{c.freshness && <div className="small" style={{ marginTop: 6 }}><b>Atualidade:</b> {c.freshness.summary} <span className="muted">({EFFORT_LABEL[c.freshness.effort]})</span><ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>{c.freshness.evidence.slice(0, 4).map((e, k) => <li key={k}><code>{e.ref}</code> — {e.detail}</li>)}</ul></div>}{i.analysis.warnings.map((w) => <div key={w} className="banner" style={{ marginTop: 8 }}>{w}</div>)}</div></div>}
                </div>); })}
            </div>
          ) : <Empty title="Nenhum candidato encontrado" hint="A fonte não tem seções com sinais de decisão, aprendizado, regra ou pergunta. Tente ADRs, README ou docs com cabeçalhos." />}
          {(rep.rejected?.length ?? 0) > 0 && <details className="card" style={{ marginTop: 12 }}><summary style={{ cursor: "pointer" }}><b>{rep.rejected!.length} trecho(s) descartado(s) pelos filtros de qualidade</b> <span className="muted small">(precisão antes de recall — veja por quê)</span></summary>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>{rep.rejected!.slice(0, 40).map((r, i) => <li key={i} className="small"><b>{r.title}</b> — <span className="muted">{r.reason}</span></li>)}</ul></details>}
          {rejected.length > 0 && <div className="banner" style={{ marginTop: 12 }}>{rejected.length} candidato(s) bloqueado(s) automaticamente: {[...new Set(rejected.map((r) => (r.reason ?? "").split(":")[0]))].join(", ")} (segredo ou tamanho).</div>}
        </section>
      )}
    </div>
  );
}
