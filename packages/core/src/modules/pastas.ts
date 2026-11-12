import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BrainError } from "@brain/shared";

export interface PastaListada { nome: string; caminho: string; provavelModulo: boolean }
export interface ListagemDePastas { caminho: string; pai?: string; pastas: PastaListada[] }

const SDK = "@brain/module-sdk";
const MAX_PACKAGE_JSON = 1024 * 1024;

const ehPasta = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Leitura estática do package.json: nunca importa nem executa nada da pasta. */
function dependeDoSdk(pasta: string): boolean {
  try {
    const arq = join(pasta, "package.json");
    const st = statSync(arq);
    if (!st.isFile() || st.size > MAX_PACKAGE_JSON) return false; // nunca lê FIFO, diretório nem arquivo enorme
    const pkg = JSON.parse(readFileSync(arq, "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies"].some((k) => {
      const d = pkg[k];
      return typeof d === "object" && d !== null && SDK in d;
    });
  } catch { return false; }
}

/** Lista as subpastas de `caminho` (padrão: `<home>/projetos`, senão `<home>`) para o navegador de pastas da UI. */
export function listarPastas(caminho?: string, o: { home?: string; mostrarOcultas?: boolean } = {}): ListagemDePastas {
  const home = o.home ?? homedir();
  const alvo = caminho ?? (ehPasta(join(home, "projetos")) ? join(home, "projetos") : home);
  if (!isAbsolute(alvo)) throw new BrainError("invalid", `${alvo} não é um caminho absoluto`);
  const base = resolve(alvo);
  let entradas;
  try { entradas = readdirSync(base, { withFileTypes: true }); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new BrainError("forbidden", `sem permissão para ler ${base}`);
    throw new BrainError("invalid", `${base} não é uma pasta`);
  }
  const pastas: PastaListada[] = [];
  for (const e of entradas) {
    if (!o.mostrarOcultas && e.name.startsWith(".")) continue;
    const completo = join(base, e.name);
    if (!e.isDirectory() && !(e.isSymbolicLink() && ehPasta(completo))) continue;
    let real: string;
    try { real = realpathSync(completo); } catch { continue; }
    pastas.push({ nome: e.name, caminho: real, provavelModulo: dependeDoSdk(real) });
  }
  pastas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const pai = dirname(base);
  return { caminho: base, ...(pai !== base ? { pai } : {}), pastas };
}

/** Caminho absoluto, normalizado e resolvido (symlinks) de uma pasta existente. */
export function caminhoRealDePasta(caminho: string): string {
  if (!isAbsolute(caminho)) throw new BrainError("invalid", `${caminho} não é um caminho absoluto`);
  try {
    const real = realpathSync(resolve(caminho));
    if (statSync(real).isDirectory()) return real;
  } catch { /* cai no erro abaixo */ }
  throw new BrainError("invalid", `${caminho} não é uma pasta`);
}
