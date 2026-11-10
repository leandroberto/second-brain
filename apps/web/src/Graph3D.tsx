import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Crosshair, Pause, Play, Search } from "lucide-react";
import { go } from "./lib";
import { EdgeCard, NONE, TYPES, TYPE_LABEL, norm, type EdgeInfo, type GraphData, type GraphNode, type LinkEvidence } from "./graphShared";

/** Nó da simulação: notas reais + um "núcleo" por projeto (a nota de visão geral, ou um núcleo sintético). */
interface SimNode extends GraphNode { label: string; hub: boolean; synthetic: boolean; key: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; deg: number; phase: number }
interface SimLink { a: number; b: number; kind: "member" | "project" | string; w?: number; ev?: LinkEvidence[] }

/**
 * Sem relações explícitas o grafo é uma nuvem solta; por isso a estrutura implícita é o projeto: cada nota orbita o núcleo do seu
 * projeto (arestas "member", discretas) e as relações do frontmatter/[[wiki]] aparecem por cima, mais fortes. Núcleos de projetos
 * que se citam ficam ligados entre si (arestas "project", com peso = notas que citam o outro lado).
 */
function build(g: GraphData): { nodes: SimNode[]; links: SimLink[] } {
  const names = new Map((g.projects ?? []).map((p) => [p.id, p.name]));
  const mk = (n: GraphNode, hub: boolean, synthetic: boolean): SimNode => ({ ...n, label: hub ? (n.project ? names.get(n.project) ?? n.title : "Sem projeto") : n.title, hub, synthetic, key: n.project ?? NONE, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: hub ? 6.5 : 2.8, deg: 0, phase: Math.random() * Math.PI * 2 });
  const keys = [...new Set(g.nodes.map((n) => n.project ?? NONE))].sort();
  const nodes: SimNode[] = []; const hubIdx = new Map<string, number>(); const used = new Set<string>();
  for (const k of keys) {
    const ov = k === NONE ? undefined : g.nodes.find((n) => n.type === "project" && (n.project === k || n.id === `project-${k}`));
    if (ov) used.add(ov.id);
    hubIdx.set(k, nodes.push(ov ? mk(ov, true, false) : mk({ id: `hub:${k}`, title: k === NONE ? "Sem projeto" : k, type: "project", status: "active", project: k === NONE ? undefined : k }, true, true)) - 1);
  }
  const idx = new Map<string, number>(nodes.map((n, i) => [n.id, i]));
  for (const n of g.nodes) if (!used.has(n.id)) idx.set(n.id, nodes.push(mk(n, false, false)) - 1);
  const links: SimLink[] = [];
  for (const [i, n] of nodes.entries()) if (!n.hub) links.push({ a: hubIdx.get(n.key)!, b: i, kind: "member" });
  for (const e of g.edges) { const a = idx.get(e.src); const b = idx.get(e.dst); if (a !== undefined && b !== undefined && a !== b) links.push({ a, b, kind: e.type }); }
  for (const l of g.project_links ?? []) { const a = hubIdx.get(l.a); const b = hubIdx.get(l.b); if (a !== undefined && b !== undefined && a !== b) links.push({ a, b, kind: "project", w: l.weight, ev: l.evidence }); }
  for (const l of links) { nodes[l.a]!.deg++; nodes[l.b]!.deg++; }
  // posição inicial: núcleos numa esfera de Fibonacci, notas perto do seu núcleo
  const H = keys.length;
  keys.forEach((k, i) => { const h = nodes[hubIdx.get(k)!]!; const y = H === 1 ? 0 : 1 - (i / (H - 1)) * 2; const rr = Math.sqrt(1 - y * y); const t = i * 2.39996; const R = 60 + 34 * Math.sqrt(H); h.x = Math.cos(t) * rr * R; h.y = y * R * 0.6; h.z = Math.sin(t) * rr * R; });
  for (const n of nodes) if (!n.hub) { const h = nodes[hubIdx.get(n.key)!]!; n.x = h.x + (Math.random() - 0.5) * 60; n.y = h.y + (Math.random() - 0.5) * 60; n.z = h.z + (Math.random() - 0.5) * 60; n.r = 3.4 + Math.min(2.6, (n.deg - 1) * 0.6); }
  return { nodes, links };
}

function tick(nodes: SimNode[], links: SimLink[], alpha: number) {
  const N = nodes.length;
  for (let i = 0; i < N; i++) {
    const A = nodes[i]!;
    for (let j = i + 1; j < N; j++) {
      const B = nodes[j]!; const dx = A.x - B.x; const dy = A.y - B.y; const dz = A.z - B.z;
      const d2 = dx * dx + dy * dy + dz * dz + 1; const f = (A.hub && B.hub ? 9000 : A.hub || B.hub ? 1400 : 700) / d2 / Math.sqrt(d2);
      A.vx += dx * f * alpha; A.vy += dy * f * alpha; A.vz += dz * f * alpha; B.vx -= dx * f * alpha; B.vy -= dy * f * alpha; B.vz -= dz * f * alpha;
    }
  }
  for (const l of links) {
    const A = nodes[l.a]!; const B = nodes[l.b]!; const dx = B.x - A.x; const dy = B.y - A.y; const dz = B.z - A.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    // entre projetos: mola longa e fraca, mais forte quanto mais notas se citam (aproxima núcleos relacionados sem colá-los)
    const proj = l.kind === "project"; const rest = l.kind === "member" ? 46 : proj ? 240 : 70;
    const k = (l.kind === "member" ? 0.035 : proj ? 0.0015 * Math.min(4, l.w ?? 1) : 0.02) * alpha;
    const f = ((d - rest) / d) * k; const wa = A.hub && !proj ? 0.25 : 1; const wb = B.hub && !proj ? 0.25 : 1;
    A.vx += dx * f * wa; A.vy += dy * f * wa; A.vz += dz * f * wa; B.vx -= dx * f * wb; B.vy -= dy * f * wb; B.vz -= dz * f * wb;
  }
  for (const n of nodes) { const g = (n.hub ? 0.006 : 0.002) * alpha; n.vx -= n.x * g; n.vy -= n.y * g * 1.6; n.vz -= n.z * g; n.x += n.vx; n.y += n.vy; n.z += n.vz; n.vx *= 0.78; n.vy *= 0.78; n.vz *= 0.78; }
}

/** Textura de brilho radial (halo dos nós e partículas). */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.18, "rgba(255,255,255,.55)"); g.addColorStop(0.45, "rgba(255,255,255,.12)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

interface Ctl { focus(project?: string): void; query(ids?: Set<string>): void; recenter(): void; autoRotate(on: boolean): void }

export default function Graph3D({ graph, height = 620, onUnsupported, canReview, onChanged }: { graph: GraphData; height?: number | string; onUnsupported?: () => void; canReview?: boolean; onChanged?: () => void }) {
  const host = useRef<HTMLDivElement>(null); const canvasBox = useRef<HTMLDivElement>(null);
  const labelEls = useRef(new Map<string, HTMLDivElement>()); const ctl = useRef<Ctl>(null);
  const [hover, setHover] = useState<SimNode>(); const [labels, setLabels] = useState<SimNode[]>([]);
  const [edgeHover, setEdgeHover] = useState<EdgeInfo>(); const [edgePin, setEdgePin] = useState<EdgeInfo>();
  const [ready, setReady] = useState(false); const [spin, setSpin] = useState(true); const [focus, setFocus] = useState<string>(); const [q, setQ] = useState("");
  const reduced = useMemo(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const sim = useMemo(() => build(graph), [graph]);
  const projects = useMemo(() => sim.nodes.filter((n) => n.hub).map((n) => ({ key: n.key, title: n.label, count: sim.nodes.filter((m) => !m.hub && m.key === n.key).length })), [sim]);
  const explicit = useMemo(() => sim.links.filter((l) => l.kind !== "member" && l.kind !== "project").length, [sim]);
  const cross = useMemo(() => sim.links.filter((l) => l.kind === "project").length, [sim]);
  /** projetos ligados a cada núcleo, com o número de notas que se citam (para o cartão do hover) */
  const linkedTo = useMemo(() => {
    const m = new Map<string, Array<{ name: string; w: number }>>();
    for (const l of sim.links) if (l.kind === "project") for (const [x, y] of [[l.a, l.b], [l.b, l.a]] as const) { const k = sim.nodes[x]!.key; m.set(k, [...(m.get(k) ?? []), { name: sim.nodes[y]!.label, w: l.w ?? 1 }].sort((p, q) => q.w - p.w)); }
    return m;
  }, [sim]);
  /** o porquê de uma aresta (ligação entre projetos ou relação explícita), para o cartão */
  const edgeInfo = useMemo(() => {
    const names = Object.fromEntries((graph.projects ?? []).map((p) => [p.id, p.name]));
    return (l: SimLink): EdgeInfo | undefined => {
      const A = sim.nodes[l.a]!; const B = sim.nodes[l.b]!;
      if (l.kind === "member") return undefined;
      if (l.kind === "project") { const pl = (graph.project_links ?? []).find((x) => (x.a === A.key && x.b === B.key) || (x.a === B.key && x.b === A.key)); return { kind: "project", a: A.key, b: B.key, weight: l.w ?? 1, evidence: l.ev ?? [], names, overview: pl?.overview, confirmed: pl?.confirmed }; }
      return { kind: "relation", type: l.kind, src: { id: A.id, title: A.title }, dst: { id: B.id, title: B.title } };
    };
  }, [sim, graph.projects, graph.project_links]);
  const edgeInfoRef = useRef(edgeInfo); edgeInfoRef.current = edgeInfo;
  const matches = useMemo(() => { const t = norm(q.trim()); return t.length < 2 ? undefined : new Set(sim.nodes.filter((n) => norm(`${n.label} ${n.title} ${n.id} ${n.type}`).includes(t)).map((n) => n.id)); }, [q, sim]);

  useEffect(() => { ctl.current?.query(matches); }, [matches]);
  useEffect(() => { ctl.current?.focus(focus); }, [focus]);
  useEffect(() => { ctl.current?.autoRotate(spin && !reduced); }, [spin, reduced]);

  useEffect(() => {
    const box = canvasBox.current; if (!box) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" }); } catch { onUnsupported?.(); return; }
    const css = getComputedStyle(host.current!); const cv = (v: string, fb: string) => new THREE.Color(css.getPropertyValue(v).trim() || fb);
    const BG = cv("--g3d-bg", "#04060a"); const ACCENT = cv("--g3d-accent", "#5eead4"); const DIM = new THREE.Color("#64748b");
    const typeColor = Object.fromEntries(TYPES.map((t) => [t, cv(`--t-${t}`, "#94a3b8")])) as Record<string, THREE.Color>;
    const REL: Record<string, THREE.Color> = { supersedes: cv("--warn", "#fbbf24"), superseded_by: cv("--warn", "#fbbf24"), contradicts: cv("--danger", "#f87171"), depends_on: new THREE.Color("#fbbf24"), related_to: new THREE.Color("#a5b4fc"), references: new THREE.Color("#94a3b8"), implements: new THREE.Color("#4ade80"), derived_from: new THREE.Color("#c4b5fd"), link: new THREE.Color("#64748b") };
    const relColor = (k: string) => REL[k] ?? ACCENT;
    const { nodes, links } = sim; const active = (n: SimNode) => n.status === "active" || n.status === "proposed";
    const colorOf = (n: SimNode) => active(n) ? (typeColor[n.type] ?? DIM) : DIM;

    // a cor de limpeza passa pelo OutputPass e sairia codificada em sRGB duas vezes (#04060a viraria #222a38): compensa uma vez
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setClearColor(BG.clone().convertSRGBToLinear(), 1);
    box.appendChild(renderer.domElement); renderer.domElement.setAttribute("aria-hidden", "true");
    const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(BG, 0.0016);
    const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000); const est = 160 + 60 * Math.sqrt(nodes.length); camera.position.set(0, est * 0.22, est * 1.25);
    const controls = new OrbitControls(camera, renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.07, autoRotate: !reduced, autoRotateSpeed: 0.45, minDistance: 30, maxDistance: 2400, rotateSpeed: 0.6 });
    const composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.42, 0.22); composer.addPass(bloom); composer.addPass(new OutputPass());
    const disposables: Array<{ dispose(): void }> = [renderer, composer, controls];
    const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
    const glow = keep(glowTexture());

    // ambiente: poeira estelar + grade polar ("HUD" do chão)
    const starPos = new Float32Array(2400 * 3);
    for (let i = 0; i < 2400; i++) { const u = Math.random() * 2 - 1; const t = Math.random() * Math.PI * 2; const R = 1100 + Math.random() * 1500; const s = Math.sqrt(1 - u * u); starPos.set([Math.cos(t) * s * R, u * R, Math.sin(t) * s * R], i * 3); }
    const starsGeo = keep(new THREE.BufferGeometry()); starsGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starsGeo, keep(new THREE.PointsMaterial({ size: 2.2, map: glow, color: new THREE.Color("#9fb4d8"), transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    scene.add(stars);
    const grid = new THREE.PolarGridHelper(520, 24, 10, 96, ACCENT.clone().multiplyScalar(0.35), ACCENT.clone().multiplyScalar(0.18));
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.16; keep(grid.geometry); keep(grid.material as THREE.Material); scene.add(grid);

    // nós: núcleo sólido (brilha no bloom) + halo + área de clique invisível; núcleos de projeto ganham casca e anel
    const sphere = keep(new THREE.IcosahedronGeometry(1, 3)); const shell = keep(new THREE.IcosahedronGeometry(1, 1)); const torus = keep(new THREE.TorusGeometry(1, 0.035, 8, 96));
    const hitMat = keep(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
    type Vis = { core: THREE.Mesh; mat: THREE.MeshBasicMaterial; halo: THREE.Sprite; hmat: THREE.SpriteMaterial; hit: THREE.Mesh; extra: THREE.Object3D[]; base: number; cur: number };
    const vis: Vis[] = nodes.map((n, i) => {
      const c = colorOf(n); const base = active(n) ? 1 : 0.45;
      const mat = keep(new THREE.MeshBasicMaterial({ color: n.hub ? c.clone().multiplyScalar(0.7) : c, transparent: true, opacity: base }));
      const core = new THREE.Mesh(sphere, mat); core.scale.setScalar(n.r);
      const hmat = keep(new THREE.SpriteMaterial({ map: glow, color: c, transparent: true, opacity: base * 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
      const halo = new THREE.Sprite(hmat); halo.scale.setScalar(n.r * (n.hub ? 5 : 5.5));
      const hit = new THREE.Mesh(sphere, hitMat); hit.scale.setScalar(Math.max(7, n.r * 2.4)); hit.userData.i = i;
      const extra: THREE.Object3D[] = [];
      if (n.hub) {
        const sm = keep(new THREE.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: 0.28, depthWrite: false }));
        const s = new THREE.Mesh(shell, sm); s.scale.setScalar(n.r * 2.1);
        const rm = keep(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.7, depthWrite: false }));
        const ring = new THREE.Mesh(torus, rm); ring.scale.setScalar(n.r * 3.1); ring.rotation.x = Math.PI / 2 + (i % 3 - 1) * 0.35;
        extra.push(s, ring);
      }
      scene.add(core, halo, hit, ...extra);
      return { core, mat, halo, hmat, hit, extra, base, cur: base };
    });
    const hits = vis.map((v) => v.hit);

    // arestas: pertencimento (discretas, gradiente núcleo→nota) e relações explícitas (fortes)
    const mkLines = (ls: SimLink[], opacity: number) => {
      const geo = keep(new THREE.BufferGeometry()); geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ls.length * 6), 3));
      const col = new Float32Array(ls.length * 6); geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const line = new THREE.LineSegments(geo, keep(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending })));
      scene.add(line); return { ls, geo, col, line };
    };
    const member = mkLines(links.filter((l) => l.kind === "member"), 0.55); const rel = mkLines(links.filter((l) => l.kind !== "member" && l.kind !== "project"), 0.95);
    const cross = mkLines(links.filter((l) => l.kind === "project"), 1);
    const PROJ = cv("--t-project", "#4ade80");
    // ligação registrada como relação explícita (entre as visões gerais) brilha mais que a só derivada das notas
    const confirmedSet = new Set(links.filter((l) => l.kind === "project" && (graph.project_links ?? []).some((x) => x.confirmed && ((x.a === nodes[l.a]!.key && x.b === nodes[l.b]!.key) || (x.a === nodes[l.b]!.key && x.b === nodes[l.a]!.key)))));
    const baseCol = (l: SimLink, end: 0 | 1) => l.kind === "member" ? colorOf(nodes[end ? l.b : l.a]!).clone().multiplyScalar(end ? 0.42 : 0.28)
      : l.kind === "project" ? PROJ.clone().multiplyScalar((confirmedSet.has(l) ? 0.95 : 0.45) + 0.12 * Math.min(3, l.w ?? 1)) : relColor(l.kind);

    // pulsos: partículas que correm pelas arestas ("tráfego" do conhecimento)
    const PL = reduced ? [] : links.slice(0, 700).flatMap((l) => (l.kind === "member" ? [l] : l.kind === "project" ? Array(Math.min(4, l.w ?? 1) + 1).fill(l) : [l, l]).map((x: SimLink) => ({ l: x, t: Math.random(), v: x.kind === "project" ? 0.04 + Math.random() * 0.06 : 0.08 + Math.random() * 0.18 })));
    const pGeo = keep(new THREE.BufferGeometry()); pGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, PL.length) * 3), 3));
    const pCol = new Float32Array(Math.max(1, PL.length) * 3); PL.forEach((p, i) => (p.l.kind === "member" ? colorOf(nodes[p.l.b]!) : p.l.kind === "project" ? PROJ : relColor(p.l.kind)).toArray(pCol, i * 3)); pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
    const pulses = new THREE.Points(pGeo, keep(new THREE.PointsMaterial({ size: 5, map: glow, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending })));
    pulses.visible = PL.length > 0; scene.add(pulses);

    // estado de destaque (hover > busca > foco de projeto)
    let hoverI = -1; let queryIds: Set<string> | undefined; let focusKey: string | undefined;
    const neighbors = (i: number) => { const s = new Set([i]); for (const l of links) { if (l.a === i) s.add(l.b); if (l.b === i) s.add(l.a); } return s; };
    const lit = (): Set<number> | undefined => hoverI >= 0 ? neighbors(hoverI) : hoverE >= 0 ? new Set([links[hoverE]!.a, links[hoverE]!.b]) : queryIds ? new Set(nodes.flatMap((n, i) => queryIds!.has(n.id) ? [i] : [])) : focusKey !== undefined ? new Set(nodes.flatMap((n, i) => n.key === focusKey ? [i] : [])) : undefined;
    let litSet: Set<number> | undefined;
    const paintEdges = () => {
      for (const L of [member, rel, cross]) { L.ls.forEach((l, k) => { const on = !litSet || (litSet.has(l.a) && litSet.has(l.b)); const f = on ? (litSet && l.kind === "member" ? 2.2 : 1) : 0.06; baseCol(l, 0).clone().multiplyScalar(f).toArray(L.col, k * 6); baseCol(l, 1).clone().multiplyScalar(f).toArray(L.col, k * 6 + 3); }); L.geo.attributes.color!.needsUpdate = true; }
    };
    const refresh = () => {
      litSet = lit(); paintEdges();
      const show = nodes.filter((n, i) => n.hub || (litSet?.has(i) && litSet.size <= 40));
      setLabels(show);
    };
    paintEdges();

    // câmera: voo suave até um alvo
    let fly: { t0: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; c0: THREE.Vector3; c1: THREE.Vector3 } | undefined;
    const flyTo = (center: THREE.Vector3, dist: number) => {
      const dir = camera.position.clone().sub(controls.target).normalize(); if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0, 0.25, 1).normalize();
      const p1 = center.clone().add(dir.multiplyScalar(dist));
      if (reduced) { camera.position.copy(p1); controls.target.copy(center); return; }
      fly = { t0: performance.now(), dur: 1100, p0: camera.position.clone(), p1, c0: controls.target.clone(), c1: center.clone() };
    };
    const bounds = (sel: (n: SimNode) => boolean) => {
      const pts = nodes.filter(sel); const c = new THREE.Vector3(); for (const n of pts) c.add(new THREE.Vector3(n.x, n.y, n.z)); c.divideScalar(Math.max(1, pts.length));
      let r = 20; for (const n of pts) r = Math.max(r, c.distanceTo(new THREE.Vector3(n.x, n.y, n.z)) + n.r * 3);
      const v = (camera.fov * Math.PI) / 360; const h = Math.atan(Math.tan(v) * camera.aspect); // em retrato o eixo horizontal é o que limita
      return { c, d: (r / Math.sin(Math.min(v, h))) * 0.78 };
    };
    const fitAll = () => { const b = bounds(() => true); flyTo(b.c, Math.max(160, b.d)); };

    ctl.current = {
      focus(k) { focusKey = k; refresh(); if (k === undefined) fitAll(); else { const b = bounds((n) => n.key === k); flyTo(b.c, Math.max(110, b.d)); } },
      query(ids) { queryIds = ids; refresh(); },
      recenter() { focusKey = undefined; fitAll(); },
      autoRotate(on) { controls.autoRotate = on; },
    };
    controls.addEventListener("start", () => { fly = undefined; });

    // simulação: no movimento reduzido assenta tudo antes do 1º quadro; senão "explode" do centro em ~4 s
    const TOTAL = 320; let ticks = 0;
    if (reduced) { while (ticks < TOTAL) tick(nodes, links, 1 - ticks++ / TOTAL); }
    let settledFit = false;

    // interação: hover por raycast; clique (sem arrastar) abre; duplo clique voa até o nó
    const ray = new THREE.Raycaster(); const ptr = new THREE.Vector2(); let ptrDirty = false; let down: { x: number; y: number } | undefined;
    const el = renderer.domElement;
    const ptrPx = { x: -1e9, y: -1e9 };
    const onMove = (e: PointerEvent) => { const r = el.getBoundingClientRect(); ptrPx.x = e.clientX - r.left; ptrPx.y = e.clientY - r.top; ptr.set((ptrPx.x / r.width) * 2 - 1, -(ptrPx.y / r.height) * 2 + 1); ptrDirty = true; };
    const onLeave = () => { if (hoverI !== -1) { hoverI = -1; setHover(undefined); refresh(); } if (hoverE !== -1) { hoverE = -1; setEdgeHover(undefined); refresh(); } el.style.cursor = ""; };
    // arestas com "porquê" (entre projetos e relações explícitas): hover por distância na tela até o segmento projetado
    const explainable = links.flatMap((l, k) => (l.kind === "member" ? [] : [k]));
    let hoverE = -1;
    const S0 = new THREE.Vector3(); const S1 = new THREE.Vector3();
    const pickEdge = (w: number, h: number): number => {
      let best = -1; let bestD = 9; // px
      for (const k of explainable) {
        const l = links[k]!; S0.copy(disp[l.a]!).project(camera); S1.copy(disp[l.b]!).project(camera);
        if (S0.z > 1 || S1.z > 1) continue;
        const ax = ((S0.x + 1) / 2) * w; const ay = ((1 - S0.y) / 2) * h; const bx = ((S1.x + 1) / 2) * w; const by = ((1 - S1.y) / 2) * h;
        const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((ptrPx.x - ax) * dx + (ptrPx.y - ay) * dy) / len2));
        const d = Math.hypot(ptrPx.x - (ax + t * dx), ptrPx.y - (ay + t * dy));
        if (d < bestD && t > 0.06 && t < 0.94) { bestD = d; best = k; } // longe das pontas: lá vale o nó
      }
      return best;
    };
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
        if (hoverI >= 0) { const n = nodes[hoverI]!; go(n.synthetic ? `projects/${n.project ?? ""}` : `note/${n.id}`); }
        else if (hoverE >= 0) setEdgePin(edgeInfoRef.current(links[hoverE]!));
      }
      down = undefined;
    };
    const onDbl = () => { if (hoverI >= 0) { const n = nodes[hoverI]!; flyTo(new THREE.Vector3(n.x, n.y, n.z), n.hub ? 120 : 70); } };
    el.addEventListener("pointermove", onMove); el.addEventListener("pointerleave", onLeave); el.addEventListener("pointerdown", onDown); el.addEventListener("pointerup", onUp); el.addEventListener("dblclick", onDbl);

    const resize = () => { const w = box.clientWidth || 1; const h = box.clientHeight || 1; renderer.setSize(w, h, false); composer.setSize(w, h); bloom.resolution.set(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(box); resize();

    const P = new THREE.Vector3(); const disp = nodes.map(() => new THREE.Vector3());
    const idxOf = new Map(nodes.map((n, i) => [n.id, i])); const labW = new WeakMap<HTMLElement, number>();
    const clock = new THREE.Clock(); let raf = 0; let frames = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, clock.getDelta()); const t = clock.elapsedTime;
      if (ticks < TOTAL) { for (let s = 0; s < 3 && ticks < TOTAL; s++) tick(nodes, links, 1 - ticks++ / TOTAL); }
      else if (!settledFit) { settledFit = true; fitAll(); }
      if (fly) { const k = Math.min(1, (performance.now() - fly.t0) / fly.dur); const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; camera.position.lerpVectors(fly.p0, fly.p1, e); controls.target.lerpVectors(fly.c0, fly.c1, e); if (k >= 1) fly = undefined; }
      controls.update();
      // posição exibida = simulação + leve flutuação
      nodes.forEach((n, i) => {
        const b = reduced ? 0 : (n.hub ? 1.2 : 2.2); disp[i]!.set(n.x, n.y + Math.sin(t * 0.8 + n.phase) * b, n.z + Math.cos(t * 0.6 + n.phase) * b * 0.6);
        const v = vis[i]!; const target = !litSet ? v.base : litSet.has(i) ? 1 : 0.1; v.cur += (target - v.cur) * Math.min(1, dt * 8);
        v.core.position.copy(disp[i]!); v.halo.position.copy(disp[i]!); v.hit.position.copy(disp[i]!); v.mat.opacity = v.cur;
        v.hmat.opacity = v.cur * (i === hoverI ? 1.3 : n.hub ? 0.5 : 0.8) * (reduced ? 1 : 0.85 + Math.sin(t * 2 + n.phase) * 0.15);
        v.halo.scale.setScalar(n.r * (n.hub ? 5 : 5.5) * (i === hoverI ? 1.5 : 1));
        for (const [j, x] of v.extra.entries()) { x.position.copy(disp[i]!); ((x as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (j ? 0.7 : 0.28) * v.cur; if (!reduced) { if (j) x.rotation.z = t * 0.5 + n.phase; else x.rotation.set(t * 0.15, t * 0.22, 0); } }
      });
      for (const L of [member, rel, cross]) { const pa = L.geo.attributes.position!.array as Float32Array; L.ls.forEach((l, k) => { disp[l.a]!.toArray(pa, k * 6); disp[l.b]!.toArray(pa, k * 6 + 3); }); L.geo.attributes.position!.needsUpdate = true; }
      if (PL.length) {
        const pa = pGeo.attributes.position!.array as Float32Array;
        PL.forEach((p, i) => { p.t = (p.t + p.v * dt) % 1; const on = !litSet || (litSet.has(p.l.a) && litSet.has(p.l.b)); if (!on) { pa.set([0, -1e5, 0], i * 3); return; } P.lerpVectors(disp[p.l.b]!, disp[p.l.a]!, p.t); P.toArray(pa, i * 3); });
        pGeo.attributes.position!.needsUpdate = true;
      }
      stars.rotation.y = t * 0.004; grid.position.y = -Math.max(160, camera.position.distanceTo(controls.target) * 0.35); grid.rotation.y = -t * 0.02;
      if (ptrDirty) {
        ptrDirty = false; ray.setFromCamera(ptr, camera); const h = ray.intersectObjects(hits, false)[0]; const i = h ? (h.object.userData.i as number) : -1;
        if (i !== hoverI) { hoverI = i; setHover(i >= 0 ? nodes[i] : undefined); refresh(); }
        const k = i >= 0 ? -1 : pickEdge(box.clientWidth, box.clientHeight);
        if (k !== hoverE) { hoverE = k; setEdgeHover(k >= 0 ? edgeInfoRef.current(links[k]!) : undefined); refresh(); }
        el.style.cursor = i >= 0 || k >= 0 ? "pointer" : "";
      }
      // rótulos HTML acompanham a projeção 3D
      const w = box.clientWidth; const hh = box.clientHeight;
      // anti-colisão: rótulos em ordem de prioridade (núcleos com mais notas primeiro); um rótulo que cairia sobre outro já
      // posto desce/sobe em degraus de uma linha (até 4), como a grade de ocupação do Logseq
      const placedR: Array<[number, number, number, number]> = [];
      const order = [...labelEls.current.entries()].map(([id, lab]) => ({ id, lab, i: idxOf.get(id) ?? -1 })).filter((x) => x.i >= 0)
        .sort((a, b) => Number(nodes[b.i]!.hub) - Number(nodes[a.i]!.hub) || nodes[b.i]!.deg - nodes[a.i]!.deg);
      for (const { lab, i } of order) {
        P.copy(disp[i]!).project(camera);
        const vis2 = P.z < 1 && Math.abs(P.x) < 1.1 && Math.abs(P.y) < 1.1; const dist = camera.position.distanceTo(disp[i]!);
        const x = ((P.x + 1) / 2) * w; let y = ((1 - P.y) / 2) * hh;
        const lw = (labW.get(lab) ?? labW.set(lab, lab.offsetWidth || 120).get(lab)!) + 12; const lh = 22;
        if (vis2) {
          const hit = (yy: number) => placedR.some(([rx, ry, rw, rh]) => x + 12 < rx + rw && x + 12 + lw > rx && yy - lh / 2 < ry + rh && yy + lh / 2 > ry);
          for (const step of [0, 1, -1, 2, -2]) { if (!hit(y + step * lh)) { y += step * lh; break; } }
          placedR.push([x + 12, y - lh / 2, lw, lh]);
        }
        lab.style.transform = `translate(${x}px, ${y}px)`; lab.style.opacity = vis2 ? String(Math.max(0.25, Math.min(1, 900 / dist)) * (vis[i]!.cur > 0.5 || nodes[i]!.hub ? 1 : 0.35)) : "0";
      }
      composer.render(dt);
      if (++frames === 2) { setReady(true); refresh(); }
    };
    loop();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); ctl.current = null;
      el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerleave", onLeave); el.removeEventListener("pointerdown", onDown); el.removeEventListener("pointerup", onUp); el.removeEventListener("dblclick", onDbl);
      for (const d of disposables) d.dispose();
      el.remove(); setReady(false);
    };
  }, [sim, reduced, onUnsupported, graph.project_links]);

  const typeLabel = TYPE_LABEL;
  return (
    <div className="g3d" ref={host} style={{ height }} data-testid="graph3d" data-state={ready ? "ready" : "loading"} data-nodes={graph.nodes.length}>
      <div className="g3d-canvas" ref={canvasBox} role="img" aria-label={`Grafo 3D de conhecimento: ${graph.nodes.length} conhecimentos em ${projects.length} projetos, ${cross} ligações entre projetos e ${explicit} relações explícitas. Use a lista de projetos e a busca para navegar.`} />
      <div className="g3d-labels" aria-hidden="true">
        {labels.map((n) => <div key={n.id} ref={(el) => { if (el) labelEls.current.set(n.id, el); else labelEls.current.delete(n.id); }} className={`g3d-label${n.hub ? " hub" : ""}`} style={{ ["--c" as string]: `var(--t-${n.type})` }}><span>{n.label.length > 46 ? n.label.slice(0, 45) + "…" : n.label}</span></div>)}
      </div>
      <div className="g3d-scan" aria-hidden="true" />
      <div className="g3d-hud g3d-tl">
        <div className="g3d-kicker"><i className="g3d-live" /> mapa de conhecimento</div>
        <div className="g3d-stats"><b>{graph.nodes.length}</b> nós <span>·</span> <b>{projects.filter((p) => p.key !== NONE).length}</b> projetos <span>·</span> <b>{cross}</b> ligações entre projetos <span>·</span> <b>{explicit}</b> relações</div>
        <label className="g3d-search"><Search size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Destacar nós…" aria-label="Destacar conhecimentos no grafo" />{matches && <em>{matches.size}</em>}</label>
      </div>
      <div className="g3d-hud g3d-tr">
        <button className="g3d-btn" onClick={() => setSpin((s) => !s)} aria-pressed={spin && !reduced} disabled={reduced} title={reduced ? "Movimento reduzido ativo no sistema" : undefined}>{spin && !reduced ? <Pause size={13} /> : <Play size={13} />} Rotação</button>
        <button className="g3d-btn" onClick={() => { setFocus(undefined); ctl.current?.recenter(); }}><Crosshair size={13} /> Recentrar</button>
      </div>
      {!hover && (edgeHover ?? edgePin) && <EdgeCard className="g3d-hud g3d-card g3d-edge" edge={(edgeHover ?? edgePin)!} pinned={!edgeHover} onClose={() => setEdgePin(undefined)} canReview={canReview} onChanged={() => { setEdgePin(undefined); onChanged?.(); }} />}
      {hover && (
        <div className="g3d-hud g3d-card" role="status">
          <div className="g3d-type" style={{ ["--c" as string]: `var(--t-${hover.type})` }}>{hover.hub ? "núcleo · " : ""}{typeLabel[hover.type] ?? hover.type}{hover.status !== "active" ? ` · ${hover.status}` : ""}</div>
          <div className="g3d-title">{hover.hub ? hover.label : hover.title}</div>
          {hover.hub && hover.label !== hover.title && !hover.synthetic && <div className="g3d-meta">{hover.title}</div>}
          {hover.hub && linkedTo.get(hover.key) && <div className="g3d-meta">ligado a: {linkedTo.get(hover.key)!.map((x) => `${x.name} (${x.w} ${x.w === 1 ? "nota" : "notas"})`).join(" · ")}</div>}
          <div className="g3d-meta">{hover.project ?? "sem projeto"}{hover.updated_at ? ` · ${new Date(hover.updated_at).toLocaleDateString("pt-BR")}` : ""} · {hover.deg} conexões</div>
          <div className="g3d-hint">clique para abrir · duplo clique para aproximar</div>
        </div>
      )}
      <div className="g3d-hud g3d-bl" role="group" aria-label="Focar projeto">
        {projects.map((p) => <button key={p.key} className="g3d-chip" aria-pressed={focus === p.key} onClick={() => setFocus((f) => f === p.key ? undefined : p.key)}><i style={{ ["--c" as string]: "var(--t-project)" }} />{p.title}<em>{p.count}</em></button>)}
      </div>
      <div className="g3d-hud g3d-br" aria-hidden="true">
        {TYPES.map((t) => <span key={t} className="g3d-leg"><i style={{ ["--c" as string]: `var(--t-${t})` }} />{typeLabel[t]}</span>)}
      </div>
      {!ready && <div className="g3d-boot" aria-hidden="true"><i /> inicializando</div>}
    </div>
  );
}
