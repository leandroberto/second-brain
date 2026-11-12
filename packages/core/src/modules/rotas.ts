/** Um `:param` ocupa o segmento inteiro (`/itens/:id`); `/:a:b` e `/x:id` não são caminhos válidos. */
const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
const ESCAPAR_RE = /[.*+?^${}()|[\]\\]/g;

export interface RotaCompilada {
  /** valores crus (ainda codificados na URL) por nome de `:param`; `undefined` se o caminho não casa */
  casar(caminho: string): Record<string, string> | undefined;
}

/**
 * Compila o `caminho` declarado de uma rota de módulo (uma vez por rota). `undefined` = caminho inválido: segmento com `:`
 * que não é um `:param` inteiro, ou nome de parâmetro repetido. É a única definição de "caminho de rota válido": o carregador
 * (e portanto `brain modules check`) e a API usam esta função.
 */
export function compilarRota(declarado: string): RotaCompilada | undefined {
  const nomes: string[] = [];
  const partes: string[] = [];
  for (const seg of declarado.split("/")) {
    if (seg.includes(":")) {
      const mt = PARAM_RE.exec(seg);
      if (!mt || nomes.includes(mt[1]!)) return undefined;
      nomes.push(mt[1]!);
      partes.push("([^/]+)");
    } else partes.push(seg.replace(ESCAPAR_RE, "\\$&"));
  }
  const re = new RegExp(`^${partes.join("/")}$`);
  return {
    casar(caminho) {
      const mt = re.exec(caminho);
      if (!mt) return undefined;
      const params: Record<string, string> = {};
      nomes.forEach((n, i) => { params[n] = mt[i + 1]!; });
      return params;
    },
  };
}
