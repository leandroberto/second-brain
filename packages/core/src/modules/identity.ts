import { BrainError, type Principal } from "@brain/shared";
import { principal } from "../authz.js";

/** Regra do id de módulo (também usada em rotas, ferramentas MCP e pastas de estado). */
export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Regra do `nome` de ferramenta MCP de módulo: `<id>_<nome>` sai sempre um nome de ferramenta MCP válido, com no máximo 73
 * caracteres (id até 31 + `_` + nome até 41). Os clientes costumam prefixar o nome do servidor (ex.: `mcp__second-brain__`),
 * então o nome visto pelo modelo é mais longo que isso.
 */
export const MODULE_TOOL_RE = /^[a-z][a-z0-9_]{0,40}$/;

/** Identidade de um módulo no Core: agente no canal "module". Nunca humano; só pode `read`/`propose`/`amend` da própria proposta. */
export function modulePrincipal(id: string): Principal {
  if (!MODULE_ID_RE.test(id)) throw new BrainError("invalid", `id de módulo inválido: "${id}" (use ${MODULE_ID_RE.source})`);
  return principal("agent", `module/${id}`, "module");
}
