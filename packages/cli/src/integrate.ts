import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { integrationStatus, paths, START, END } from "@brain/core";
import { dirname, join } from "node:path";

interface Step { title: string; show: string; run: () => void; undo: () => void; files: string[] }

function steps(o: { vault: string; repoRoot: string }): Step[] {
  const bin = join(o.repoRoot, "packages/cli/dist/bin.js"); const node = process.execPath;
  const policy = join(o.vault, "AGENTS.md"); const skillSrc = join(o.vault, "skills/second-brain");
  const st = integrationStatus();
  return [
    {
      title: "Claude Code — servidor MCP (escopo user)", files: [paths.claudeJson],
      show: `claude mcp add --scope user --env BRAIN_VAULT=${o.vault} second-brain -- ${node} ${bin} mcp`,
      run: () => { if (st.claude.mcp) { execFileSync("claude", ["mcp", "remove", "--scope", "user", "second-brain"], { stdio: "ignore" }); } execFileSync("claude", ["mcp", "add", "--scope", "user", "--env", `BRAIN_VAULT=${o.vault}`, "--transport", "stdio", "second-brain", "--", node, bin, "mcp"], { stdio: "inherit" }); },
      undo: () => { execFileSync("claude", ["mcp", "remove", "--scope", "user", "second-brain"], { stdio: "inherit" }); },
    },
    {
      title: "Codex — servidor MCP", files: [paths.codexToml],
      show: `codex mcp add second-brain --env BRAIN_VAULT=${o.vault} -- ${node} ${bin} mcp`,
      run: () => { if (st.codex.mcp) execFileSync("codex", ["mcp", "remove", "second-brain"], { stdio: "ignore" }); execFileSync("codex", ["mcp", "add", "second-brain", "--env", `BRAIN_VAULT=${o.vault}`, "--", node, bin, "mcp"], { stdio: "inherit" }); },
      undo: () => { execFileSync("codex", ["mcp", "remove", "second-brain"], { stdio: "inherit" }); },
    },
    {
      title: "Política dos agentes (bloco gerenciado, preserva o resto do arquivo)", files: [paths.claudeMd, paths.codexMd],
      show: `~/.claude/CLAUDE.md ← @${policy}   |   ~/.codex/AGENTS.md ← conteúdo de AGENTS.md`,
      run: () => { managedBlock(paths.claudeMd, `# Second Brain\n@${policy}`); managedBlock(paths.codexMd, readFileSync(policy, "utf8")); },
      undo: () => { removeBlock(paths.claudeMd); removeBlock(paths.codexMd); },
    },
    {
      title: "Skill second-brain (symlinks)", files: [],
      show: `ln -s ${skillSrc} ${paths.claudeSkill}  e  ${paths.agentsSkill}`,
      run: () => { link(skillSrc, paths.claudeSkill); link(skillSrc, paths.agentsSkill); },
      undo: () => { for (const p of [paths.claudeSkill, paths.agentsSkill]) removeSkillLink(p, skillSrc); },
    },
  ];
}

/** Dry-run por padrão. `apply` faz backup dos arquivos tocados e aplica; `remove` desfaz. */
export async function integrate(o: { vault: string; repoRoot: string; apply: boolean; remove?: boolean; policyOnly?: boolean }): Promise<void> {
  if (o.policyOnly) { const policy = join(o.vault, "AGENTS.md"); const st = integrationStatus(); if (st.codex.policy) { managedBlock(paths.codexMd, readFileSync(policy, "utf8")); console.log("bloco global do Codex (~/.codex/AGENTS.md) atualizado"); } if (st.claude.policy) console.log("Claude Code importa o AGENTS.md do vault por @ (já atualizado)"); return; }
  const list = steps(o);
  if (!o.apply && !o.remove) {
    console.log("Dry-run (nada será alterado). Mudanças planejadas:\n");
    for (const s of list) console.log(`# ${s.title}\n  ${s.show}\n  arquivos: ${s.files.join(", ") || "(symlinks)"}\n`);
    console.log("Aplicar: brain integrate --apply   |   Desfazer: brain integrate --remove\nOutros servidores MCP e configurações pessoais são preservados; backup automático em ~/.config/second-brain/backups/.");
    return;
  }
  const dir = join(paths.backups, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  for (const f of new Set(list.flatMap((s) => s.files))) if (existsSync(f)) { cpSync(f, join(dir, f.replace(/^\/+/, "").replace(/\//g, "__"))); }
  console.log(`Backup dos arquivos de configuração: ${dir}`);
  for (const s of list) {
    console.log(`\n# ${s.title}`);
    try { (o.remove ? s.undo : s.run)(); console.log("  ✔ ok"); } catch (e) { console.log(`  ✘ falhou: ${(e as Error).message.split("\n")[0]}`); process.exitCode = 1; }
  }
}

/** Plano do `update-policy`, SOMENTE LEITURA: arquivos do vault que mudariam e o estado do bloco global do Codex depois deles. */
export function policyPlan(vault: string, templates: Array<[string, string | undefined]>): { vault: string[]; codex: "change" | "same" | "not-integrated"; claude: boolean } {
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);
  const changed = templates.filter(([rel, content]) => content !== undefined && read(join(vault, rel)) !== content).map(([rel]) => rel);
  const policy = templates.find(([rel]) => rel === "AGENTS.md")?.[1] ?? read(join(vault, "AGENTS.md")) ?? "";
  const st = integrationStatus();
  const block = new RegExp(`${START}\\n([\\s\\S]*?)\\n${END}`).exec(read(paths.codexMd) ?? "")?.[1];
  return { vault: changed, codex: !st.codex.policy ? "not-integrated" : block === policy.trim() ? "same" : "change", claude: st.claude.policy };
}

export function managedBlock(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = `${START}\n${content.trim()}\n${END}`;
  const next = cur.includes(START) ? cur.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block) : `${cur.trimEnd()}${cur.trim() ? "\n\n" : ""}${block}\n`;
  writeFileSync(file, next);
}
export function removeBlock(file: string) {
  if (!existsSync(file)) return;
  const cur = readFileSync(file, "utf8");
  if (!cur.includes(START)) return;
  const next = cur.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`), "\n").trim();
  if (next) writeFileSync(file, next + "\n"); else rmSync(file);
}
/** Remove o symlink SOMENTE se ele aponta para a skill deste vault (nunca um link alheio). */
export function removeSkillLink(dest: string, skillSrc: string): boolean {
  try { if (lstatSync(dest).isSymbolicLink() && readlinkSync(dest) === skillSrc) { rmSync(dest); return true; } } catch { /* ausente */ }
  return false;
}
function link(src: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true });
  try { lstatSync(dest); if (lstatSync(dest).isSymbolicLink() && readlinkSync(dest) === src) return; throw new Error(`${dest} já existe e não é o link esperado; não sobrescrevi`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  symlinkSync(src, dest, "dir");
}
