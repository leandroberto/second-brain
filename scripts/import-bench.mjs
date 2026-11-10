#!/usr/bin/env node
// Benchmark do Import Assistant: roda o importador (DRY-RUN, vault TEMPORÁRIO) nas fontes dadas e mede qualidade.
// Uso: node scripts/import-bench.mjs <saida.json> <projeto:caminho> [<projeto:caminho> ...]
// Não toca em nenhum vault real. O "lint" aqui é independente do extrator (não se auto-avalia).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { Brain, importPath } = await import(pathToFileURL(join(process.env.BENCH_CORE ?? join(root, "packages/core/dist"), "index.js")).href);
const [out, ...sources] = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), "brain-bench-"));
const brain = await Brain.init(join(tmp, "vault"));

import { lint } from "./bench-lint.mjs";

const all = []; const perSource = []; const rejections = [];
for (const spec of sources) {
  const i = spec.indexOf(":"); const project = spec.slice(0, i); const path = resolve(spec.slice(i + 1));
  const rep = await importPath(brain, path, { project, dryRun: true, max: 1000, includeDuplicates: true });
  perSource.push({ project, path: path.split("/").slice(-2).join("/"), files: rep.files, candidates: rep.candidates, dropped_similar: rep.dropped_similar, skipped_sections: rep.skipped_sections, counts: rep.counts });
  for (const r of rep.rejected) rejections.push({ project, ...r, source: r.source.path + "#" + (r.source.heading ?? "") });
  for (const it of rep.items) all.push({ project, title: it.candidate.title, type: it.candidate.type, confidence: it.candidate.confidence, rule: it.candidate.rule, status: it.status, classification: it.analysis.classification, source: it.source_ref.split("@")[0], body: it.candidate.body, why: it.candidate.why ?? [], flags: lint(it.candidate) });
}
const flagged = all.filter((c) => c.flags.length);
const summary = { total: all.length, flagged: flagged.length, clean: all.length - flagged.length, by_flag: {}, by_type: {}, by_confidence: {}, by_rule: {}, per_source: perSource };
for (const c of all) { for (const f of c.flags) summary.by_flag[f] = (summary.by_flag[f] ?? 0) + 1; summary.by_type[c.type] = (summary.by_type[c.type] ?? 0) + 1; summary.by_confidence[c.confidence] = (summary.by_confidence[c.confidence] ?? 0) + 1; summary.by_rule[c.rule] = (summary.by_rule[c.rule] ?? 0) + 1; }
summary.rejected = rejections.length; summary.rejected_by_reason = {}; for (const r of rejections) summary.rejected_by_reason[r.reason] = (summary.rejected_by_reason[r.reason] ?? 0) + 1;
writeFileSync(out, JSON.stringify({ summary, candidates: all, rejections }, null, 2));
console.log(JSON.stringify(summary, null, 1));
brain.close(); rmSync(tmp, { recursive: true, force: true });
