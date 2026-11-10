#!/usr/bin/env node
// Dogfood da reconciliação de atualidade: importa (dry-run) repositórios reais num vault TEMPORÁRIO e mostra o veredito por candidato.
// Somente leitura nos repositórios. Uso: node scripts/freshness-bench.mjs saida.json caminho1 [caminho2 ...]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { Brain, importPath } from "../packages/core/dist/index.js";
import { reconcileBatch } from "../packages/core/dist/freshness/index.js";

// --cases arquivo.json: afirmações reais com gabarito (sem importar; só reconcilia)
if (process.argv[2] === "--cases") {
  const spec = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const root = spec.repo.replace(/^~/, homedir());
  const t0 = Date.now();
  const r = await reconcileBatch(spec.cases.map((c) => ({ title: c.title, body: c.body, path: c.path })), { scanRoot: root });
  let ok = 0;
  spec.cases.forEach((c, i) => {
    const f = r.results[i]; const hit = f?.state === c.expected || (c.expected === "superseded" && f?.state === "historical");
    if (hit) ok++;
    console.log(`${hit ? "✓" : "✗"} esperado=${c.expected} obtido=${f?.state}/${f?.confidence} impl=${f?.implementation} ${f?.effort} — ${c.title}: ${c.body.slice(0, 70)}`);
    for (const e of f?.evidence.slice(0, 3) ?? []) console.log(`     ${e.stance === "supports" ? "✓" : e.stance === "contradicts" ? "✗" : "·"} ${e.ref}: ${e.detail.slice(0, 140)}`);
  });
  console.log(`\n${ok}/${spec.cases.length} corretos · ${Date.now() - t0} ms (varredura ${r.repoMs} ms)`);
  if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify({ ok, total: spec.cases.length, results: r.results }, null, 2));
  process.exit(0);
}

const [out, ...repos] = process.argv.slice(2);
if (!out || !repos.length) { console.error("uso: node scripts/freshness-bench.mjs saida.json <repo> [repo...]"); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), "brain-fresh-bench-"));
const results = [];
try {
  const brain = await Brain.init(join(dir, "vault"));
  for (const r of repos) {
    const t0 = Date.now();
    const rep = await importPath(brain, resolve(r), { dryRun: true, max: 200, includeDuplicates: true });
    const ms = Date.now() - t0;
    const items = rep.items.map((i) => ({ title: i.candidate.title, type: i.candidate.type, path: i.candidate.source.path, extraction: i.candidate.confidence, f: i.candidate.freshness }));
    results.push({ repo: r, ms, summary: rep.freshness, items });
    console.log(`\n=== ${r}  (${ms} ms total; reconciliação ${rep.freshness?.ms} ms, varredura ${rep.freshness?.repo_ms} ms, ${rep.freshness?.files} arquivos, ${rep.freshness?.commits} commits)`);
    console.log("estados:", JSON.stringify(rep.freshness?.states), "esforço:", JSON.stringify(rep.freshness?.effort));
    for (const it of items) {
      const f = it.f;
      console.log(`- [${f?.state ?? "-"}/${f?.confidence ?? "-"} impl=${f?.implementation ?? "-"} intent=${f?.intent ?? "-"} ${f?.effort ?? ""}] (${f?.source.kind ?? "?"}) ${it.title.slice(0, 70)}  ← ${it.path}`);
      for (const e of f?.evidence.slice(0, 4) ?? []) console.log(`      ${e.stance === "supports" ? "✓" : e.stance === "contradicts" ? "✗" : "·"} ${e.ref}: ${e.detail.slice(0, 150)}`);
    }
  }
  brain.close();
} finally { rmSync(dir, { recursive: true, force: true }); }
writeFileSync(out, JSON.stringify(results, null, 2));
