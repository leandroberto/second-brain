import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Token da sessão `desktop` (emitida por `brain pair-desktop`), guardado cifrado pelo Windows (DPAPI, via
 * Electron safeStorage) em <userData>, junto com a data de emissão (para a renovação). Sem criptografia
 * disponível, nada é gravado em claro. `cripto` é injetado (em produção, `safeStorage`) para o módulo ser
 * testável sem o Electron. Arquivo antigo (só o token cifrado) continua legível, sem data.
 */

export interface Cripto {
  isEncryptionAvailable(): boolean;
  encryptString(texto: string): Buffer;
  decryptString(dados: Buffer): string;
}

export interface Credencial {
  /** `emitidaEm`: quando o servidor emitiu o token (padrão: agora). */
  salvar(token: string, emitidaEm?: number): void;
  ler(): string | null;
  /** Token e data de emissão (`null` se a credencial foi gravada antes da data existir). */
  lerTudo(): { token: string; emitidaEm: number | null } | null;
}

export function criarCredencial(arquivo: string, cripto: Cripto): Credencial {
  function lerTudo(): { token: string; emitidaEm: number | null } | null {
    let texto: string;
    try {
      texto = cripto.decryptString(readFileSync(arquivo)).trim();
    } catch {
      return null;
    }
    if (!texto) return null;
    if (texto.startsWith('{')) {
      try {
        const j = JSON.parse(texto) as { token?: unknown; emitida_em?: unknown };
        const token = typeof j.token === 'string' ? j.token.trim() : '';
        if (!token) return null;
        const data = typeof j.emitida_em === 'string' ? Date.parse(j.emitida_em) : NaN;
        return { token, emitidaEm: Number.isFinite(data) ? data : null };
      } catch {
        return null;
      }
    }
    return { token: texto, emitidaEm: null };
  }

  return {
    salvar(token, emitidaEm = Date.now()) {
      const limpo = token.trim();
      if (!limpo) throw new Error('token vazio');
      if (!cripto.isEncryptionAvailable()) throw new Error('criptografia do sistema indisponível: não guardo o token em claro');
      mkdirSync(dirname(arquivo), { recursive: true });
      const tmp = `${arquivo}.${process.pid}.tmp`;
      writeFileSync(tmp, cripto.encryptString(JSON.stringify({ token: limpo, emitida_em: new Date(emitidaEm).toISOString() })));
      renameSync(tmp, arquivo);
    },
    ler() {
      return lerTudo()?.token ?? null;
    },
    lerTudo,
  };
}
