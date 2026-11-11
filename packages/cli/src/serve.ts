import { hostname } from "node:os";
import { AvisosStore, Scheduler, clearServeInfo, createModuleIa, loadConfig, loadModules, modulesConfigHash, modulesStateRoot, stopModules, writeServeInfo, type Assistant, type AssistantEngine, type Brain, type ModuleRegistry, type SessionStoreOptions } from "@brain/core";
import { startApi } from "@brain/api";

export interface ServeOptions {
  port: number;
  host?: string;
  webRoot?: string;
  build?: { commit?: string; id?: string };
  assistant?: Assistant;
  /** motor do assistente; sem ele, a IA dos módulos responde "IA indisponível" */
  engine?: AssistantEngine;
  sessions?: SessionStoreOptions;
}

export interface ServeHandle { url: string; token: string; registry: ModuleRegistry; close(): Promise<void> }

/**
 * Monta o `brain serve` (spec de módulos §7.12): módulos (`iniciar` com marcador de execução), agendador, API com rotas, aba e
 * avisos, e o `serve.json` anunciado só depois de a API escutar. `close()` desfaz tudo e apaga o `serve.json` (o `bin.ts` o chama
 * no SIGTERM/SIGINT). Sem módulos na config, o registro fica vazio e a API se comporta como antes.
 */
export async function startServe(b: Brain, o: ServeOptions): Promise<ServeHandle> {
  const root = modulesStateRoot(b);
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
  scheduler.start();
  const reiniciar = () => { try { return modulesConfigHash(loadConfig(b.vault.configPath).modules) !== hash; } catch { return false; } };

  let api;
  try {
    api = await startApi(b, { port: o.port, host: o.host, webRoot: o.webRoot, build: o.build, assistant: o.assistant, sessions: o.sessions, modules: { registry, scheduler, avisos, reiniciar } });
  } catch (e) {
    await scheduler.stop(); await stopModules(registry); registry.encerrarExecucoes();
    throw e;
  }
  writeServeInfo(root, { url: api.url, pid: process.pid, iniciado: new Date().toISOString() });

  let fechado: Promise<void> | undefined;
  const close = () => (fechado ??= (async () => {
    try {
      await api.close();
      await scheduler.stop();
      await stopModules(registry);
      registry.encerrarExecucoes();
    } finally { clearServeInfo(root); }
  })());
  return { url: api.url, token: api.token, registry, close };
}
