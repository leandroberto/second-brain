// Copia os arquivos estáticos da janela (HTML e CSS) para dist/, ao lado do JS compilado.
const { cpSync, mkdirSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const origem = join(__dirname, '..', 'src', 'renderer');
const destino = join(__dirname, '..', 'dist', 'renderer');
mkdirSync(destino, { recursive: true });
for (const nome of readdirSync(origem)) {
  if (/\.(html|css)$/.test(nome)) cpSync(join(origem, nome), join(destino, nome));
}
