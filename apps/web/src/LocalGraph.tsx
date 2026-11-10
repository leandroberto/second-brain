import { useMemo, useState } from "react";
import { go, useData, Skeleton, ErrorBox } from "./lib";
import { EdgeCard, REL_LABEL, TYPE_LABEL, type EdgeInfo } from "./graphShared";

/**
 * Grafo LOCAL de uma nota: a vizinhança até 1, 2 ou 3 passos, em anéis concêntricos (a nota no centro). Arestas:
 * pertence ao projeto (discreta), cita outro projeto (tracejada, com o trecho) e relações explícitas (cor e traço pelo tipo).
 * Clicar num nó abre a nota, que vira o novo centro.
 */
interface LNode { id: string; title: string; type: string; status: string; project?: string; depth: number }
interface LEdge { src: string; dst: string; kind: "member" | "mention" | "relation"; type?: string; snippet?: string }
interface Local { center: string; depth: number; nodes: LNode[]; edges: LEdge[]; projects: Array<{ id: string; name: string; overview_id?: string }> }

const RING = [0, 150, 270, 380];

export default function LocalGraph({ id }: { id: string }) {
  const [depth, setDepth] = useState(1);
  const { data, error, loading } = useData<Local>(`/api/notes/${encodeURIComponent(id)}/local?depth=${depth}`, [id, depth]);
  const [hover, setHover] = useState<string>(); const [edge, setEdge] = useState<EdgeInfo>(); const [pin, setPin] = useState<EdgeInfo>();
  const L = useMemo(() => (data ? layout(data) : undefined), [data]);
  if (loading && !data) return <Skeleton n={4} />;
  if (!data || !L) return <ErrorBox error={error} />;
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const hub = new Set(data.projects.map((p) => p.overview_id).filter(Boolean));
  const near = hover ? new Set([hover, ...data.edges.flatMap((e) => (e.src === hover ? [e.dst] : e.dst === hover ? [e.src] : []))]) : undefined;
  const labelAll = data.nodes.length <= 30;
  const info = (e: LEdge): EdgeInfo | undefined => {
    const a = byId.get(e.src)!; const b = byId.get(e.dst)!;
    if (e.kind === "mention") return { kind: "mention", src: a, dst: b, snippet: e.snippet ?? "" };
    if (e.kind === "relation") return { kind: "relation", type: e.type ?? "related_to", src: a, dst: b };
    return undefined;
  };
  const counts = { member: data.edges.filter((e) => e.kind === "member").length, mention: data.edges.filter((e) => e.kind === "mention").length, relation: data.edges.filter((e) => e.kind === "relation").length };
  return (
    <div className="lg" data-testid="local-graph">
      <div className="lg-bar">
        <div className="view-toggle" role="group" aria-label="Profundidade">{[1, 2, 3].map((d) => <button key={d} aria-pressed={depth === d} onClick={() => setDepth(d)}>{d} {d === 1 ? "passo" : "passos"}</button>)}</div>
        <span className="muted small">{data.nodes.length} notas · {counts.mention} citações · {counts.relation} relações · {counts.member} de projeto</span>
      </div>
      <div className="lg-canvas">
        <svg viewBox={L.viewBox} role="img" aria-label={`Vizinhança da nota: ${data.nodes.length} notas até ${data.depth} passos`}>
          {RING.slice(1, data.depth + 1).map((r) => <circle key={r} r={r} className="lg-ring" />)}
          {data.edges.map((e) => { const a = L.pos.get(e.src); const b = L.pos.get(e.dst); if (!a || !b) return null; const inf = info(e); const dim = near && !(near.has(e.src) && near.has(e.dst));
            return (
              <g key={`${e.src}|${e.dst}|${e.kind}|${e.type ?? ""}`} className={`lg-edge ${e.kind}${e.type ? ` rel-${e.type}` : ""}${dim ? " dim" : ""}${!near && e.kind === "mention" && e.src !== data.center && e.dst !== data.center ? " far" : ""}`}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="line" />
                {inf && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="hit" onPointerEnter={() => setEdge(inf)} onPointerLeave={() => setEdge(undefined)} onClick={() => setPin(inf)} />}
              </g>); })}
          {data.nodes.map((n) => { const p = L.pos.get(n.id)!; const center = n.id === data.center; const isHub = hub.has(n.id); const dim = near && !near.has(n.id);
            const r = center ? 11 : isHub ? 8 : 5.5; const showLabel = center || n.depth <= 1 || labelAll || hover === n.id;
            return (
              <g key={n.id} className={`lg-node${center ? " center" : ""}${isHub ? " hub" : ""}${dim ? " dim" : ""}`} style={{ ["--c" as string]: `var(--t-${n.type})` }}
                onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(undefined)} onClick={() => go(`note/${n.id}`)} data-testid={center ? "local-center" : undefined}>
                <circle cx={p.x} cy={p.y} r={r} />
                {showLabel && <text x={p.x + (p.x < -1 ? -(r + 5) : r + 5)} y={p.y + 4} textAnchor={p.x < -1 ? "end" : "start"}>{short(isHub ? data.projects.find((x) => x.overview_id === n.id)?.name ?? n.title : n.title)}</text>}
                <title>{`${TYPE_LABEL[n.type] ?? n.type}: ${n.title}`}</title>
              </g>); })}
        </svg>
        {(edge ?? pin) && <EdgeCard className="lg-card" edge={(edge ?? pin)!} pinned={!edge} onClose={() => setPin(undefined)} />}
      </div>
      <div className="lg-legend">
        <span><i className="member" />pertence ao projeto</span><span><i className="mention" />cita outro projeto (passe o mouse para ver o trecho)</span>
        {[...new Set(data.edges.filter((e) => e.kind === "relation").map((e) => e.type ?? ""))].map((t) => <span key={t} className={`rel-${t}`}><i className="relation" />{REL_LABEL[t] ?? t}</span>)}
      </div>
    </div>
  );
}

const short = (t: string) => (t.length > 34 ? `${t.slice(0, 33)}…` : t);

/**
 * Anéis por distância. No 1º anel as notas se espalham por igual (agrupadas por projeto/tipo); do 2º em diante cada nota fica
 * no ARCO do seu pai no anel anterior (de preferência a visão geral do seu projeto), com arco proporcional ao número de filhos.
 */
function layout(d: Local) {
  type P = { x: number; y: number; a: number };
  const pos = new Map<string, P>([[d.center, { x: 0, y: 0, a: 0 }]]);
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const member = new Map<string, string>(); // nota → visão geral do projeto
  const adj = new Map<string, string[]>();
  for (const e of d.edges) { adj.set(e.src, [...(adj.get(e.src) ?? []), e.dst]); adj.set(e.dst, [...(adj.get(e.dst) ?? []), e.src]); if (e.kind === "member") member.set(e.src, e.dst); }
  const put = (id: string, a: number, R: number) => pos.set(id, { x: Math.cos(a) * R, y: Math.sin(a) * R, a });
  const ring1 = d.nodes.filter((n) => n.depth === 1).sort((x, y) => (x.project ?? "").localeCompare(y.project ?? "") || x.type.localeCompare(y.type) || x.title.localeCompare(y.title));
  ring1.forEach((n, i) => put(n.id, -Math.PI / 2 + (i / Math.max(1, ring1.length)) * Math.PI * 2, RING[1]!));
  for (let k = 2; k <= d.depth; k++) {
    const ring = d.nodes.filter((n) => n.depth === k);
    const parentOf = (n: LNode) => { const m = member.get(n.id); if (m && byId.get(m)?.depth === k - 1) return m; return (adj.get(n.id) ?? []).find((x) => byId.get(x)?.depth === k - 1) ?? d.center; };
    const groups = new Map<string, LNode[]>();
    for (const n of ring) { const p = parentOf(n); groups.set(p, [...(groups.get(p) ?? []), n]); }
    const parents = [...groups.keys()].sort((x, y) => (pos.get(x)?.a ?? 0) - (pos.get(y)?.a ?? 0));
    const total = ring.length || 1; const first = parents[0] ? pos.get(parents[0])!.a : 0;
    let start = first - (groups.get(parents[0] ?? "")?.length ?? 0) / total * Math.PI;
    for (const p of parents) {
      const kids = groups.get(p)!.sort((x, y) => x.type.localeCompare(y.type) || x.title.localeCompare(y.title));
      const arc = (kids.length / total) * Math.PI * 2;
      kids.forEach((n, i) => put(n.id, start + ((i + 0.5) / kids.length) * arc, RING[k]!));
      start += arc;
    }
  }
  const R = RING[d.depth]! + 170;
  return { pos, viewBox: `${-R} ${-RING[d.depth]! - 40} ${R * 2} ${(RING[d.depth]! + 40) * 2}` };
}
