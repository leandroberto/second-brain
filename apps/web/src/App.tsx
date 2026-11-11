import { useEffect, useMemo, useState } from "react";
import { Activity, Bot, FileInput, FolderKanban, Home as HomeIcon, Inbox, Network, ScanSearch, Search, Settings as Cog, ListChecks } from "lucide-react";
import { api, captureToken, type ModulosResp, getToken, setToken } from "./api";
import { Palette, type Cmd } from "./Palette";
import { go, href, ToastProvider, useData, useHotkey, useRoute, useToast, errMsg } from "./lib";
import { AgentsPage, GraphPage, ProjectsPage, ReviewPage, TimelinePage } from "./pages2";
import { Home, NotePage, SearchPage } from "./pages1";
import { AddKnowledge, SettingsPage } from "./pages3";
import { ImportPage } from "./ImportPage";
import { RecentWritesPage } from "./RecentWrites";
import { ModuleFrame, iconeDoModulo } from "./ModuleFrame";
import { AssistantModal, type AssistantTab } from "./AssistantBox";

captureToken();
try { document.documentElement.dataset.theme = localStorage.getItem("theme") ?? "dark"; } catch { /* sem storage */ }

const NAV: Array<[string, string, typeof HomeIcon]> = [["", "Home", HomeIcon], ["search", "Buscar", Search], ["inbox", "Inbox", Inbox], ["review", "Revisão", ListChecks], ["projects", "Projetos", FolderKanban], ["import", "Importar", FileInput], ["graph", "Grafo", Network], ["timeline", "Timeline", Activity], ["agents", "Agentes", Bot]];

function Shell() {
  const r = useRoute(); const toast = useToast();
  const [pal, setPal] = useState(false); const [add, setAdd] = useState(false); const [asst, setAsst] = useState<AssistantTab>();
  const { data: rv } = useData<unknown[]>("/api/review", [], 15000);
  const { data: ib } = useData<unknown[]>("/api/inbox", [], 15000);
  const { data: mods } = useData<ModulosResp>("/api/modules", [], 15000); // erro: mantém o último valor (ou nenhum módulo)
  const [badgeLocal, setBadgeLocal] = useState<Record<string, number>>({});
  useEffect(() => { setBadgeLocal({}); }, [mods]); // brain:badge só vale até o próximo GET /api/modules
  const abas = (mods?.modulos ?? []).filter((m) => m.aba && /^[a-z][a-z0-9-]{1,30}$/.test(m.id));
  useHotkey("k", () => setPal((p) => !p), { ctrl: true });
  useHotkey("/", () => setPal(true));
  const section = r.path[0] ?? "";
  const { data: projects } = useData<Array<{ id: string; title: string }>>("/api/projects");
  const { data: meta } = useData<{ can_review: boolean; principal: { kind: string; channel: string } }>("/api/meta");
  const commands: Cmd[] = useMemo(() => [
    { id: "search", label: "Buscar conhecimento", run: () => go("search") }, { id: "add", label: "Adicionar conhecimento", run: () => setAdd(true) }, { id: "import", label: "Importar conhecimento", run: () => go("import") },
    { id: "capture", label: "Anotar…", run: () => setAsst("capture") }, { id: "ask", label: "Perguntar…", run: () => setAsst("ask") },
    { id: "recentw", label: "Entrou recentemente", run: () => go("recent") },
    { id: "review", label: "Revisar propostas", run: () => go("review") }, { id: "inbox", label: "Abrir inbox", run: () => go("inbox") },
    { id: "recent", label: "Mostrar atividade recente", run: () => go("timeline") }, { id: "projects", label: "Ver projetos", run: () => go("projects") },
    { id: "newproj", label: "Criar projeto", run: () => go("projects") }, { id: "graph", label: "Abrir grafo", run: () => go("graph") }, { id: "agents", label: "Agentes", run: () => go("agents") },
    { id: "reindex", label: "Reindexar banco", run: () => api("/api/reindex", { method: "POST" }).then(() => toast("Reindexado")).catch((e) => toast(errMsg(e), true)) },
    { id: "commit", label: "Commitar mudanças de conhecimento", run: () => api<{ commit?: string }>("/api/git/commit", { method: "POST", body: {} }).then((x) => toast(x.commit ? `Commit ${x.commit}` : "Nada a commitar")).catch((e) => toast(errMsg(e), true)) },
    { id: "settings", label: "Configurações", run: () => go("settings") },
    ...(r.path[0] === "note" && r.path[1] ? [{ id: "obsidian", label: "Abrir no Obsidian", run: () => api<{ uri: string }>(`/api/obsidian/${r.path[1]}`).then((o) => { location.href = o.uri; }).catch((e) => toast(errMsg(e), true)) }] : []),
    ...(projects ?? []).map((p) => ({ id: `p-${p.id}`, label: `Abrir projeto: ${p.title.replace(/ \(demo\)$/, "")}`, run: () => go(`projects/${p.id}`) })),
  ], [projects, r.path, toast]);

  let page: React.ReactNode;
  switch (section) {
    case "": page = <Home />; break;
    case "search": page = <SearchPage initial={r.query.get("q") ?? ""} />; break;
    case "note": page = <NotePage id={r.path[1] ?? ""} />; break;
    case "recent": page = <RecentWritesPage />; break;
    case "review": page = <ReviewPage id={r.path[1]} mode="review" />; break;
    case "inbox": page = <ReviewPage id={r.path[1]} mode="inbox" />; break;
    case "projects": page = <ProjectsPage id={r.path[1]} />; break;
    case "timeline": page = <TimelinePage actor={r.query.get("actor") ?? undefined} />; break;
    case "agents": page = <AgentsPage />; break;
    case "graph": page = <GraphPage />; break;
    case "import": page = <ImportPage />; break;
    case "settings": page = <SettingsPage />; break;
    case "m": page = <ModuleFrame id={r.path[1] ?? ""} resto={r.path.slice(2).join("/")} onBadge={(id, n) => setBadgeLocal((b) => ({ ...b, [id]: n }))} />; break;
    default: page = <div className="wrap"><h1>Página não encontrada</h1></div>;
  }
  const counts: Record<string, number> = { review: rv?.length ?? 0, inbox: ib?.length ?? 0 };
  return (
    <div className="app">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Pular para o conteúdo</a>
      <nav className="side" aria-label="Principal">
        <div className="brand"><div className="brand-mark"><ScanSearch size={15} /></div><span>Second Brain</span></div>
        {NAV.map(([k, label, Icon]) => <a key={k} className="nav" href={href(k)} aria-current={section === k ? "page" : undefined}><Icon size={16} /><span className="lbl">{label}</span>{counts[k] ? <span className="count">{counts[k]}</span> : null}</a>)}
        {abas.map((m) => { const Icon = iconeDoModulo(m.icone); const n = badgeLocal[m.id] ?? m.badge; return <a key={`m-${m.id}`} className="nav" href={href(`m/${m.id}`)} aria-current={section === "m" && r.path[1] === m.id ? "page" : undefined}><Icon size={16} /><span className="lbl">{m.nome}</span>{n ? <span className="count">{n}</span> : null}</a>; })}
        <div className="side-foot"><div className="side-sep" /><a className="nav" href={href("settings")} aria-current={section === "settings" ? "page" : undefined}><Cog size={16} /><span className="lbl">Configurações</span></a></div>
      </nav>
      <div className="main">
        <header className="top"><button className="search-pill" onClick={() => setPal(true)} aria-label="Abrir busca e comandos"><Search size={15} /> Buscar ou digitar um comando <span className="kbd">Ctrl K</span></button><div className="spacer" /><button className="btn primary sm" onClick={() => setAdd(true)}>+ Adicionar</button></header>
        <main className="page" id="main" tabIndex={-1}>{meta && !meta.can_review && <div className="banner" role="status" data-testid="readonly-banner"><span>Sessão sem permissão de revisão ({meta.principal.kind === "agent" ? "token de agente" : meta.principal.channel}): você pode ler e propor, mas aprovar/ignorar exige uma sessão humana. Num terminal, rode <code>brain ui</code> e abra o link.</span></div>}{page}</main>
      </div>
      {pal && <Palette commands={commands} onClose={() => setPal(false)} />}
      {asst && <AssistantModal tab={asst} onClose={() => setAsst(undefined)} />}
      {add && <AddKnowledge onClose={() => setAdd(false)} project={section === "projects" ? r.path[1] : undefined} />}
    </div>
  );
}

function TokenGate({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState<boolean | undefined>(undefined); const [t, setT] = useState("");
  const check = () => api("/api/meta").then(() => setOk(true)).catch(() => setOk(false));
  useEffect(() => { check(); }, []);
  if (ok === undefined) return null;
  if (!ok) return (
    <div className="overlay" style={{ paddingTop: "20vh" }}><div className="modal" style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20 }}>Conectar ao Second Brain</h1><p className="sub">Abra pelo terminal com <code>brain ui</code> (emite uma sessão de revisão e já inclui o token). O token de <code>.brain/api-token</code> só dá acesso de leitura/proposta.</p>
      <div className="field"><input aria-label="Token" value={t} onChange={(e) => setT(e.target.value.trim())} placeholder="token" type="password" /></div>
      <button className="btn primary" onClick={() => { setToken(t); check(); }} disabled={!t}>Conectar</button>{getToken() && <p className="small muted">O token salvo foi recusado pela API.</p>}
    </div></div>
  );
  return <>{children}</>;
}

export default function App() { return <ToastProvider><TokenGate><Shell /></TokenGate></ToastProvider>; }
