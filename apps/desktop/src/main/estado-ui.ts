import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Modo } from './tipos';

/** Último modo usado na janela (spec §7.2), em <userData>/estado.json. */

function arquivo(dir: string): string {
  return join(dir, 'estado.json');
}

export function lerUltimoModo(dir: string): Modo {
  try {
    const { ultimoModo } = JSON.parse(readFileSync(arquivo(dir), 'utf8'));
    return ultimoModo === 'perguntar' ? 'perguntar' : 'anotar';
  } catch {
    return 'anotar';
  }
}

export function gravarUltimoModo(dir: string, modo: Modo): void {
  writeFileSync(arquivo(dir), JSON.stringify({ ultimoModo: modo }), 'utf8');
}
