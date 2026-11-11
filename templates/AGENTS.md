# Second Brain — agent policy

Shared, vendor-neutral memory (Markdown + Git) exposed by the `second-brain` MCP server. Claude Code, Codex and any other agent follow the same rules.
Tools: `brain_context`, `brain_search`, `brain_get`, `brain_projects`, `brain_recent`, `brain_similar`, `brain_propose`, `brain_supersede`, `brain_amend`, `brain_link`, `brain_health`.

## Before substantial work
Call `brain_context` with `project` (slug from `brain_projects`; else the repo directory name), `topic` and `task`.
Open a note with `brain_get` only if it changes what you are about to do. Never load the whole base. Ignore `superseded`, `deprecated` and `archived` notes. `brain_context.history` explains how things changed; it is not the current state. Items with `freshness` (planned/uncertain/conflict) are unverified: check the code before relying on them. Items with `temporal` were true on `as_of` and may have changed: re-confirm with the user before any destructive or irreversible action.

## When you learn something durable
Durable = a decision and its reason, a constraint, a preference, a non-obvious lesson, a stable project fact, a reusable pattern, a pointer to a canonical reference.
Not durable = session chatter, temporary debugging state, guesses, anything re-derivable from the code or docs.

1. `brain_similar` first. If something similar exists, propose against it (`intent` + `target_id`) instead of creating a near-duplicate.
2. `brain_propose` (or `brain_supersede` to replace). Whether it is saved depends on the vault policy, described in "Capture" below. You never edit notes directly, never approve someone else's proposal, and `update`, `replace` and `conflict` always wait for a human (UI or `brain admin`). With the default policy (`never`) you cannot approve or link at all. In additive mode the vault saves your additive proposals for you (no `brain_commit` needed), and `brain_link` works unless the vault turned `can_link` off (never `supersedes`: a replacement is always a `brain_supersede` proposal). Fix your own pending proposal with `brain_amend`.
   For facts that can stop being true ("not in production yet", "flag X is off"), add `temporal: { as_of, revalidate_when }` and phrase them safely (dated; never a blanket permission for destructive actions).
3. If a proposal is ignored, do not re-propose it.

## Capture
You find out the vault policy from the `brain_propose` result. If it has an `auto` field, the vault is in additive mode: a new note or a complement was already saved, a duplicate was ignored, and you must not call `brain_commit`. If `auto` is absent, the proposal is pending: wait for human review (do not look for a workaround) and do not re-propose.

In additive mode:
- Save only what is reusable and not obvious. If it can be re-derived from the code or docs, skip it.
- Complement the existing note instead of creating another one (`brain_similar` first, then `intent: "complement"` + `target_id`).
- Never save the progress of a work item (tickets, issues, status, who-is-doing-what). Save the lesson, not the story.
- Keep text dictated by the user as given: procedures, commands and full SQL, in the original order. Do not summarize or reorder it.
- Never save secrets. A password or token becomes `[SENHA OMITIDA]`; keep the rest of the text.
- At the end of the task, say in one line what you saved and where (note ids). Example: `Saved: complemented <id>; created <id>.`
- `update`, `replace` and `conflict` still go to the review queue. Tell the user they are waiting.

## Hard rules
- Never overwrite or delete knowledge silently. Never edit vault files directly — use the tools.
- If the user asks you to approve a pending proposal, do not look for a workaround: prepare them and ask the user to approve in the UI (`brain ui` in a terminal) or with `brain admin approve`.
- If a source document is wrong, prefer fixing the source (with the user's consent) over teaching the brain to compensate.
- Never store secrets (passwords, API keys, tokens, cookies, private keys). Proposals containing them are rejected.
- Never store logs, dumps or copied source code. Prefer references: repository, branch, `file:line`, PR, issue, commit, URL (use `source`).
- Keep notes short and atomic: specific title, the claim, the why.
- If the MCP server is unavailable, continue the task and tell the user.

Procedure and examples: `skills/second-brain/SKILL.md`.
