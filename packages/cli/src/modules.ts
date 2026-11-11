import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { EventEmitter } from "node:events";
import { Brain, MODULE_ID_RE, ModuleRegistry, Scheduler, gastoIaDoDia, importModuleDef, issueHumanSession, loadModules, modulesStateRoot, parseCron, revokeHumanSession, serveEstado, serveFallbackUrl, type Check, type ModuleError, type StatusTarefa } from "@brain/core";
import { problemaDaFerramenta } from "@brain/mcp";
import { realIO, requireHuman } from "./admin.js";

/** Um módulo como `brain modules list` e o doctor mostram (do `serve` vivo ou do disco). */
export interface ResumoModulo {
  id: string; nome: string; status: string; causa?: string; versao?: string;
  tarefas: StatusTarefa[];
  /** os mais recentes, em ordem cronológica, já truncados e sem possíveis segredos */
  erros: ModuleError[];
  iaHojeUsd: number;
}
export interface EstadoModulos { fonte: "serve" | "disco"; reiniciar: boolean; modulos: ResumoModulo[] }

const lerToken = (b: Brain): string | undefined => { try { return readFileSync(b.vault.tokenPath, "utf8").trim() || undefined; } catch { return undefined; } };
const ERROS_LISTADOS = 10;

/**
 * Estado dos módulos: com o `serve` no ar (o do `serve.json` confirmado, ou a porta de fallback), `GET /api/modules` com o
 * api-token (status real, `reiniciar` e erros recentes); sem ele, monta pelo disco (config + definições + `_scheduler.json` +
 * `_erros.jsonl`). Gasto de IA do dia (`_ia.json`) vem sempre do disco, que é da mesma máquina. `undefined` = nenhum módulo.
 */
export async function estadoDosModulos(b: Brain, port?: number): Promise<EstadoModulos | undefined> {
  if (!Object.keys(b.config.modules).length) return undefined;
  const root = modulesStateRoot(b);
  const disco = new ModuleRegistry(root);
  const ia = (id: string) => gastoIaDoDia(root, id);

  const token = lerToken(b);
  if (token) {
    try {
      // vivo → ele; morto/sem serve.json → porta de fallback; anunciado mas sem resposta → direto para o disco
      const e = await serveEstado(root, b.vault);
      if (e.estado === "indeterminado") throw new Error(e.motivo);
      const url = e.estado === "vivo" ? e.url : serveFallbackUrl(port ? { ...process.env, BRAIN_PORT: String(port) } : process.env);
      const r = await fetch(`${url}/api/modules`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const j = await r.json() as { modulos?: Array<Omit<ResumoModulo, "iaHojeUsd"> & { erros?: ModuleError[] }>; reiniciar?: boolean };
        if (Array.isArray(j.modulos)) {
          return {
            fonte: "serve", reiniciar: j.reiniciar === true,
            modulos: j.modulos.map((m) => ({ ...m, tarefas: m.tarefas ?? [], erros: Array.isArray(m.erros) ? m.erros : disco.errosRecentes(m.id, ERROS_LISTADOS), iaHojeUsd: ia(m.id) })),
          };
        }
      }
    } catch { /* serve fora do ar (ou de outro vault): cai para o disco */ }
  }

  const reg = await loadModules(b, { modo: "definicoes" });
  // o status das tarefas sai de um registro sem raiz: ler o estado não grava nada em `_erros.jsonl`
  const leitura = new ModuleRegistry();
  for (const m of reg.list()) leitura.add(m);
  const agenda = new Scheduler(leitura, root);
  return {
    fonte: "disco", reiniciar: false,
    modulos: reg.list().map((m) => ({
      id: m.id, nome: m.def?.nome ?? m.id, status: m.status, causa: m.causa, versao: m.versao,
      tarefas: m.status === "ativo" ? agenda.status(m.id) : [], erros: disco.errosRecentes(m.id, ERROS_LISTADOS), iaHojeUsd: ia(m.id),
    })),
  };
}

const REINICIAR = "a configuração de módulos mudou: reinicie o brain serve";
/** Data/hora LOCAL (o cron das tarefas é na hora local da máquina). */
const quando = (iso?: string) => {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const usd = (n: number) => `US$ ${n.toFixed(2)}`;
const linhaTarefa = (t: StatusTarefa) =>
  `${t.tarefa} (${t.quando}): última ${quando(t.inicio)} ${t.resultado ?? "—"}${t.erro ? ` (${t.erro})` : ""} · próxima ${quando(t.proxima)}${t.suspensa ? " · SUSPENSA" : ""}`;
const linhaErro = (x: ModuleError) => `erro ${quando(x.em)} ${x.onde}: ${x.mensagem}`;
const ERROS_NO_DOCTOR = 3;
const DIA_MS = 24 * 3600_000;
const erroNasUltimas24h = (m: ResumoModulo, agora = Date.now()) => m.erros.some((x) => agora - Date.parse(x.em) < DIA_MS);

/**
 * Checks do doctor: um resumo (`modules`) e um por módulo, com status, causa, versão, tarefas, gasto de IA do dia e os erros
 * recentes. Módulo falho/ausente, tarefa com erro ou suspensa, ou erro registrado nas últimas 24 h: `warn` (nunca `fail`: o
 * módulo é extensão opcional). Sem módulos configurados, nenhum check.
 */
export async function modulesChecks(b: Brain, port?: number): Promise<Check[]> {
  const e = await estadoDosModulos(b, port);
  if (!e) return [];
  const out: Check[] = [];
  const problema = (m: ResumoModulo) => m.status === "falho" || m.status === "ausente" || erroNasUltimas24h(m) || m.tarefas.some((t) => t.suspensa || (t.resultado && t.resultado !== "ok"));
  const ativos = e.modulos.filter((m) => m.status === "ativo").length;
  const resumo = `${e.modulos.length} módulo(s), ${ativos} ativo(s) (${e.fonte === "serve" ? "estado do brain serve" : "brain serve fora do ar: estado em disco"})`;
  out.push({ id: "modules", name: "Módulos", status: e.reiniciar || e.modulos.some(problema) ? "warn" : "ok", detail: e.reiniciar ? `${resumo}; ${REINICIAR}` : resumo, ...(e.reiniciar ? { fix: "reinicie o brain serve" } : {}) });
  for (const m of e.modulos) {
    const partes = [
      m.status + (m.causa ? `: ${m.causa}` : ""), m.versao ? `v${m.versao}` : undefined, ...m.tarefas.map(linhaTarefa), `IA hoje ${usd(m.iaHojeUsd)}`,
      ...m.erros.slice(-ERROS_NO_DOCTOR).reverse().map(linhaErro),
    ].filter(Boolean);
    out.push({ id: `module-${m.id}`, name: `Módulo ${m.id}`, status: problema(m) ? "warn" : "ok", detail: partes.join(" · "), ...(problema(m) ? { fix: `brain modules list (erros recentes de ${m.id})` } : {}) });
  }
  return out;
}

function imprimirLista(e: EstadoModulos): void {
  console.log(`Módulos (${e.fonte === "serve" ? "brain serve" : "brain serve fora do ar: estado em disco"})`);
  for (const m of e.modulos) {
    console.log(`  ${m.id.padEnd(20)} ${m.status.padEnd(8)} ${(m.versao ? `v${m.versao}` : "").padEnd(10)} IA hoje ${usd(m.iaHojeUsd)}${m.causa ? `  — ${m.causa}` : ""}`);
    for (const t of m.tarefas) console.log(`      tarefa ${linhaTarefa(t)}`);
    for (const x of m.erros.slice(-ERROS_NO_DOCTOR)) console.log(`      ${linhaErro(x)}`);
  }
  if (e.reiniciar) console.log(`\n${REINICIAR}`);
}

/** `--ocorrencia AAAA-MM-DD` (meia-noite local) ou data/hora ISO → ISO; `undefined` se inválida. */
function ocorrenciaIso(v: string): string | undefined {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? new Date(v) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const NAO_RODANDO = "o brain serve não está rodando; a tarefa roda nele (suba com: brain serve)";
const TIMEOUT_RUN_MS = 15 * 60_000;

export interface DisparoTarefa {
  /** URL do serve CONFIRMADO (`serveEstado` = `vivo`), nunca a porta de fallback: a requisição leva uma sessão humana */
  url: string; id: string; tarefa: string; ocorrencia?: string;
  emitir(): string;
  revogar(sessao: string): void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** de onde vêm SIGINT/SIGTERM (padrão: `process`) e como sair depois de revogar (padrão: `process.exit`) */
  sinais?: Pick<EventEmitter, "once" | "off">;
  sair?: (codigo: number) => void;
}

/**
 * Emite a sessão humana curta, faz o `POST .../_tarefas/<tarefa>/rodar` e revoga a sessão em TODOS os caminhos: fim normal,
 * erro de rede, timeout, HTTP ≠ 2xx e Ctrl+C/SIGTERM (revoga e sai com 130).
 */
export async function dispararTarefa(o: DisparoTarefa): Promise<{ codigo: number; saida?: string; erro?: string }> {
  const sinais = o.sinais ?? process;
  const sessao = o.emitir();
  let revogada = false;
  const revogar = () => { if (revogada) return; revogada = true; try { o.revogar(sessao); } catch { /* a sessão expira em 5 min de qualquer jeito */ } };
  const interromper = () => { revogar(); (o.sair ?? ((c: number) => process.exit(c)))(130); };
  sinais.once("SIGINT", interromper); sinais.once("SIGTERM", interromper);
  try {
    let r: Response;
    try {
      r = await (o.fetch ?? fetch)(`${o.url}/api/modules/${encodeURIComponent(o.id)}/_tarefas/${encodeURIComponent(o.tarefa)}/rodar`, {
        method: "POST", headers: { authorization: `Bearer ${sessao}`, "content-type": "application/json" },
        body: JSON.stringify(o.ocorrencia ? { ocorrencia: o.ocorrencia } : {}), signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_RUN_MS),
      });
    } catch (e) {
      const min = Math.round((o.timeoutMs ?? TIMEOUT_RUN_MS) / 60_000);
      if ((e as Error)?.name === "TimeoutError") return { codigo: 1, erro: `o brain serve não respondeu em ${min} min (a tarefa pode seguir rodando nele; veja brain modules list)` };
      // conexão recusada: a requisição nem saiu. Qualquer outro erro de rede pode ter acontecido com a tarefa já começada
      if ((e as { cause?: { code?: unknown } })?.cause?.code === "ECONNREFUSED") return { codigo: 1, erro: NAO_RODANDO };
      return { codigo: 1, erro: "a conexão com o brain serve caiu durante a execução; confira o resultado em brain modules list" };
    }
    const j = await r.json().catch(() => ({})) as { resultado?: string; erro?: string; message?: string };
    if (!r.ok) return { codigo: 1, erro: `o brain serve recusou (${r.status}): ${j.message ?? "sem detalhe"}` };
    return { codigo: j.resultado === "ok" ? 0 : 1, saida: `${o.id}/${o.tarefa}: ${j.resultado ?? "?"}${j.erro ? ` — ${j.erro}` : ""}` };
  } finally {
    sinais.off("SIGINT", interromper); sinais.off("SIGTERM", interromper);
    revogar();
  }
}

/**
 * `brain modules run`: dispara a tarefa NO SERVE com uma sessão humana curta (5 min), revogada no fim (spec §7.8). Exige
 * terminal interativo e a prova de humano (com frase-senha quando o vault exige), porque a tarefa pode causar ação externa.
 * O serve precisa estar confirmado (`serveEstado` = `vivo`) ANTES de pedir a prova de humano e emitir a sessão.
 */
async function rodarTarefa(b: Brain, id: string, tarefa: string, o: { ocorrencia?: string }): Promise<number> {
  let ocorrencia: string | undefined;
  if (o.ocorrencia !== undefined) {
    ocorrencia = ocorrenciaIso(o.ocorrencia);
    if (!ocorrencia) { console.error(`--ocorrencia inválida: "${o.ocorrencia}" (use AAAA-MM-DD)`); return 2; }
  }
  const vivo = await serveEstado(modulesStateRoot(b), b.vault);
  if (vivo.estado === "morto") { console.error(NAO_RODANDO); return 1; }
  if (vivo.estado === "indeterminado") { console.error(`o brain serve em ${vivo.url} (pid ${vivo.pid}) não respondeu (${vivo.motivo}); tente de novo ou reinicie-o`); return 1; }
  const who = await requireHuman(realIO(), "brain modules run", b);
  const r = await dispararTarefa({
    url: vivo.url, id, tarefa, ocorrencia,
    emitir: () => issueHumanSession(b.vault.root, who, { ttlMinutes: 5, label: "brain modules run" }),
    revogar: (t) => revokeHumanSession(b.vault.root, t),
  });
  if (r.saida) console.log(r.saida);
  if (r.erro) console.error(r.erro);
  return r.codigo;
}

/**
 * `brain modules check <pasta>`: valida o módulo sem ligá-lo, com o carregador real em modo `definicoes` num registro isolado
 * (vault e estado temporários, nada do vault do usuário). A config do módulo não é exigida (a checagem não a tem).
 */
export async function checarModulo(pasta: string): Promise<{ id?: string; versao?: string; causas: string[] }> {
  const dir = resolve(pasta);
  if (!existsSync(join(dir, "package.json"))) return { causas: [`não é um pacote de módulo (sem package.json): ${dir}`] };
  let id = basename(dir);
  try { const def = await importModuleDef(dir); if (typeof def.id === "string" && def.id) id = def.id; }
  catch (e) { return { causas: [`falha ao importar o módulo: ${(e as Error)?.message ?? String(e)}`] }; }

  const tmp = mkdtempSync(join(tmpdir(), "brain-modules-check-"));
  const estadoAntes = process.env.BRAIN_STATE_DIR;
  process.env.BRAIN_STATE_DIR = join(tmp, "estado"); // o estado do registro isolado nunca vai para o do usuário
  let b: Brain | undefined;
  try {
    b = await Brain.init(join(tmp, "vault"));
    b.config.modules = { [id]: { enabled: true, path: dir, ia_max_usd_dia: 2 } };
    const m = (await loadModules(b, { modo: "definicoes", validarConfig: false })).get(id);
    const causas: string[] = [];
    if (!MODULE_ID_RE.test(id)) causas.push(`id do módulo inválido: "${id}" (use ${MODULE_ID_RE.source})`);
    if (!m || m.status !== "ativo" || !m.def) { causas.push(m?.causa ?? "módulo não carregado"); return { id, versao: m?.versao, causas: [...new Set(causas)] }; }
    const def = m.def;
    if (typeof def.nome !== "string" || !def.nome.trim()) causas.push("nome ausente");
    if (typeof def.versao !== "string" || !def.versao.trim()) causas.push("versao ausente");
    if (def.configSchema !== undefined && typeof (def.configSchema as { "~standard"?: { validate?: unknown } })?.["~standard"]?.validate !== "function") causas.push("configSchema não é um Standard Schema (use zod 4)");
    const nomes = new Set<string>();
    for (const f of Array.isArray(def.ferramentasMcp) ? def.ferramentasMcp : def.ferramentasMcp === undefined ? [] : [null]) {
      const p = problemaDaFerramenta(f);
      if (p) { causas.push(p); continue; }
      if (nomes.has(f!.nome)) causas.push(`ferramenta ${f!.nome} repetida`);
      nomes.add(f!.nome);
    }
    for (const r of Array.isArray(def.rotas) ? def.rotas : def.rotas === undefined ? [] : [null]) {
      if (!r || !["GET", "POST", "PUT", "DELETE"].includes(r.metodo) || typeof r.caminho !== "string" || !r.caminho.startsWith("/") || typeof r.rodar !== "function") causas.push(`rota inválida: ${r ? `${String(r.metodo)} ${String(r.caminho)}` : String(r)} (metodo GET/POST/PUT/DELETE, caminho com "/" e rodar)`);
    }
    const tarefas = new Set<string>();
    for (const t of Array.isArray(def.tarefas) ? def.tarefas : def.tarefas === undefined ? [] : [null]) {
      if (!t || typeof t.id !== "string" || !t.id || typeof t.rodar !== "function") { causas.push(`tarefa inválida: ${t ? String(t.id) : String(t)} (id e rodar)`); continue; }
      if (tarefas.has(t.id)) causas.push(`tarefa ${t.id} repetida`);
      tarefas.add(t.id);
      try { parseCron(t.quando); } catch (e) { causas.push(`tarefa ${t.id}: quando inválido (${(e as Error).message})`); }
    }
    return { id, versao: m.versao, causas };
  } finally {
    b?.close();
    if (estadoAntes === undefined) delete process.env.BRAIN_STATE_DIR; else process.env.BRAIN_STATE_DIR = estadoAntes;
    rmSync(tmp, { recursive: true, force: true });
  }
}

const USO = "uso: brain modules list | run <id> <tarefa> [--ocorrencia AAAA-MM-DD] | check <pasta>";

/** `brain modules <list|run|check>`; devolve o código de saída. */
export async function modulesCommand(args: string[], o: { vault: string; port?: number; ocorrencia?: string }): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "check": {
      if (!rest[0]) { console.error(USO); return 2; }
      const r = await checarModulo(rest[0]);
      if (!r.causas.length) { console.log(`✔ módulo ${r.id}${r.versao ? ` v${r.versao}` : ""}: ok`); return 0; }
      console.log(`✘ módulo ${r.id ?? rest[0]}: ${r.causas.length} problema(s)`);
      for (const c of r.causas) console.log(`  - ${c}`);
      return 1;
    }
    case "run": {
      const [id, tarefa] = rest;
      if (!id || !tarefa) { console.error(USO); return 2; }
      // antes de abrir o vault: sem TTY a resposta é sempre não (a tarefa pode causar ação externa)
      if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error("brain modules run exige um terminal interativo (a tarefa pode causar ação externa); agentes e scripts não disparam tarefas"); return 1; }
      const b = await Brain.open(o.vault);
      try { return await rodarTarefa(b, id, tarefa, { ocorrencia: o.ocorrencia }); } finally { b.close(); }
    }
    case "list": {
      const b = await Brain.open(o.vault);
      try {
        const e = await estadoDosModulos(b, o.port);
        if (!e) { console.log("nenhum módulo configurado (chave modules no .brain/config.yaml)"); return 0; }
        imprimirLista(e);
        return 0;
      } finally { b.close(); }
    }
    default: console.error(USO); return 2;
  }
}
