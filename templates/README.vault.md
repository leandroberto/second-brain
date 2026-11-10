# Second Brain vault

Markdown + Git. Open this folder in Obsidian ("Open folder as vault"). Source of truth: `knowledge/**.md`.

- `knowledge/` — notes (frontmatter + Markdown). Filename = `id`, so `[[id]]` links work in Obsidian.
- `.brain/config.yaml` — settings (committed). `.brain/index.db` — derived index (ignored, rebuildable).
- `.brain/proposals/decided/` — audit trail of reviewed proposals (committed). `pending/` is a local queue (ignored).
- `AGENTS.md`, `skills/second-brain/SKILL.md` — agent policy shared by Claude Code, Codex and others.

Edit freely in Obsidian: the app re-indexes changes. Do not store secrets here.
