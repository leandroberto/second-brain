import { useState } from "react";
import { Check, X } from "lucide-react";
import { api } from "./api";
import { errMsg, go, useToast } from "./lib";

export interface GraphNode { id: string; title: string; type: string; status: string; project?: string; updated_at?: string; created_at?: string }
export interface ProjectInfo { id: string; name: string; title: string }
/** Uma nota que sustenta a ligação: quem cita (`from`), quem é citado (`to`) e o trecho onde a citação aparece. */
export interface LinkEvidence { id: string; title: string; from: string; to: string; snippet: string }
/** Ligação entre projetos derivada das notas que citam o outro projeto (calculada pelo Core, com evidência). */
export interface ProjectLink { a: string; b: string; weight: number; evidence: LinkEvidence[]; evidence_ids?: string[]; overview?: { a?: string; b?: string }; confirmed?: string }
export interface GraphData { nodes: GraphNode[]; edges: Array<{ src: string; dst: string; type: string }>; projects?: ProjectInfo[]; project_links?: ProjectLink[] }

export const NONE = "__sem-projeto__";
export const TYPES = ["decision", "learning", "fact", "preference", "pattern", "reference", "concept", "open-question", "project"];
export const TYPE_LABEL: Record<string, string> = { decision: "decisão", learning: "aprendizado", fact: "fato", preference: "preferência", pattern: "padrão", reference: "referência", concept: "conceito", "open-question": "questão aberta", project: "projeto" };
export const REL_TYPES = ["related_to", "depends_on", "references", "applies_to", "implements", "derived_from", "contradicts"] as const;
export const REL_LABEL: Record<string, string> = { depends_on: "depende de", applies_to: "aplica-se a", implements: "implementa", references: "referencia", contradicts: "contradiz", supersedes: "substitui", superseded_by: "substituída por", related_to: "relacionada a", derived_from: "derivada de", link: "link [[wiki]]" };
export const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** O que o cartão mostra sobre uma aresta: ligação entre projetos (com as notas-evidência) ou relação explícita entre notas. */
export type EdgeInfo =
  | { kind: "project"; a: string; b: string; weight: number; evidence: LinkEvidence[]; names: Record<string, string>; overview?: { a?: string; b?: string }; confirmed?: string }
  | { kind: "relation"; type: string; src: { id: string; title: string }; dst: { id: string; title: string } }
  | { kind: "mention"; src: { id: string; title: string }; dst: { id: string; title: string }; snippet: string };

/** Cartão do porquê de uma aresta. `pinned` mostra os links das notas e o botão de fechar. */
export function EdgeCard({ edge, pinned, onClose, className, canReview, onChanged }: { edge: EdgeInfo; pinned?: boolean; onClose?: () => void; className?: string; canReview?: boolean; onChanged?: () => void }) {
  if (edge.kind === "mention") {
    return (
      <div className={`edge-card ${className ?? ""}`} role="status">
        <div className="edge-kicker">menção · derivada do texto</div>
        <div className="edge-title"><a href={`#/note/${edge.src.id}`}>{edge.src.title}</a> <span className="edge-arrow">→ cita</span> <a href={`#/note/${edge.dst.id}`}>{edge.dst.title}</a></div>
        <ul className="edge-evidence"><li><q>{edge.snippet}</q></li></ul>
        <div className="edge-hint">nada foi gravado; registre a relação em "Sugestões de relação"</div>
        {pinned && onClose && <button className="edge-close" onClick={onClose} aria-label="Fechar"><X size={14} /></button>}
      </div>
    );
  }
  if (edge.kind === "relation") {
    return (
      <div className={`edge-card ${className ?? ""}`} role="status">
        <div className="edge-kicker">relação explícita · {REL_LABEL[edge.type] ?? edge.type}</div>
        <div className="edge-title"><a href={`#/note/${edge.src.id}`}>{edge.src.title}</a> <span className="edge-arrow">→</span> <a href={`#/note/${edge.dst.id}`}>{edge.dst.title}</a></div>
        <div className="edge-hint">definida no frontmatter ou num link [[wiki]] da nota de origem</div>
        {pinned && onClose && <button className="edge-close" onClick={onClose} aria-label="Fechar"><X size={14} /></button>}
      </div>
    );
  }
  const name = (p: string) => edge.names[p] ?? p;
  return (
    <div className={`edge-card ${className ?? ""}`} role="status">
      <div className="edge-kicker">ligação entre projetos · {edge.weight} {edge.weight === 1 ? "nota cita" : "notas citam"} o outro lado</div>
      <div className="edge-title">{name(edge.a)} <span className="edge-arrow">↔</span> {name(edge.b)}</div>
      <ul className="edge-evidence">
        {edge.evidence.slice(0, pinned ? 5 : 3).map((e) => (
          <li key={e.id}>
            <div className="edge-dir">{name(e.from)} → cita {name(e.to)}</div>
            <q>{e.snippet}</q>
            {pinned ? <button className="edge-open" onClick={() => go(`note/${e.id}`)}>abrir “{e.title.length > 60 ? `${e.title.slice(0, 59)}…` : e.title}”</button> : null}
          </li>
        ))}
      </ul>
      {edge.weight > edge.evidence.length && <div className="edge-hint">+{edge.weight - edge.evidence.length} nota(s)</div>}
      {edge.confirmed ? <div className="edge-ok"><Check size={13} /> registrada como relação explícita ({REL_LABEL[edge.confirmed] ?? edge.confirmed})</div>
        : pinned && edge.overview?.a && edge.overview?.b ? <RegisterRelation src={edge.overview.a} dst={edge.overview.b} label={`${name(edge.a)} → ${name(edge.b)}`} labelReversed={`${name(edge.b)} → ${name(edge.a)}`} canReview={canReview} onDone={onChanged} />
        : null}
      <div className="edge-hint">{pinned ? (edge.confirmed ? "a ligação também continua derivada das notas acima" : "derivada das notas: nada foi gravado até você registrar") : edge.confirmed ? "relação registrada · clique para fixar" : "linha tracejada = só derivada das notas · clique para fixar"}</div>
      {pinned && onClose && <button className="edge-close" onClick={onClose} aria-label="Fechar"><X size={14} /></button>}
    </div>
  );
}

/**
 * Registra uma relação explícita (ação do REVISOR: com o token de agente a API recusa, então o botão fica desabilitado e diz por quê).
 * Nada é registrado sozinho: é sempre um clique humano com o tipo escolhido.
 */
export function RegisterRelation({ src, dst, label, labelReversed, canReview, onDone, defaultType = "related_to" }: { src: string; dst: string; label: string; labelReversed?: string; canReview?: boolean; onDone?: () => void; defaultType?: string }) {
  const [type, setType] = useState(defaultType); const [busy, setBusy] = useState(false); const [rev, setRev] = useState(false); const toast = useToast();
  // sentido importa para "depende de"/"implementa": quando há rótulo do sentido inverso, o revisor pode trocar
  const [from, to, text] = rev ? [dst, src, labelReversed ?? label] : [src, dst, label];
  const save = async () => {
    setBusy(true);
    try { await api(`/api/notes/${encodeURIComponent(from)}/links`, { method: "POST", body: { to, type } }); toast(`Relação registrada: ${text} (${REL_LABEL[type] ?? type})`); onDone?.(); }
    catch (e) { toast(errMsg(e), true); } finally { setBusy(false); }
  };
  return (
    <div className="edge-register">
      {labelReversed && <div className="edge-dirsel"><b>{text}</b> <button className="linkish" onClick={() => setRev((r) => !r)} disabled={busy} aria-label="Inverter o sentido da relação">⇄ inverter</button></div>}
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo de relação" disabled={!canReview || busy}>{REL_TYPES.map((t) => <option key={t} value={t}>{REL_LABEL[t] ?? t}</option>)}</select>
      <button className="btn small" onClick={save} disabled={!canReview || busy} title={canReview ? `Registrar ${label} no conhecimento (commit no vault)` : "Exige sessão de revisor: num terminal, rode brain ui"}>Registrar relação</button>
      {!canReview && <div className="edge-hint">registrar exige sessão de revisor (brain ui num terminal)</div>}
    </div>
  );
}

/** Estado do grafo na URL (#/graph?view=2d&focus=…): compartilhável e sobrevive ao recarregar. Não dispara navegação. */
export function readGraphQuery(): URLSearchParams { const [, q = ""] = location.hash.split("?"); return new URLSearchParams(q); }
export function writeGraphQuery(patch: Record<string, string | undefined>) {
  const [path = "", q = ""] = location.hash.split("?");
  if (!/^#\/graph\/?$/.test(path)) return; // já saiu do grafo (ex.: um tick do "play" depois de clicar numa nota)
  const p = new URLSearchParams(q);
  for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
  const s = p.toString(); const next = `${path}${s ? `?${s}` : ""}`;
  if (next !== location.hash) history.replaceState(history.state, "", next);
}
