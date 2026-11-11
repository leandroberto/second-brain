import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { gravarUltimoModo, lerUltimoModo } from '../src/main/estado-ui';
import { acaoDaTecla } from '../src/renderer/teclado';

test('mapa de teclas da janela', () => {
  expect(acaoDaTecla({ key: 'Tab', shiftKey: false })).toBe('alternar');
  expect(acaoDaTecla({ key: 'Tab', shiftKey: true })).toBe('alternar');
  expect(acaoDaTecla({ key: 'Enter', shiftKey: false })).toBe('enviar');
  expect(acaoDaTecla({ key: 'Enter', shiftKey: true })).toBe('quebrar-linha');
  expect(acaoDaTecla({ key: 'Escape', shiftKey: false })).toBe('fechar');
  expect(acaoDaTecla({ key: 'a', shiftKey: false })).toBeNull();
});

test('último modo: padrão anotar, grava e lê de volta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cerebro-ui-'));
  expect(lerUltimoModo(dir)).toBe('anotar');
  gravarUltimoModo(dir, 'perguntar');
  expect(lerUltimoModo(dir)).toBe('perguntar');
});

test('último modo: arquivo corrompido volta ao padrão', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cerebro-ui-'));
  writeFileSync(join(dir, 'estado.json'), '{quebrado', 'utf8');
  expect(lerUltimoModo(dir)).toBe('anotar');
});
