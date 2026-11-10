import { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Pause, Play, Search } from "lucide-react";
import { go } from "./lib";
import { EdgeCard, NONE, REL_LABEL, TYPES, TYPE_LABEL, norm, readGraphQuery, writeGraphQuery, type EdgeInfo, type GraphData, type GraphNode, type LinkEvidence } from "./graphShared";

/**
 * Grafo 2D legível: cada projeto é um agrupamento (círculo) com as notas dispostas dentro, em espiral, agrupadas por tipo.
 * Só os projetos se movem no layout (repulsão + colisão + molas das ligações entre projetos); as notas ficam numa
 * posição determinística dentro do seu círculo. Ligações entre projetos são curvas que desviam dos outros agrupamentos,
 * tracejadas quando só derivadas das notas e cheias quando registradas como relação explícita; passar o mouse mostra o
 * porquê e clicar fixa o cartão (onde o revisor pode registrar a relação). Filtros, foco, busca e data ficam na URL.
 */
interface Cluster { key: string; name: string; title: string; overview?: GraphNode; notes: GraphNode[]; R: number; x: number; y: number; vx: number; vy: number }
interface Placed { n: GraphNode; x: number; y: number; r: number; key: string; hub: boolean }
interface XLink { a: Cluster; b: Cluster; weight: number; evidence: LinkEvidence[]; ids: string[]; overview?: { a?: string; b?: string }; confirmed?: string }

const STEP = 13; // distância entre notas na espiral
const TYPE_ORDER = new Map(TYPES.map((t, i) => [t, i]));
/** Degrau da linha do tempo, no horário LOCAL: por hora quando tudo cabe em até 3 dias (ex.: base importada num dia só), senão por dia. */
const pad2 = (n: number) => String(n).padStart(2, "0");
const bucketOf = (hourly: boolean) => (iso?: string) => {
  const t = iso ? new Date(iso) : undefined; if (!t || Number.isNaN(t.getTime())) return "";
  const d = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`; return hourly ? `${d}T${pad2(t.getHours())}` : d;
};
const bucketLabel = (b: string) => { const [d, h] = b.split("T"); const [y, m, dd] = d!.split("-"); return h ? `${dd}/${m} ${h}h` : `${dd}/${m}/${y}`; };

function layout(g: GraphData) {
  const names = new Map((g.projects ?? []).map((p) => [p.id, p]));
  const byKey = new Map<string, GraphNode[]>();
  for (const n of g.nodes) { const k = n.project ?? NONE; byKey.set(k, [...(byKey.get(k) ?? []), n]); }
  const keys = [...byKey.keys()].sort((a, b) => byKey.get(b)!.length - byKey.get(a)!.length);
  const clusters: Cluster[] = keys.map((key, i) => {
    const all = byKey.get(key)!; const overview = all.find((n) => n.type === "project");
    const notes = all.filter((n) => n !== overview).sort((a, b) => (TYPE_ORDER.get(a.type) ?? 99) - (TYPE_ORDER.get(b.type) ?? 99) || a.title.localeCompare(b.title));
    const R = 30 + STEP * Math.sqrt(notes.length + 1) * 1.05;
    const t = i * 2.39996; const d = 120 + 70 * Math.sqrt(i);
    const p = names.get(key);
    return { key, name: key === NONE ? "Sem projeto" : p?.name ?? key, title: key === NONE ? "Notas sem projeto" : p?.title ?? key, overview, notes, R, x: Math.cos(t) * d, y: Math.sin(t) * d, vx: 0, vy: 0 };
  });
  const ck = new Map(clusters.map((c) => [c.key, c]));
  const xlinks: XLink[] = (g.project_links ?? []).flatMap((l) => { const a = ck.get(l.a); const b = ck.get(l.b); return a && b ? [{ a, b, weight: l.weight, evidence: l.evidence, ids: l.evidence_ids ?? l.evidence.map((e) => e.id), overview: l.overview, confirmed: l.confirmed }] : []; });

  // só os agrupamentos se movem: colisão firme + repulsão leve + molas entre projetos que se citam + gravidade
  for (let it = 0; it < 500; it++) {
    const alpha = 1 - it / 500;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const A = clusters[i]!; const B = clusters[j]!; let dx = B.x - A.x; let dy = B.y - A.y; const d = Math.hypot(dx, dy) || 0.01; dx /= d; dy /= d;
      const min = A.R + B.R + 64; const push = d < min ? (min - d) * 0.5 : 2400 / (d * d);
      A.vx -= dx * push * alpha; A.vy -= dy * push * alpha; B.vx += dx * push * alpha; B.vy += dy * push * alpha;
    }
    for (const l of xlinks) {
      let dx = l.b.x - l.a.x; let dy = l.b.y - l.a.y; const d = Math.hypot(dx, dy) || 0.01; dx /= d; dy /= d;
      const f = (d - (l.a.R + l.b.R + 70)) * 0.012 * Math.min(3, l.weight) * alpha;
      l.a.vx += dx * f; l.a.vy += dy * f; l.b.vx -= dx * f; l.b.vy -= dy * f;
    }
    for (const c of clusters) { c.vx -= c.x * 0.004 * alpha; c.vy -= c.y * 0.006 * alpha; c.x += c.vx; c.y += c.vy; c.vx *= 0.6; c.vy *= 0.6; }
  }

  // notas em espiral (filotaxia) dentro do agrupamento; a visão geral do projeto fica no centro
  const placed: Placed[] = [];
  for (const c of clusters) {
    if (c.overview) placed.push({ n: c.overview, x: c.x, y: c.y, r: 8, key: c.key, hub: true });
    c.notes.forEach((n, j) => { const r = 22 + STEP * Math.sqrt(j + 0.5) * 0.95; const t = j * 2.39996; placed.push({ n, x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r, r: 4.6, key: c.key, hub: false }); });
  }
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const c of clusters) { x0 = Math.min(x0, c.x - c.R); y0 = Math.min(y0, c.y - c.R - 26); x1 = Math.max(x1, c.x + c.R); y1 = Math.max(y1, c.y + c.R); }
  const curves = new Map(xlinks.map((l) => [l, curve(l.a, l.b, clusters)]));
  return { clusters, placed, xlinks, curves, bounds: { x0, y0, x1, y1 } };
}

/** Curva entre as bordas de dois agrupamentos. Escolhe a curvatura que menos atravessa os OUTROS agrupamentos. */
function curve(a: Cluster, b: Cluster, all: Cluster[]) {
  const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1; const ux = dx / d; const uy = dy / d;
  const sx = a.x + ux * a.R; const sy = a.y + uy * a.R; const ex = b.x - ux * b.R; const ey = b.y - uy * b.R;
  const others = all.filter((c) => c !== a && c !== b);
  const at = (bend: number, t: number) => { const cx = (sx + ex) / 2 - uy * bend; const cy = (sy + ey) / 2 + ux * bend; const m = 1 - t; return [m * m * sx + 2 * m * t * cx + t * t * ex, m * m * sy + 2 * m * t * cy + t * t * ey] as const; };
  const cost = (bend: number) => { let c = Math.abs(bend) * 0.02; for (let i = 1; i < 16; i++) { const [x, y] = at(bend, i / 16); for (const o of others) { const over = o.R + 10 - Math.hypot(x - o.x, y - o.y); if (over > 0) c += over; } } return c; };
  const base = Math.max(12, Math.min(60, (d - a.R - b.R) * 0.18));
  let best = base; let bestC = cost(base);
  for (const f of [-1, 0, 0.5, 1.6, -1.6, 2.6, -2.6, 3.6, -3.6, 5, -5]) { const bend = base * f; const c = cost(bend); if (c < bestC - 0.01) { best = bend; bestC = c; } }
  const cx = (sx + ex) / 2 - uy * best; const cy = (sy + ey) / 2 + ux * best;
  return { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, mx: (sx + 2 * cx + ex) / 4, my: (sy + 2 * cy + ey) / 4 };
}

export default function Graph2D({ graph, height = 620, canReview, onChanged }: { graph: GraphData; height?: number | string; canReview?: boolean; onChanged?: () => void }) {
  const L = useMemo(() => layout(graph), [graph]);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hoverNode, setHoverNode] = useState<Placed>(); const [hoverKey, setHoverKey] = useState<string>();
  const [edgeHover, setEdgeHover] = useState<EdgeInfo>(); const [edgePin, setEdgePin] = useState<EdgeInfo>();
  const [hoverLink, setHoverLink] = useState<XLink>();
  // estado compartilhável (fica na URL): foco, tipos ocultos, busca e data limite
  const init = useMemo(() => readGraphQuery(), []);
  const [focus, setFocus] = useState<string | undefined>(init.get("focus") ?? undefined);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set((init.get("hide") ?? "").split(",").filter(Boolean)));
  const [q, setQ] = useState(init.get("q") ?? "");
  const day = useMemo(() => { const ts = graph.nodes.map((n) => Date.parse(n.created_at ?? "")).filter(Number.isFinite); return bucketOf(ts.length > 0 && Math.max(...ts) - Math.min(...ts) <= 3 * 86400_000); }, [graph]);
  const dates = useMemo(() => [...new Set(graph.nodes.map((n) => day(n.created_at)).filter(Boolean))].sort(), [graph, day]);
  // data da URL só vale se for um degrau existente (granularidade pode mudar quando a base cresce)
  const [until, setUntil] = useState<string | undefined>(() => { const u = init.get("until") ?? undefined; return u && dates.includes(u) ? u : undefined; });
  const [playing, setPlaying] = useState(false);
  useEffect(() => { writeGraphQuery({ focus, hide: [...hidden].join(",") || undefined, q: q.trim() || undefined, until }); }, [focus, hidden, q, until]);
  // "play": percorre as datas de criação até hoje (~8 s); só reage a play/pause
  const untilRef = useRef(until); untilRef.current = until;
  useEffect(() => {
    if (!playing || !dates.length) return;
    let i = untilRef.current ? Math.max(0, dates.indexOf(untilRef.current)) : 0; if (i >= dates.length - 1) i = 0;
    setUntil(dates[i]);
    const t = setInterval(() => { i++; if (i >= dates.length) { setPlaying(false); setUntil(undefined); clearInterval(t); } else setUntil(dates[i]); }, Math.max(250, 8000 / dates.length));
    return () => clearInterval(t);
  }, [playing, dates]);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number }>(undefined);
  const names = useMemo(() => Object.fromEntries(L.clusters.map((c) => [c.key, c.name])), [L]);
  const pos = useMemo(() => new Map(L.placed.map((p) => [p.n.id, p])), [L]);
  const shown = useMemo(() => L.placed.filter((p) => (!until || !p.n.created_at || day(p.n.created_at) <= until) && (p.hub || !hidden.has(p.n.type))), [L, hidden, until, day]);
  const shownIds = useMemo(() => new Set(shown.map((p) => p.n.id)), [shown]);
  const counts = useMemo(() => { const m = new Map<string, number>(); for (const p of shown) m.set(p.key, (m.get(p.key) ?? 0) + 1); return m; }, [shown]);
  const clusterCount = (c: Cluster) => counts.get(c.key) ?? 0;
  // uma ligação some só quando TODAS as notas que a sustentam e que estão carregadas foram filtradas
  const loadedIds = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  const linkVisible = (l: XLink) => !l.ids.some((id) => loadedIds.has(id)) || l.ids.some((id) => shownIds.has(id));

  // enquadra deixando livres o HUD de cima (contagem/busca) e o de baixo (chips, linha do tempo)
  const fit = (b = L.bounds, pad = 40) => {
    const top = 70; const bottom = size.w < 700 ? 190 : 140; const w = size.w; const h = size.h - top - bottom;
    const k = Math.min(2.4, Math.min((w - pad * 2) / (b.x1 - b.x0 || 1), (h - pad) / (b.y1 - b.y0 || 1)));
    setView({ k, x: w / 2 - ((b.x0 + b.x1) / 2) * k, y: top + h / 2 - ((b.y0 + b.y1) / 2) * k });
  };
  const fitRef = useRef(fit); fitRef.current = fit;
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 960, h: el.clientHeight || 600 })); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => {
    const c = L.clusters.find((x) => x.key === focus); if (!focus || !c) { fitRef.current(); return; }
    fitRef.current({ x0: c.x - c.R, y0: c.y - c.R - 26, x1: c.x + c.R, y1: c.y + c.R }, 70);
  }, [L, size.w, size.h, focus]);

  // zoom com a roda em volta do cursor (listener não passivo para impedir a rolagem da página)
  useEffect(() => {
    const el = box.current; if (!el) return;
    const onWheel = (e: WheelEvent) => { if ((e.target as Element).closest(".g2d-hud")) return; e.preventDefault(); const r = el.getBoundingClientRect(); const px = e.clientX - r.left; const py = e.clientY - r.top;
      setView((v) => { const k = Math.max(0.25, Math.min(6, v.k * Math.exp(-e.deltaY * 0.0015))); return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }; }); };
    el.addEventListener("wheel", onWheel, { passive: false }); return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const matches = useMemo(() => { const t = norm(q.trim()); return t.length < 2 ? undefined : new Set(graph.nodes.filter((n) => norm(`${n.title} ${n.id}`).includes(t)).map((n) => n.id)); }, [q, graph]);
  // destaque: nota sob o mouse (+ vizinhas explícitas) > ligação > agrupamento > busca > foco
  const lit = useMemo(() => {
    if (hoverNode) { const s = new Set([hoverNode.n.id]); for (const e of graph.edges) { if (e.src === hoverNode.n.id) s.add(e.dst); if (e.dst === hoverNode.n.id) s.add(e.src); } return { ids: s, keys: new Set([hoverNode.key]) }; }
    if (hoverLink) return { ids: new Set(hoverLink.evidence.map((e) => e.id)), keys: new Set([hoverLink.a.key, hoverLink.b.key]) };
    if (hoverKey) return { keys: new Set([hoverKey, ...L.xlinks.flatMap((l) => (l.a.key === hoverKey ? [l.b.key] : l.b.key === hoverKey ? [l.a.key] : []))]) };
    if (matches) return { ids: matches };
    if (focus) return { keys: new Set([focus]) };
    return undefined;
  }, [hoverNode, hoverLink, hoverKey, matches, focus, graph.edges, L]);
  const nodeOn = (p: Placed) => !lit || (lit.ids ? lit.ids.has(p.n.id) || (!!lit.keys && !hoverLink && lit.keys.has(p.key) && !matches) : !!lit.keys?.has(p.key));
  const clusterOn = (c: Cluster) => !lit || !!lit.keys?.has(c.key) || (!!lit.ids && c.notes.concat(c.overview ? [c.overview] : []).some((n) => lit.ids!.has(n.id)));
  const linkOn = (l: XLink) => !lit || (!!lit.keys?.has(l.a.key) && !!lit.keys?.has(l.b.key) && (!hoverLink || hoverLink === l));
  const showNoteLabels = view.k >= 1.9;

  const onDown = (e: React.PointerEvent) => { if ((e.target as Element).closest("[data-hit],.g2d-hud")) return; drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; (e.currentTarget as Element).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => { const d = drag.current; if (!d) return; setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y })); };
  const onUp = () => { drag.current = undefined; };
  const linkInfo = (l: XLink): EdgeInfo => ({ kind: "project", a: l.a.key, b: l.b.key, weight: l.weight, evidence: l.evidence, names, overview: l.overview, confirmed: l.confirmed });
  const relTypes = useMemo(() => [...new Set(graph.edges.map((e) => e.type))], [graph.edges]);
  const untilIdx = until ? Math.max(0, dates.indexOf(until)) : dates.length - 1;
  const visibleLinks = L.xlinks.filter(linkVisible);

  return (
    <div className="g2d" ref={box} style={{ height }} data-testid="graph2d" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <svg width={size.w} height={size.h} role="img" aria-label={`Grafo 2D: ${shown.length} conhecimentos em ${L.clusters.length} agrupamentos e ${visibleLinks.length} ligações entre projetos.`}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {L.clusters.map((c) => (
            <g key={c.key} className={`g2d-cluster${clusterOn(c) ? "" : " dim"}${clusterCount(c) ? "" : " empty"}`} onPointerEnter={() => setHoverKey(c.key)} onPointerLeave={() => setHoverKey(undefined)}>
              <circle cx={c.x} cy={c.y} r={c.R} />
            </g>
          ))}
          {/* ligações entre projetos: linha visível (tracejada = só derivada) + área de hover larga + selo com o peso */}
          {visibleLinks.map((l) => { const cv = L.curves.get(l)!; const on = linkOn(l);
            const hov = { onPointerEnter: () => { setHoverLink(l); setEdgeHover(linkInfo(l)); }, onPointerLeave: () => { setHoverLink(undefined); setEdgeHover(undefined); }, onClick: () => setEdgePin(linkInfo(l)) };
            return (
            <g key={`${l.a.key}|${l.b.key}`} className={`g2d-xlink${on ? "" : " dim"}${hoverLink === l ? " hot" : ""}${l.confirmed ? " confirmed" : ""}`}>
              <path d={cv.d} className="line" style={{ strokeWidth: (1.2 + Math.min(4, l.weight) * 0.9) / Math.sqrt(view.k), strokeDasharray: l.confirmed ? undefined : `${6 / Math.sqrt(view.k)} ${5 / Math.sqrt(view.k)}` }} />
              <path d={cv.d} className="hit" data-hit="" style={{ strokeWidth: 16 / view.k }} {...hov} />
              <g transform={`translate(${cv.mx},${cv.my}) scale(${1 / Math.sqrt(view.k)})`} className="badge" data-hit="" data-testid="xlink-badge" role="button" aria-label={`Por que ${l.a.name} e ${l.b.name} estão ligados`} {...hov}><circle r={9} /><text dy={3.5}>{l.weight}</text></g>
            </g>); })}
          {/* relações explícitas entre notas: cor e traço pelo tipo */}
          {graph.edges.map((e) => { const a = pos.get(e.src); const b = pos.get(e.dst); if (!a || !b || !shownIds.has(a.n.id) || !shownIds.has(b.n.id)) return null; const info: EdgeInfo = { kind: "relation", type: e.type, src: { id: a.n.id, title: a.n.title }, dst: { id: b.n.id, title: b.n.title } }; return (
            <g key={`${e.src}|${e.dst}|${e.type}`} className={`g2d-rel rel-${e.type}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="line" style={{ strokeWidth: 1.8 / Math.sqrt(view.k) }} />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="hit" data-hit="" style={{ strokeWidth: 12 / view.k }} onPointerEnter={() => setEdgeHover(info)} onPointerLeave={() => setEdgeHover(undefined)} onClick={() => setEdgePin(info)} />
            </g>); })}
          {shown.map((p) => { const on = nodeOn(p); return (
            <g key={p.n.id} className={`g2d-node${on ? "" : " dim"}${p.hub ? " hub" : ""}${p.n.status === "superseded" ? " superseded" : ""}`} data-hit="" style={{ ["--c" as string]: `var(--t-${p.n.type})` }}
              onPointerEnter={() => setHoverNode(p)} onPointerLeave={() => setHoverNode(undefined)} onClick={() => go(`note/${p.n.id}`)}>
              <circle cx={p.x} cy={p.y} r={p.r} />
              {(showNoteLabels || (lit?.ids?.has(p.n.id) && lit.ids.size <= 12)) && !p.hub && <text x={p.x + p.r + 3} y={p.y + 3} style={{ fontSize: 10 / Math.sqrt(view.k) }}>{p.n.title.length > 38 ? `${p.n.title.slice(0, 37)}…` : p.n.title}</text>}
            </g>); })}
          {L.clusters.map((c) => (
            <text key={`l${c.key}`} x={c.x} y={c.y - c.R - 9} className={`g2d-label${clusterOn(c) ? "" : " dim"}`} style={{ fontSize: Math.max(11, 13 / Math.sqrt(view.k)) }} onClick={() => setFocus((f) => (f === c.key ? undefined : c.key))}>
              {c.name} <tspan className="count">{clusterCount(c)}</tspan>
            </text>
          ))}
        </g>
      </svg>

      <div className="g2d-hud g2d-tl">
        <div className="g2d-stats"><b>{shown.length}</b> notas · <b>{L.clusters.filter((c) => c.key !== NONE).length}</b> projetos · <b>{visibleLinks.length}</b> ligações ({L.xlinks.filter((l) => l.confirmed).length} registradas) · <b>{graph.edges.length}</b> relações</div>
        <label className="g3d-search"><Search size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Destacar notas…" aria-label="Destacar conhecimentos no grafo" />{matches && <em>{matches.size}</em>}</label>
      </div>
      <div className="g2d-hud g2d-tr"><button className="g3d-btn" onClick={() => { setFocus(undefined); setHidden(new Set()); setQ(""); setUntil(undefined); setPlaying(false); fit(); }}><Crosshair size={13} /> Recentrar e limpar</button></div>

      {hoverNode ? (
        <div className="g2d-hud edge-card g2d-card" role="status">
          <div className="edge-kicker" style={{ color: `var(--t-${hoverNode.n.type})` }}>{hoverNode.hub ? "visão geral do projeto" : TYPE_LABEL[hoverNode.n.type] ?? hoverNode.n.type}{hoverNode.n.status !== "active" ? ` · ${hoverNode.n.status}` : ""}</div>
          <div className="edge-title">{hoverNode.n.title}</div>
          <div className="edge-hint">{names[hoverNode.key] ?? "sem projeto"}{hoverNode.n.created_at ? ` · criada em ${new Date(hoverNode.n.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : ""} · clique para abrir</div>
        </div>
      ) : (edgeHover ?? edgePin) ? <EdgeCard className="g2d-hud g2d-card" edge={(edgeHover ?? edgePin)!} pinned={!edgeHover} onClose={() => setEdgePin(undefined)} canReview={canReview} onChanged={() => { setEdgePin(undefined); onChanged?.(); }} /> : null}

      <div className="g2d-hud g2d-bottom">
        {dates.length > 1 && (
          <div className="g2d-time" role="group" aria-label="Linha do tempo">
            <button className="g3d-btn" onClick={() => setPlaying((p) => !p)} aria-pressed={playing} aria-label={playing ? "Pausar linha do tempo" : "Reproduzir linha do tempo"}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
            <input type="range" min={0} max={dates.length - 1} value={untilIdx} onChange={(e) => { setPlaying(false); const i = Number(e.target.value); setUntil(i >= dates.length - 1 ? undefined : dates[i]); }} aria-label="Mostrar notas criadas até" />
            <span className="g2d-date">{until ? `até ${bucketLabel(until)}` : "agora"}</span>
          </div>
        )}
        <div className="g2d-chips" role="group" aria-label="Focar projeto">
          {L.clusters.map((c) => <button key={c.key} className="g3d-chip" aria-pressed={focus === c.key} onClick={() => setFocus((f) => (f === c.key ? undefined : c.key))}><i style={{ ["--c" as string]: "var(--t-project)" }} />{c.name}<em>{clusterCount(c)}</em></button>)}
        </div>
      </div>
      <div className="g2d-hud g2d-br" role="group" aria-label="Filtrar por tipo">
        {TYPES.filter((t) => t !== "project").map((t) => <button key={t} className={`g2d-leg${hidden.has(t) ? " off" : ""}`} aria-pressed={!hidden.has(t)} title={hidden.has(t) ? "mostrar" : "ocultar"} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(t)) n.delete(t); else n.add(t); return n; })}><i style={{ ["--c" as string]: `var(--t-${t})` }} />{TYPE_LABEL[t]}</button>)}
        <span className="g2d-leg static"><i className="dash" />só derivada</span><span className="g2d-leg static"><i className="solid" />registrada</span>
        {relTypes.map((t) => <span key={t} className={`g2d-leg static rel-${t}`}><i className="relk" />{REL_LABEL[t] ?? t}</span>)}
      </div>
    </div>
  );
}
