import type { RespostaRenovar } from './cliente-api';
import type { Credencial } from './credencial';

/**
 * Renovação da credencial do desktop (validade de 30 dias no servidor). Na subida e uma vez por dia, se a credencial
 * guardada tem mais de 7 dias (ou não tem data: gravada antes do campo existir), pede um token novo à API
 * (`POST /api/assistant/session/renew`, que revoga o antigo) e o guarda com a data nova. 401/403 → pareamento.
 */
export const IDADE_RENOVAR_MS = 7 * 864e5;
export const INTERVALO_RENOVACAO_MS = 864e5;

export type ResultadoRenovacao =
  | { estado: 'renovada'; token: string; erroAoGuardar?: string }
  | { estado: 'em-dia' | 'sem-credencial' | 'pareamento' | 'falhou' };

export async function renovarSeNecessario(
  credencial: Credencial,
  renovar: (token: string) => Promise<RespostaRenovar>,
  agora = Date.now(),
): Promise<ResultadoRenovacao> {
  const atual = credencial.lerTudo();
  if (!atual) return { estado: 'sem-credencial' };
  if (atual.emitidaEm !== null && agora - atual.emitidaEm < IDADE_RENOVAR_MS) return { estado: 'em-dia' };
  const r = await renovar(atual.token);
  if (!r.ok) return { estado: r.tipo === 'pareamento' ? 'pareamento' : 'falhou' };
  try {
    credencial.salvar(r.token, agora);
  } catch (e) {
    // o servidor já revogou o antigo: segue com o novo na memória e o chamador avisa
    return { estado: 'renovada', token: r.token, erroAoGuardar: (e as Error).message };
  }
  return { estado: 'renovada', token: r.token };
}
