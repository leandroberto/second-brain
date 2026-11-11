import { Notification } from 'electron';
import type { TextoNotificacao } from './textos';

/**
 * Botão "Desfazer" dentro da notificação (spec §8.16). Ligado/desligado
 * conforme o teste das notificações (docs/spike-notificacoes.md). Com ou sem
 * botão, clicar no corpo da notificação chama `aoClicar`.
 */
export const BOTAO_DESFAZER_NA_NOTIFICACAO = true;

// Mantém referência até a notificação fechar, senão o coletor de lixo some com os eventos.
const vivas = new Set<Notification>();

export function notificar(
  texto: TextoNotificacao,
  acoes: { aoDesfazer?: () => void; aoClicar?: () => void; acao?: { texto: string; aoAcionar: () => void } } = {},
): void {
  const comBotao = texto.desfazer && BOTAO_DESFAZER_NA_NOTIFICACAO && acoes.aoDesfazer !== undefined;
  const botoes: Array<{ type: 'button'; text: string; rodar: () => void }> = [];
  if (comBotao) botoes.push({ type: 'button', text: 'Desfazer', rodar: () => acoes.aoDesfazer?.() });
  if (acoes.acao) botoes.push({ type: 'button', text: acoes.acao.texto, rodar: acoes.acao.aoAcionar });
  const n = new Notification({
    title: texto.titulo,
    body: texto.corpo,
    actions: botoes.map(({ type, text }) => ({ type, text })),
  });
  vivas.add(n);
  n.on('action', (_e, indice) => botoes[indice]?.rodar());
  n.on('click', () => acoes.aoClicar?.());
  n.on('close', () => vivas.delete(n));
  n.on('failed', (_e, erro) => console.error('[notificação]', erro));
  n.show();
}
