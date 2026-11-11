import {
  MENSAGEM_INCERTO,
  MENSAGEM_PAREAMENTO,
  type AcaoNota,
  type RespostaAnotar,
  type RespostaDesfazer,
  type RespostaOrganizar,
  type RespostaPerguntar,
} from './cliente-api';

export { MENSAGEM_INCERTO, MENSAGEM_PAREAMENTO };

/** Textos exatos das notificações e das respostas da janela (em português). */

export interface TextoNotificacao {
  titulo: string;
  corpo: string;
  desfazer: boolean;
}

export type RespostaJanela =
  | { tipo: 'resposta'; texto: string; fontes: string[] }
  | { tipo: 'nao-anotado' }
  | { tipo: 'erro'; motivo: string; mensagem: string };

const MENSAGEM_AUTH = 'rode `claude setup-token` no WSL';
const PARADO = 'second-brain parado';

const ROTULO: Record<AcaoNota, string> = {
  criada: '',
  complementada: ' (complementada)',
  na_fila: ' (na fila de revisão)',
  ignorada: ' (ignorada)',
};

/** Resultado de uma captura enviada à API. Mostra sempre o `state` devolvido pela captura. */
export function textoResultado(r: RespostaAnotar): TextoNotificacao {
  if (!r.ok) {
    switch (r.tipo) {
      case 'offline':
        return textoGuardadoNaFila(1);
      case 'pareamento':
        return { titulo: 'Desktop não pareado', corpo: r.mensagem, desfazer: false };
      case 'incerto':
        return { titulo: 'Não sei se foi registrado', corpo: r.mensagem, desfazer: false };
      case 'http':
        return { titulo: 'Não consegui anotar', corpo: `${r.mensagem} (HTTP ${r.status})`, desfazer: false };
    }
  }
  const estado = `Estado: ${r.state}.`;
  const res = r.result;
  if (res.ok) {
    const notas = res.notas.map((n) => `${n.id}${ROTULO[n.acao]}`).join(', ');
    return {
      titulo: 'Anotado',
      corpo: `${notas ? `Guardei em ${notas}.` : 'Nenhuma nota nova.'} ${estado}${res.segredo_omitido ? ' Senha omitida.' : ''}`,
      desfazer: true,
    };
  }
  if (res.tipo === 'auth') {
    return {
      titulo: 'Claude deslogado',
      corpo: `Sua anotação está guardada, mas o Claude precisa de login: ${MENSAGEM_AUTH}. ${estado}`,
      desfazer: false,
    };
  }
  return { titulo: 'Guardado como pendente', corpo: `Organizo depois. (${res.mensagem}) ${estado}`, desfazer: false };
}

export function textoGuardadoNaFila(naFila: number): TextoNotificacao {
  return {
    titulo: 'second-brain parado, anotação guardada',
    corpo: `Envio assim que ele voltar (${naFila} na fila).`,
    desfazer: false,
  };
}

export function textoDesfazer(r: RespostaDesfazer | 'nenhuma'): TextoNotificacao {
  const t = (titulo: string, corpo: string): TextoNotificacao => ({ titulo, corpo, desfazer: false });
  if (r === 'nenhuma') return t('Nada para desfazer', 'Não há anotação recente do desktop para desfazer.');
  if (r.ok) {
    return r.reverted.length > 0
      ? t('Desfeito', 'Reabri a janela com o seu texto.')
      : t('Nada para desfazer', 'Esta captura já estava desfeita ou não tinha notas para reverter.');
  }
  switch (r.tipo) {
    case 'ocupado':
      return t('Captura em processamento', 'Captura ainda em processamento; tente de novo em instantes.');
    case 'inexistente':
      return t('Nada para desfazer', 'O second-brain não conhece mais essa captura.');
    case 'offline':
      return t(PARADO, 'Não consegui desfazer agora; tente quando ele voltar.');
    case 'pareamento':
      return t('Desktop não pareado', r.mensagem);
    case 'incerto':
      return t('Não sei se foi desfeito', 'A resposta não chegou. Confira a nota e a revisão antes de tentar de novo.');
    case 'http':
      return t('Não dá para desfazer', r.mensagem);
  }
}

export function textoResumoPendentes(r: RespostaOrganizar): TextoNotificacao {
  if (!r.ok) {
    if (r.tipo === 'offline') return { titulo: PARADO, corpo: 'Não consegui organizar os pendentes agora.', desfazer: false };
    if (r.tipo === 'pareamento') return { titulo: 'Desktop não pareado', corpo: r.mensagem, desfazer: false };
    if (r.tipo === 'incerto') {
      return { titulo: 'Não sei se organizou', corpo: 'A resposta não chegou. Use Organizar pendentes de novo em instantes.', desfazer: false };
    }
    return { titulo: 'Não consegui organizar', corpo: `${r.mensagem} (HTTP ${r.status})`, desfazer: false };
  }
  if (r.retried === 0 && r.restantes === 0) return { titulo: 'Nada pendente', corpo: 'Não há capturas pendentes.', desfazer: false };
  return {
    titulo: 'Pendentes organizados',
    corpo: `${r.retried} organizada(s), ${r.restantes} ainda pendente(s).`,
    desfazer: false,
  };
}

/** Converte a resposta da API para o formato que a janela já entende. */
export function textoPergunta(r: RespostaPerguntar): RespostaJanela {
  if (r.ok) {
    return r.resposta.trim() === 'Não está anotado.' && r.fontes.length === 0
      ? { tipo: 'nao-anotado' }
      : { tipo: 'resposta', texto: r.resposta, fontes: r.fontes };
  }
  switch (r.tipo) {
    case 'offline':
      return {
        tipo: 'erro',
        motivo: 'offline',
        mensagem: 'O second-brain está parado. Inicie-o pelo menu da bandeja e pergunte de novo.',
      };
    case 'pareamento':
      return { tipo: 'erro', motivo: 'pareamento', mensagem: r.mensagem };
    case 'incerto':
      return { tipo: 'erro', motivo: 'timeout', mensagem: 'A pergunta demorou demais para responder; tente de novo.' };
    case 'http':
      return { tipo: 'erro', motivo: 'http', mensagem: `${r.mensagem} (HTTP ${r.status})` };
    case 'auth':
      return { tipo: 'erro', motivo: 'auth', mensagem: `Claude deslogado: ${MENSAGEM_AUTH}.` };
    default:
      return { tipo: 'erro', motivo: r.tipo, mensagem: r.mensagem };
  }
}

export function textoFilaCorrompida(arquivo: string): TextoNotificacao {
  return {
    titulo: 'Fila local corrompida',
    corpo: `Guardei o arquivo original como ${arquivo} e comecei uma fila nova.`,
    desfazer: false,
  };
}

export function textoQuarentena(n: number): TextoNotificacao {
  return {
    titulo: 'Anotações em quarentena',
    corpo: `${n} anotação(ões) saíram da fila local: foram recusadas várias vezes ou ficaram sem confirmação de registro. Abra o arquivo pela bandeja para recuperar o texto e confira as pendentes antes de reenviar.`,
    desfazer: false,
  };
}

export function textoAtalhoOcupado(atalho: string): TextoNotificacao {
  return {
    titulo: `Atalho ${atalho} já está em uso`,
    corpo: 'Feche o outro programa que usa essa tecla e reinicie o second-brain desktop.',
    desfazer: false,
  };
}
