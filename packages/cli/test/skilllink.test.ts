import { mkdirSync, mkdtempSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeSkillLink } from "../src/integrate.js";

describe("integrate --remove: só remove o link que ele mesmo criou", () => {
  it("preserva symlink alheio no mesmo caminho", () => {
    const d = mkdtempSync(join(tmpdir(), "brain-sk-")); const mine = join(d, "vault-skill"); const other = join(d, "outra-skill");
    mkdirSync(mine); mkdirSync(other);
    const a = join(d, "a"); const b = join(d, "b");
    symlinkSync(mine, a, "dir"); symlinkSync(other, b, "dir");
    expect(removeSkillLink(a, mine)).toBe(true); expect(existsSync(a)).toBe(false);
    expect(removeSkillLink(b, mine)).toBe(false); expect(existsSync(b)).toBe(true);
    expect(removeSkillLink(join(d, "nao-existe"), mine)).toBe(false);
  });
});
