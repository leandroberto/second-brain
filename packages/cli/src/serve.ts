import { hostname } from "node:os";
import { AvisosStore, Scheduler, clearServeInfo, createModuleIa, loadConfig, loadModules, modulesConfigHash, modulesStateRoot, serveEstado, acquireServeLock, stopModules, writeServeInfo, type Assistant, type AssistantEngine, type Brain, type ModuleRegistry, type SessionStoreOptions } from "@brain/core";
import { startApi, type Conferir } from "@brain/api";
import { BrainError } from "@brain/shared";
import { esperarServeAnterior } from "./reinicio.js";
import { conferirEmProcessoFilho } from "./modules.js";

export interface ServeOptions {
  port: number;
  host?: string;
  webRoot?: string;
  build?: { commit?: string; id?: string };
  assistant?: Assistant;
  /** motor do assistente; sem ele, a IA dos módulos responde "IA indisponível" */
  engine?: AssistantEngine;
  sessions?: SessionStoreOptions;
  /**
   * `false` só em teste: não liga o tick automático do agendador (as tarefas rodam só por "rodar agora"), para o teste não
   * competir com o relógio real. Padrão (e sempre em produção): ligado.
   */
  agendador?: boolean;
  /** reinicia este processo (`reiniciarProcesso`, montado pelo `bin.ts`); repassado à API de módulos */
  reiniciarServe?: () => Promise<void>;
  /** conferência de módulo para o gerenciamento pela UI (padrão: `conferirEmProcessoFilho` com o `bin.js` deste build) */
  conferir?: Conferir;
}

export interface ServeHandle { url: string; token: string; registry: ModuleRegistry; close(): Promise<void> }

/**
 * Monta o `brain serve` (spec de módulos §7.12): módulos (`iniciar` com marcador de execução), agendador, API com rotas, aba e
 * avisos, e o `serve.json` anunciado só depois de a API escutar. `close()` desfaz tudo e apaga o `serve.json` (o `bin.ts` o chama
 * no SIGTERM/SIGINT). Sem módulos na config, o registro fica vazio e a API se comporta como antes.
 */
export async function startServe(b: Brain, o: ServeOptions): Promise<ServeHandle> {
  const root = modulesStateRoot(b);
  // cópia subida por um reinício: espera o serve anterior sair antes de disputar o lock (que continua decidindo sozinho)
  await esperarServeAnterior();
  // um segundo serve no mesmo vault rodaria `iniciar` e as tarefas de novo e pisaria no estado e no marcador do vivo.
  // Lock exclusivo primeiro (a recusa é atômica); depois o serve anunciado (um build antigo, sem lock): vivo ou que não
  // respondeu contam como "já há um serve"
  const lock = await acquireServeLock(root, b.vault);
  try {
    const e = await serveEstado(root, b.vault);
    if (e.estado === "vivo" && e.pid !== process.pid) throw new BrainError("locked", `já há um brain serve rodando para este vault em ${e.url}`);
    if (e.estado === "indeterminado" && e.pid !== process.pid) {
      throw new BrainError("locked", `há um brain serve para este vault em ${e.url} (pid ${e.pid}) que não respondeu (${e.motivo}); encerre-o (kill ${e.pid}) antes de subir outro`);
    }
    return await montar(b, o, root, lock);
  } catch (err) { lock.liberar(); throw err; }
}

async function montar(b: Brain, o: ServeOptions, root: string, lock: { liberar(): void }): Promise<ServeHandle> {
  const avisos = new AvisosStore(root);
  // hash do bloco `modules` carregado: `GET /api/modules` compara com o do config.yaml em disco a cada chamada
  const hash = modulesConfigHash(b.config.modules);
  const engine = o.engine;
  const registry = await loadModules(b, {
    modo: "serve",
    deps: { iaPara: engine ? (id) => createModuleIa(engine, b.config, root, id) : undefined, avisos },
    hostname: hostname(),
  });
  const scheduler = new Scheduler(registry, root);
  if (o.agendador !== false) scheduler.start();
  const reiniciar = () => { try { return modulesConfigHash(loadConfig(b.vault.configPath).modules) !== hash; } catch { return false; } };

  let api;
  try {
    api = await startApi(b, { port: o.port, host: o.host, webRoot: o.webRoot, build: o.build, assistant: o.assistant, sessions: o.sessions, modules: { registry, scheduler, avisos, reiniciar, root, reiniciarServe: o.reiniciarServe, conferir: o.conferir ?? ((c, cfg) => conferirEmProcessoFilho(c, cfg)) } });
  } catch (e) {
    await scheduler.stop(); await stopModules(registry); registry.encerrarExecucoes();
    throw e;
  }
  try { writeServeInfo(root, { url: api.url, pid: process.pid, iniciado: new Date().toISOString() }); }
  catch (e) {
    // a API já escuta: desfaz tudo antes de o startServe liberar o lock e relançar
    await api.close(); await scheduler.stop(); await stopModules(registry); registry.encerrarExecucoes();
    throw e;
  }

  let fechado: Promise<void> | undefined;
  const close = () => (fechado ??= (async () => {
    try {
      await api.close();
      await scheduler.stop();
      await stopModules(registry);
      registry.encerrarExecucoes();
    } finally { clearServeInfo(root); lock.liberar(); }
  })());
  return { url: api.url, token: api.token, registry, close };
}
