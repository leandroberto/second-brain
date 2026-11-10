import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertImportablePath, extractCandidates, importPath, importText, scanSource } from "../src/index.js";
import { cleanup, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

const ADR = `# ADR 0007 — Usar fila durável para notificações

Status: aceito · Data: 2026-01-10

## Contexto
O Telegram limita requisições e perdíamos mensagens em picos.

## Decisão
Notificações passam por uma fila durável com retry exponencial.

## Consequências
Latência maior em picos; nenhum envio perdido.
`;
const README = `# Promo Watcher

Monitora promoções em marketplaces brasileiros e avisa por Telegram quando o preço cai.

## Instalação
Rode pnpm install e depois pnpm dev. Esta seção não deve virar conhecimento nenhum.

## Armadilhas conhecidas
Atenção: páginas /lists do Mercado Livre expõem vários product_ids para o mesmo item. Cuidado ao resolver identidade; usar a precedência do melidata.

## Perguntas em aberto
Ainda não decidimos o orçamento de timeout por marketplace. TBD com o time de scraping.
`;
const AGENTS = `# Regras do projeto

## Hard rules
- Nunca commitar secrets no repositório.
- Sempre rodar os testes antes de abrir PR.
- Preferir referências a copiar código.
`;

function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "brain-imp-"));
  const w = (rel: string, c: string | Buffer) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), c); };
  execFileSync("git", ["init", "-q", "-b", "main", d]);
  w("README.md", README); w("AGENTS.md", AGENTS); w("docs/adr/0007-fila-duravel.md", ADR);
  w("docs/ruido.md", "# Ruído\n\n## Estrutura\nIsso é só listagem de pastas e nada durável acontece aqui, só texto de enchimento suficiente.\n");
  w("docs/segredo.md", "# Config\n\n## Armadilha de configuração\nCuidado: o token de produção é sk-abcdefghijklmnopqrstuvwxyz0123456789 e quebra quando expira. Atenção ao rotacionar.\n");
  w("node_modules/pkg/README.md", "# pkg\n\n## Armadilhas\nAtenção cuidado armadilha em node_modules que nunca deve ser lido por ninguém.\n");
  w("ignorado/doc.md", "# X\n\n## Decisão\nDecidimos algo muito importante em uma pasta ignorada pelo git, que não pode ser lida.\n");
  w(".gitignore", "ignorado/\n");
  w(".env", "TOKEN=abc");
  w("docs/enorme.md", "# Enorme\n\n" + "linha de texto repetida para encher o arquivo\n".repeat(8000));
  w("docs/binario.md", Buffer.from([0x23, 0x20, 0x61, 0x00, 0x01, 0x02]));
  const outside = mkdtempSync(join(tmpdir(), "brain-outside-")); writeFileSync(join(outside, "alvo.md"), "# alvo\n\n## Decisão\nDecidimos coisas fora do repositório que não devem ser lidas via symlink.\n");
  symlinkSync(join(outside, "alvo.md"), join(d, "docs", "link.md"));
  execFileSync("git", ["-C", d, "add", "-A"]); // inclui symlink e enorme; scan ainda deve filtrar
  execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return d;
}

describe("scan seguro", () => {
  it("respeita .gitignore, node_modules, segredos, binário, arquivo enorme e symlink", async () => {
    const r = await scanSource(makeRepo());
    const names = r.files.map((f) => f.rel);
    expect(names).toEqual(expect.arrayContaining(["README.md", "AGENTS.md", "docs/adr/0007-fila-duravel.md"]));
    for (const bad of ["node_modules/pkg/README.md", "ignorado/doc.md", "docs/enorme.md", "docs/binario.md", "docs/link.md"]) expect(names).not.toContain(bad);
    expect(r.skipped["arquivo grande"]).toBe(1); expect(r.skipped["binário"]).toBe(1); expect(r.skipped["symlink"]).toBe(1);
  });
  it("respeita limite de arquivos", async () => {
    const r = await scanSource(makeRepo(), { maxFiles: 2 });
    expect(r.files.length).toBe(2);
    expect(r.skipped["limite de arquivos"]).toBeGreaterThan(0);
  });
});

describe("extração heurística", () => {
  it("ADR vira UMA decisão com decisão/porquê/consequências (não um dump)", () => {
    const { candidates } = extractCandidates(ADR, "docs/adr/0007-fila-duravel.md");
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.type).toBe("decision"); expect(c.title).toBe("Usar fila durável para notificações"); expect(c.confidence).toBe("high");
    expect(c.body).toMatch(/\*\*Decisão:\*\*.*fila durável/s); expect(c.body).toMatch(/\*\*Por quê:\*\*.*Telegram/s);
  });
  it("README: visão geral + armadilha (learning) + pergunta em aberto; ignora instalação", () => {
    const { candidates } = extractCandidates(README, "README.md");
    const types = Object.fromEntries(candidates.map((c) => [c.type, c.title]));
    expect(types.project).toBe("Promo Watcher"); expect(types.learning).toMatch(/Armadilhas/); expect(types["open-question"]).toMatch(/timeout/);
    expect(candidates.some((c) => /Instala/.test(c.title))).toBe(false);
  });
  it("AGENTS.md: seção de regras vira UMA preferência com bullets", () => {
    const { candidates } = extractCandidates(AGENTS, "AGENTS.md");
    expect(candidates).toHaveLength(1); expect(candidates[0]!.type).toBe("preference"); expect(candidates[0]!.body).toContain("- Nunca commitar secrets");
  });
  it("SKILL.md é ignorado", () => expect(extractCandidates("# S\n\n## Decisão\nDecidimos algo bastante importante sobre skills e agentes aqui.\n", "skills/x/SKILL.md").candidates).toEqual([]));
});

describe("import → governança", () => {
  it("dry-run não grava nada; import cria propostas, rejeita segredo, não cria notas", async () => {
    const b = await tempBrain(); const repo = makeRepo();
    const dry = await importPath(b, repo, { dryRun: true });
    expect(b.listProposals()).toHaveLength(0); expect(dry.items.some((i) => i.status === "dry-run")).toBe(true);

    const rep = await importPath(b, repo, { project: "promo-watcher" });
    expect(rep.queued).toBeGreaterThanOrEqual(4);
    expect(b.listProposals().length).toBe(rep.queued);
    expect(b.db.rows("1=1").length).toBe(0); // NADA entrou direto na base
    const secret = rep.items.find((i) => /Armadilha de configuração/.test(i.candidate.title))!;
    expect(secret.status).toBe("rejected"); expect(secret.reason).toMatch(/secret_detected/);
    expect(JSON.stringify(rep)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 20) + "XX"); // nada a ecoar
    const p = b.listProposals().find((x) => x.import?.rule === "adr")!;
    expect(p.draft.project).toBe("promo-watcher"); expect(p.draft.source?.repository).toBeTruthy(); expect(p.import?.evidence).toBeTruthy(); expect(p.proposed_by.name).toBe("import");

    // reexecutar não duplica a fila
    const again = await importPath(b, repo, { project: "promo-watcher" });
    expect(again.queued).toBe(0); expect(b.listProposals().length).toBe(rep.queued);
    expect(again.items.filter((i) => i.status === "already-queued").length).toBe(rep.queued);

    // após aprovar, importar de novo marca como duplicata (não vai à fila)
    await b.resolve(p.id, { resolution: "create" }, human);
    const third = await importPath(b, repo, { project: "promo-watcher" });
    const adr = third.items.find((i) => i.candidate.title === p.draft.title)!;
    expect(adr.status).toBe("duplicate-skipped");
    b.close();
  });

  it("respeita --max e reporta excedentes", async () => {
    const b = await tempBrain();
    const rep = await importPath(b, makeRepo(), { max: 2 });
    expect(rep.queued).toBe(2); expect(rep.items.some((i) => i.status === "over-limit")).toBe(true);
    b.close();
  });

  it("texto colado: estruturado vira candidatos; texto solto vira um learning de baixa confiança", async () => {
    const b = await tempBrain();
    const r1 = await importText(b, README, { dryRun: true, project: "pw" });
    expect(r1.candidates).toBeGreaterThanOrEqual(2);
    const r2 = await importText(b, "Descobri que o webhook do Telegram reenvia a mesma atualização duas vezes quando respondemos devagar; precisa de idempotência por update_id.", { dryRun: true });
    expect(r2.items[0]!.candidate.type).toBe("learning"); expect(r2.items[0]!.candidate.confidence).toBe("low");
    await expect(importText(b, "x".repeat(500_000))).rejects.toMatchObject({ code: "too_large" });
    b.close();
  });

  it("caminho fora da home é recusado pela guarda da API", () => {
    expect(() => assertImportablePath("/etc", ["/home/nao-existe-xyz"])).toThrow();
    expect(() => assertImportablePath("/caminho/que/nao/existe/abc")).toThrow(/não existe/);
  });
});
