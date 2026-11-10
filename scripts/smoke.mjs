#!/usr/bin/env node
// Smoke test de ponta a ponta em vault TEMPORÁRIO e HOME isolado (não toca na sua config nem no vault real):
//   init → import (texto) → serve → API health/review/import → doctor (handshake MCP real) → encerra.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "../packages/cli/dist/bin.js");
const home = mkdtempSync(join(tmpdir(), "brain-smoke-")); const vault = join(home, "vault");
const env = { ...process.env, HOME: home, BRAIN_VAULT: vault };
const port = 3800 + Math.floor(Math.random() * 150);
let server; let failed = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "✔" : "✘"} ${name}${extra ? "  " + extra : ""}`); if (!cond) failed++; };
const cli = (...a) => run(process.execPath, [BIN, ...a], { env, timeout: 60_000 });

try {
  await cli("init", vault);
  ok("init: vault + git", true);
  const md = "# Smoke\n\nProjeto de teste de fumaça.\n\n## Armadilhas conhecidas\nAtenção: o cron do host roda em UTC; cuidado ao agendar tarefas locais para não disparar três horas depois.\n";
  const imp = run(process.execPath, [BIN, "import", "-", "--project", "smoke"], { env }); imp.child.stdin.end(md); const r = await imp;
  ok("import: gera propostas (não notas)", /proposta\(s\) na Review Queue/.test(r.stdout));
  server = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { env, stdio: "ignore" });
  let tk = ""; for (let i = 0; i < 50 && !tk; i++) { await new Promise((s) => setTimeout(s, 200)); try { tk = readFileSync(join(vault, ".brain", "api-token"), "utf8").trim(); } catch { /* ainda subindo */ } }
  const api = async (p) => { for (let i = 0; i < 25; i++) { try { const x = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${tk}` } }); return x.json(); } catch { await new Promise((s) => setTimeout(s, 200)); } } throw new Error("API não respondeu"); };
  const health = await api("/api/health");
  ok("API: /api/health", health.git?.repo === true && health.api?.watcher === true, `watcher=${health.api?.watcher}`);
  ok("API: fila de revisão", (await api("/api/review")).length >= 1);
  ok("API: sem token → 401", (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 401);
  ok("UI: página inicial servida", (await fetch(`http://127.0.0.1:${port}/`)).ok);
  const d = await run(process.execPath, [BIN, "doctor", "--json", "--port", String(port)], { env }).catch((e) => e);
  const checks = JSON.parse(d.stdout); const by = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  ok("doctor: vault/git/sqlite/fts/índice", ["vault", "git", "sqlite", "fts", "index"].every((k) => by[k] === "ok"));
  ok("doctor: API + watcher", by.api === "ok" && by.watcher === "ok");
  ok("doctor: MCP (handshake real, 12 ferramentas)", by.mcp === "ok");
} catch (e) { console.error(e); failed++; }
finally { server?.kill(); rmSync(home, { recursive: true, force: true }); }
console.log(failed ? `\nSMOKE FALHOU (${failed})` : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
