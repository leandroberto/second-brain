import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { BrainError } from "@brain/shared";
import { pathToFileURL } from "node:url";
import { SDK_VERSION, type ModuleDef, type ModuleIa } from "@brain/module-sdk";
import type { Brain } from "../brain.js";
import { safeResolve } from "../paths.js";
import { scanSecrets } from "../secrets.js";
import { AVISOS_NOOP, IA_INDISPONIVEL, createModuleContext, type AvisosSink } from "./context.js";
import { MODULE_ID_RE } from "./identity.js";
import { ModuleRegistry, mensagemSegura, type LoadedModule, type ModuleStatus } from "./registry.js";
import { validar } from "./schema.js";
import { serveEstado } from "./serve-info.js";
import { modulesStateRoot } from "./state.js";

/** Expande `~` e `$VAR`/`${VAR}` num caminho configurado. Variável ausente vira vazio. */
function expandir(p: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  return p.replace(/^~(?=$|\/)/, home).replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => env[a ?? b] ?? "");
}

/** Caminho já expandido precisa ser absoluto: relativo resolveria pelo cwd, e o do `serve` e o do MCP divergem. */
function absoluto(p: string, origem: string): string {
  if (!isAbsolute(p)) throw new BrainError("invalid", `${origem} deve ser absoluto (recebido: "${p}"); use um caminho completo, ~ ou $VAR`);
  return p;
}

/**
 * Ordem: `path` da config (com `~`/`$VAR`), depois `$BRAIN_MODULES_DIR/<id>`, por fim `~/.local/share/second-brain/modules/<id>`.
 * Lança `invalid` se o caminho, depois da expansão, for relativo.
 */
export function resolveModuleDir(id: string, entry: { path?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (entry.path) return absoluto(expandir(entry.path, env), `modules.${id}.path`);
  if (env.BRAIN_MODULES_DIR) return join(absoluto(expandir(env.BRAIN_MODULES_DIR, env), "BRAIN_MODULES_DIR"), id);
  return join(env.HOME || homedir(), ".local", "share", "second-brain", "modules", id);
}

/** Arquivo de entrada do pacote: `exports` ("." ou string; condições import/default) ou `main`. */
function entrada(dir: string): string {
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports?: unknown; main?: string };
  let alvo: unknown = pj.exports;
  if (alvo && typeof alvo === "object" && "." in alvo) alvo = (alvo as Record<string, unknown>)["."];
  while (alvo && typeof alvo === "object") {
    const o = alvo as Record<string, unknown>;
    alvo = o.import ?? o.default;
  }
  const rel = typeof alvo === "string" ? alvo : pj.main;
  if (!rel) throw new Error("package.json sem exports nem main");
  return resolve(dir, rel);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Importa o `export default` do pacote do módulo (sem validar o contrato). Lança se não houver. */
export async function importModuleDef(dir: string): Promise<ModuleDef> {
  const mod = await import(pathToFileURL(entrada(dir)).href) as { default?: ModuleDef };
  if (!mod.default || typeof mod.default !== "object") throw new Error("o módulo não tem export default (use defineModule)");
  return mod.default;
}

async function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`tempo esgotado (${ms} ms)`)), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

export interface LoadOptions {
  modo: "serve" | "definicoes";
  deps?: { iaPara?: (id: string) => ModuleIa; avisos?: AvisosSink };
  hostname?: string;
  iniciarTimeoutMs?: number;
  /** `false` (só `brain modules check`, em modo `definicoes`): não exige a config do vault, que a checagem não tem */
  validarConfig?: boolean;
}

/**
 * Carrega os módulos da config do vault. Nenhuma falha de um módulo derruba o processo nem os outros: vira `falho` com a causa.
 * Com `modo: "definicoes"` (MCP) não cria contexto nem chama `iniciar`.
 */
export async function loadModules(brain: Brain, o: LoadOptions): Promise<ModuleRegistry> {
  const reg = new ModuleRegistry(modulesStateRoot(brain));
  const host = o.hostname ?? osHostname();
  const avisos = o.deps?.avisos ?? AVISOS_NOOP;
  const timeout = o.iniciarTimeoutMs ?? 30_000;
  // execução interrompida pela queda do serve anterior vira erro do módulo. Só com o anterior comprovadamente morto: um serve
  // vivo ou que não respondeu (event loop travado) ainda é dono do marcador
  if (o.modo === "serve") {
    const e = await serveEstado(modulesStateRoot(brain), brain.vault);
    if (e.estado === "morto" || e.pid === process.pid) reg.recuperarExecucoesInterrompidas();
    else reg.desligarMarcador();
  }

  for (const [id, entry] of Object.entries(brain.config.modules)) {
    if (entry.enabled === false) continue;
    let dir = ""; let caminhoInvalido: string | undefined;
    try { dir = resolveModuleDir(id, entry); } catch (e) { caminhoInvalido = msg(e); }
    const m: LoadedModule = { id, dir, status: "falho" as ModuleStatus };
    reg.add(m);
    const falhar = (causa: string) => { m.status = "falho"; m.causa = causa; };

    if (entry.host && entry.host !== host) { m.status = "inativo"; m.causa = "inativo nesta máquina"; continue; }
    if (caminhoInvalido) { m.status = "ausente"; m.causa = caminhoInvalido; continue; }
    if (!existsSync(dir)) { m.status = "ausente"; m.causa = `pasta do módulo não encontrada: ${dir}`; continue; }

    let def: ModuleDef;
    try { def = await importModuleDef(dir); }
    catch (e) { falhar(mensagemSegura(`falha ao importar o módulo: ${msg(e)}`)); continue; }

    m.def = def;
    m.versao = typeof def.versao === "string" ? def.versao : undefined;
    if (def.sdk !== SDK_VERSION) { falhar(`sdk incompatível: o módulo declara sdk ${String(def.sdk)}, o Second Brain entende sdk ${SDK_VERSION}`); continue; }
    if (typeof def.id !== "string" || !MODULE_ID_RE.test(def.id)) { falhar(`id do módulo inválido: "${String(def.id)}" (use ${MODULE_ID_RE.source})`); continue; }
    if (def.id !== id) { falhar(`id do módulo ("${def.id}") difere da chave na config ("${id}")`); continue; }
    if (!MODULE_ID_RE.test(id)) { falhar(`id inválido na config: "${id}"`); continue; }

    const validarConfig = o.validarConfig !== false || o.modo === "serve";
    // o valor nunca entra na mensagem
    if (validarConfig && scanSecrets(JSON.stringify(entry.config ?? null)).length) { falhar(`segredo na configuração do módulo ${id}: use variável de ambiente ou o cofre do sistema`); continue; }

    let config: unknown = entry.config;
    if (def.configSchema && validarConfig) {
      const r = await validar(def.configSchema, entry.config);
      if (!r.ok) { falhar(`configuração inválida: ${r.mensagem}`); continue; }
      config = r.value;
    }

    if (def.aba) {
      // a aba é servida de dentro desta pasta (mesmo `safeResolve` da API): raiz do módulo, absoluta ou fora dele não serve
      let raizDaAba: string | undefined;
      try { raizDaAba = typeof def.aba.pasta === "string" ? safeResolve(dir, def.aba.pasta) : undefined; } catch { raizDaAba = undefined; }
      if (!raizDaAba) { falhar(`aba.pasta deve ser uma subpasta do módulo (recebido: "${String(def.aba.pasta)}")`); continue; }
      if (!existsSync(join(raizDaAba, "index.html"))) { falhar(`a aba "${def.aba.titulo}" não tem ${def.aba.pasta}/index.html`); continue; }
    }

    if (o.modo === "definicoes") { m.status = "ativo"; m.causa = undefined; continue; }

    try {
      const ctx = createModuleContext(brain, id, config, { ia: o.deps?.iaPara?.(id) ?? IA_INDISPONIVEL, avisos });
      m.ctx = ctx;
      if (def.iniciar) await reg.executando(id, "iniciar", () => comTimeout(def.iniciar!(ctx), timeout));
      m.status = "ativo"; m.causa = undefined;
    } catch (e) {
      m.ctx = undefined;
      falhar(mensagemSegura(`iniciar falhou: ${msg(e)}`)); // vai crua para a API, a UI e o doctor: mesma higiene dos erros
      reg.recordError(id, "iniciar", e);
    }
  }
  return reg;
}

/** Chama `parar()` de cada módulo ativo, em paralelo, com timeout. Erros e estouros só são registrados. */
export async function stopModules(reg: ModuleRegistry, timeoutMs = 5000): Promise<void> {
  await Promise.all(reg.list().filter((m) => m.status === "ativo" && m.def?.parar).map(async (m) => {
    try { await comTimeout(m.def!.parar!(), timeoutMs); }
    catch (e) { reg.recordError(m.id, "parar", e); }
  }));
}
