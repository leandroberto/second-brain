---
name: second-brain
description: Use the shared Second Brain (Markdown+Git memory via the second-brain MCP server) to recall project context, decisions and preferences before substantial work, and to propose durable knowledge afterwards without creating duplicates. Use when starting work on a project, when the user says "lembre/remember", "what did we decide", "salve isso", or when you learn something non-obvious that future sessions should know. Do not use for temporary notes or chat history.
---

# Second Brain

One memory shared by several agents and the human. Markdown files are the source of truth; you only use the MCP tools (same names in every client). You propose; the human decides.

## WHEN TO SEARCH
- Before substantial work on a project, and whenever the user refers to a past decision, preference or "how we do X".
- `brain_context {project, topic, task}` first (small, ranked bundle). Then `brain_get {id}` for a note that matters, `brain_search {query, project?, type?, tags?}` for more.
- Judge relevance: does this note change what I am about to do? If not, drop it. Prefer `active` and recent `updated_at`. Mention the note `id` when you rely on it.
- If notes contradict each other or the code, trust the code, tell the user, and propose a correction.

## WHAT IS DURABLE
Propose only if it will matter in a future session, is not obvious from code/docs, is verified, and fits in a few lines.

| type | use for |
|---|---|
| decision | a choice + why + alternatives rejected (also hard constraints) |
| preference | how the user/project wants things done |
| learning | non-obvious lesson, gotcha, root cause |
| fact | stable project fact (version, limit, endpoint name) |
| pattern | reusable approach or convention |
| reference | pointer to a canonical doc/repo/PR/dashboard |
| concept | definition of a domain term |
| open-question | unresolved issue worth tracking |

## WHAT IS TEMPORARY (do not store)
Debugging state, step-by-step history, guesses, TODOs for this session, test output, anything that will be stale tomorrow.

## WHEN TO PROPOSE
After the work, not during. At most a few high-value notes per task. Skip if the user or a previous review already rejected the same idea.

## HOW TO HANDLE SIMILARITY
Run `brain_similar {title, body, project, type}` and read `classification`:
- `new` → `brain_propose`.
- `duplicate` → do not propose.
- `complement` → `brain_propose` with `intent: "complement"`, `target_id`, body = only the new information.
- `update` → `intent: "update"`, `target_id`, body = the corrected statement (the changed value stands out in review).
- the old note is wrong or obsolete → `brain_supersede {old_id, ...new note}` (old note is preserved as superseded).

## HOW TO HANDLE CONFLICT
Never resolve a `conflict` yourself and never pick a side silently. Propose with the evidence in `reason` (what you observed, where) and let the human decide.

## HOW TO CITE SOURCES
Put provenance in `source`: repository, branch, `path:line`, PR, issue, commit, URL. Link instead of copying code. Write the body as: one-line claim · **Why** · **How to apply**. Mention obvious relations (`depends_on`, `applies_to`, `implements`, `references`, `contradicts`) in the body or `reason`: the reviewer creates them (`brain_link` is off for agents by default). For time-bound facts, pass `temporal: { as_of, revalidate_when }`.

## WHAT NOT TO STORE
Secrets of any kind, logs, dumps, copied source code, personal data not needed for the work, whole documents. `brain_propose` rejects secrets/oversized content (`secret_detected`, `too_large`): remove the offending part — do not try to disguise it.

## Etiquette
One idea per note, specific noun-phrase title. Do not edit vault files; do not retry rejected proposals. If MCP is down, continue the task and tell the user.
