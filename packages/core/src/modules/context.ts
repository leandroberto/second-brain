import type { Aviso, ModuleBrain, ModuleContext, ModuleIa } from "@brain/module-sdk";
import type { Brain, ProposeInput } from "../brain.js";
import type { SearchFilters } from "../search.js";
import { modulePrincipal } from "./identity.js";
import { createModuleState, modulesStateRoot } from "./state.js";

/** Destino dos avisos e do badge de um módulo (a `AvisosStore` da Tarefa 4 implementa). */
export interface AvisosSink {
  avisar(modulo: string, a: Aviso): Promise<unknown>;
  badge(modulo: string, n: number): void;
}

export const AVISOS_NOOP: AvisosSink = { avisar: async () => undefined, badge: () => undefined };
export const IA_INDISPONIVEL: ModuleIa = { completar: async () => ({ ok: false, tipo: "erro", mensagem: "IA indisponível" }) };

type Patch = Parameters<Brain["editProposal"]>[1];

/**
 * Fachada de conhecimento do módulo: só leitura + propose/amend da própria proposta, sempre como `module/<id>`.
 * Sem write/decide/assist. O SDK é mais largo que o core (`Record<string, unknown>`); o `Brain` valida a entrada de verdade,
 * então a conversão para `ProposeInput`/`SearchFilters`/patch é explícita aqui.
 */
export function moduleBrain(brain: Brain, id: string): ModuleBrain {
  const quem = modulePrincipal(id);
  const b: ModuleBrain = {
    search: (query, filters, limit) => brain.search(query, (filters ?? {}) as SearchFilters, limit ?? 10, quem),
    context: (input) => brain.context(input, quem),
    get: (nid) => brain.get(nid, quem),
    similar: (draft) => brain.similar(draft as Parameters<Brain["similar"]>[0], quem),
    propose: (input) => brain.propose(input as unknown as ProposeInput, quem),
    amend: (pid, patch) => brain.editProposal(pid, patch as unknown as Patch, quem),
  };
  return b;
}

export function createModuleContext(brain: Brain, id: string, config: unknown, deps: { ia: ModuleIa; avisos: AvisosSink }): ModuleContext {
  const prefixo = `[module/${id}]`;
  return {
    id,
    config,
    brain: moduleBrain(brain, id),
    estado: createModuleState(modulesStateRoot(brain), id),
    ia: deps.ia,
    avisar: async (a) => { await deps.avisos.avisar(id, a); },
    badge: (n) => deps.avisos.badge(id, n),
    log: {
      info: (m) => { console.error(`${prefixo} ${m}`); },
      erro: (m, e) => { console.error(`${prefixo} ${m}${e ? `: ${e instanceof Error ? e.message : String(e)}` : ""}`); },
    },
  };
}
