/**
 * Markdown mínimo para as respostas da janela: títulos, listas, negrito,
 * código em linha e blocos de código. Tudo é escapado antes, então o
 * resultado pode ir para innerHTML. Quebras de linha são mantidas (a caixa
 * de resposta usa white-space: pre-wrap).
 */

function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emLinha(texto: string): string {
  return escapar(texto)
    .split(/(`[^`]+`)/)
    .map((parte) =>
      parte.startsWith('`') && parte.endsWith('`') && parte.length > 1
        ? `<code>${parte.slice(1, -1)}</code>`
        : parte.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'),
    )
    .join('');
}

function linha(texto: string): string {
  const titulo = /^#{1,6}\s+(.*)$/.exec(texto);
  if (titulo) return `<strong class="titulo">${emLinha(titulo[1])}</strong>`;
  const item = /^\s*[-*]\s+(.*)$/.exec(texto);
  if (item) return `• ${emLinha(item[1])}`;
  return emLinha(texto);
}

export function markdownParaHtml(texto: string): string {
  const linhas = texto.replace(/\r\n/g, '\n').split('\n');
  let saida = '';
  let separador = '';
  for (let i = 0; i < linhas.length; i++) {
    if (/^```/.test(linhas[i])) {
      const codigo: string[] = [];
      i++;
      while (i < linhas.length && !/^```\s*$/.test(linhas[i])) codigo.push(linhas[i++]);
      saida += `${separador}<pre>${escapar(codigo.join('\n'))}</pre>`;
      separador = ''; // o <pre> já é um bloco: a quebra depois da cerca some
      continue;
    }
    saida += separador + linha(linhas[i]);
    separador = '\n';
  }
  return saida;
}
