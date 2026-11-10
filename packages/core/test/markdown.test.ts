import { describe, expect, it } from "vitest";
import { extractWikilinks, parseNote, serializeNote, unlink } from "../src/markdown.js";

const raw = `---
id: decision-x
title: Decisão X
type: decision
status: active
created_at: 2026-09-18
updated_at: 2026-10-14
tags: [a, b]
relations:
  supersedes: ["[[decision-old]]"]
custom_obsidian_key: keep-me
---
# Corpo

Veja [[outra-nota|alias]] e [[mais#secao]].
`;

describe("markdown/frontmatter", () => {
  it("faz roundtrip preservando corpo e chaves desconhecidas", () => {
    const { note, issues } = parseNote(raw, "knowledge/decisions/decision-x.md", "2026-01-01T00:00:00Z");
    expect(issues).toEqual([]);
    expect(note.relations.supersedes).toEqual(["decision-old"]);
    expect(note.extra).toEqual({ custom_obsidian_key: "keep-me" });
    const again = parseNote(serializeNote(note), note.path, "x").note;
    expect(again.body).toBe(note.body);
    expect(again.extra).toEqual(note.extra);
    expect(again.relations).toEqual(note.relations);
    expect(serializeNote(note)).toContain('- "[[decision-old]]"');
  });
  it("é leniente com notas sem frontmatter (editadas à mão)", () => {
    const { note, issues } = parseNote("# Minha ideia\n\ntexto", "knowledge/inbox/Minha Ideia.md", "2026-01-01T00:00:00Z");
    expect(note.id).toBe("minha-ideia");
    expect(note.title).toBe("Minha ideia");
    expect(issues).toContain("sem frontmatter");
  });
  it("não lança com YAML inválido", () => {
    const { note, issues } = parseNote("---\nid: [oops\n---\ncorpo", "knowledge/x.md", "2026-01-01T00:00:00Z");
    expect(note.body).toBe("corpo");
    expect(issues.some((i) => i.includes("YAML"))).toBe(true);
  });
  it("extrai wikilinks", () => {
    expect(extractWikilinks("a [[x]] b [[y|z]] [[w#h]]")).toEqual(["x", "y", "w"]);
    expect(extractWikilinks("formato `[[wikilinks]]` e bloco:\n```\n[[nao]]\n```\n[[sim]]")).toEqual(["sim"]); // código não é link
    expect(unlink("[[a|b]]")).toBe("a");
  });
});
