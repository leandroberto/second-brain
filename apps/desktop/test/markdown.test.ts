import { expect, test } from 'vitest';
import { markdownParaHtml } from '../src/renderer/markdown';

test('escapa HTML antes de formatar', () => {
  expect(markdownParaHtml('<img src=x onerror=alert(1)> & "x"')).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;x&quot;');
});

test('negrito e código em linha', () => {
  expect(markdownParaHtml('fica na **batch-10**, rode `sumarizarNotificacoes`')).toBe(
    'fica na <strong>batch-10</strong>, rode <code>sumarizarNotificacoes</code>',
  );
});

test('títulos viram título destacado, sem os #', () => {
  expect(markdownParaHtml('## Primeiro: Local')).toBe('<strong class="titulo">Primeiro: Local</strong>');
  expect(markdownParaHtml('### Sub')).toBe('<strong class="titulo">Sub</strong>');
});

test('itens de lista com "-" ou "*" viram marcador', () => {
  expect(markdownParaHtml('- **Local:** x\n* outro')).toBe('• <strong>Local:</strong> x\n• outro');
});

test('linhas numeradas e quebras de linha ficam como estão', () => {
  const passos = '1º - notificacao\n2º - notificacao:name=NotificacaoBatchService\n\n3. terceiro';
  expect(markdownParaHtml(passos)).toBe(passos);
});

test('bloco de código não recebe formatação e perde as cercas', () => {
  expect(markdownParaHtml('antes\n```sql\nSELECT **x** FROM `t`;\n```\ndepois')).toBe(
    'antes\n<pre>SELECT **x** FROM `t`;</pre>depois',
  );
});

test('bloco de código sem fechamento vai até o fim', () => {
  expect(markdownParaHtml('```\na <b>\nb')).toBe('<pre>a &lt;b&gt;\nb</pre>');
});
