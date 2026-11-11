import type { ClienteApi, RespostaAnotar } from './cliente-api';
import type { FilaLocal } from './fila-local';

/**
 * Anota pela API; se ela não está ao alcance (offline ou sem pareamento), guarda o texto na fila local para
 * enviar depois. Erros 4xx (ex.: texto grande demais) e `incerto` não vão para a fila: o chamador devolve o texto
 * à janela e avisa.
 */
export async function anotarComFila(
  cliente: Pick<ClienteApi, 'anotar'>,
  fila: FilaLocal,
  texto: string,
): Promise<{ resposta: RespostaAnotar; enfileirado: boolean }> {
  const resposta = await cliente.anotar(texto);
  // `incerto` (timeout, 5xx) fica de fora de propósito: o servidor pode ter gravado, e reenviar duplicaria
  const guardar = !resposta.ok && (resposta.tipo === 'offline' || resposta.tipo === 'pareamento');
  if (guardar) fila.adicionar(texto);
  return { resposta, enfileirado: guardar };
}
