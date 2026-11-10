import { afterAll, describe, expect, it } from "vitest";
import { projectLinks, projectName } from "../src/projects.js";
import { claude, cleanup, human, tempBrain } from "./helpers.js";

afterAll(() => cleanup());

describe("projectName", () => {
  it("usa o título da visão geral até o primeiro ':' ou travessão", () => {
    expect(projectName("Delivery SaaS: plataforma multi-restaurante de cardápio digital", "delivery-saas")).toBe("Delivery SaaS");
    expect(projectName("ACME Film — filme institucional", "acme-film")).toBe("ACME Film");
    expect(projectName("Promo Watcher", "promo-watcher")).toBe("Promo Watcher");
    expect(projectName("Promo Watcher (demo)", "promo-watcher")).toBe("Promo Watcher");
  });
  it("cai no slug sem título ou com cabeça longa demais", () => {
    expect(projectName(undefined, "x-proj")).toBe("x-proj");
    expect(projectName("Um título muito comprido que não tem separador nenhum e passa de quarenta caracteres", "y")).toBe("y");
  });
});

describe("projectLinks", () => {
  const projects = [
    { id: "promo-watcher", name: "Promo Watcher" },
    { id: "promo-watcher-site", name: "Promo Watcher Site" },
    { id: "geoledger", name: "GeoLedger" },
    { id: "storefront", name: "Auto Storefront" },
  ];
  const note = (id: string, project: string | null, body: string) => ({ id, project, title: id, body });

  it("liga projetos que se citam, com peso = notas distintas e evidência", () => {
    const links = projectLinks([
      note("a", "storefront", "Vitrine sobre a Public Auto API do Geoledger."),
      note("b", "storefront", "Mocks da API do GeoLedger em dev."),
      note("c", "geoledger", "Expõe a Public Auto API usada pelo Auto Storefront."),
      note("d", "geoledger", "Nada sobre outros projetos; cita o GeoLedger mesmo."),
    ], projects);
    expect(links.map((l) => [l.a, l.b, l.weight, l.evidence.map((e) => e.id)])).toEqual([["geoledger", "storefront", 3, ["a", "b", "c"]]]);
    // o porquê de cada ligação: quem cita quem e o trecho
    expect(links[0]!.evidence[0]).toEqual({ id: "a", title: "a", from: "storefront", to: "geoledger", snippet: "Vitrine sobre a Public Auto API do Geoledger." });
    expect(links[0]!.evidence[2]).toMatchObject({ from: "geoledger", to: "storefront", snippet: "Expõe a Public Auto API usada pelo Auto Storefront." });
  });

  it("vale a citação mais longa: 'Promo Watcher Site' cita o site, não o Promo Watcher", () => {
    const links = projectLinks([note("x", "geoledger", "O Promo Watcher Site é estático."), note("y", "geoledger", "O promo-watcher roda numa VM.")], projects);
    expect(links.map((l) => [l.a, l.b, l.weight])).toEqual([["geoledger", "promo-watcher", 1], ["geoledger", "promo-watcher-site", 1]]);
  });

  it("ignora autocitação, notas sem projeto e palavras que só contêm o nome", () => {
    expect(projectLinks([
      note("s", "geoledger", "GeoLedger e geoledger-api"), note("t", null, "Promo Watcher e GeoLedger"), note("u", "promo-watcher", "superGeoLedgerX"),
    ], projects)).toEqual([]);
  });
});

describe("projectLinks: casos da revisão", () => {
  const note = (id: string, project: string | null, title: string, body: string) => ({ id, project, title, body });
  it("o trecho vem da citação que valeu (não da citação mais longa de outro projeto)", () => {
    const links = projectLinks([note("n", "x", "Promo Watcher Site: deploy", "O promo watcher roda numa VM.")], [{ id: "x", name: "X Proj" }, { id: "pw", name: "Promo Watcher" }, { id: "pws", name: "Promo Watcher Site" }]);
    expect(links.find((l) => l.b === "pw" || l.a === "pw")!.evidence[0]!.snippet).toBe("O promo watcher roda numa VM.");
    expect(links.find((l) => l.b === "pws" || l.a === "pws")!.evidence[0]!.snippet).toBe("Promo Watcher Site: deploy");
  });
  it("aliases genéricos (web, api) e ambíguos (dois projetos 'Site') não ligam nada", () => {
    const projects = [{ id: "web", name: "web" }, { id: "a-site", name: "Site" }, { id: "b-site", name: "Site" }, { id: "z", name: "Zeta" }];
    expect(projectLinks([note("n", "z", "t", "A web e a api usam o Site novo.")], projects)).toEqual([]);
  });
  it("frase não termina em 'app.run_watcher' nem em domínio; evidence_ids traz todas as notas", () => {
    const links = projectLinks([note("n", "x", "t", "O app.run_watcher do Promo Watcher fica em acme.com.br. Outra frase.")], [{ id: "x", name: "X Proj" }, { id: "pw", name: "Promo Watcher" }]);
    expect(links[0]!.evidence[0]!.snippet).toBe("O app.run_watcher do Promo Watcher fica em acme.com.br.");
    expect(links[0]!.evidence_ids).toEqual(["n"]);
  });
});

describe("grafo local e sugestões de relação (Brain)", () => {
  it("vizinhança por passos; sugestão vira relação só quando o REVISOR registra; agente não registra", async () => {
    const b = await tempBrain();
    await b.createProject("loja", "Loja: vitrine white label", "Vitrine sobre a API da Plataforma.", human);
    await b.createProject("plataforma", "Plataforma: backend SaaS", "Backend multi-tenant.", human);
    const n = await b.createNote({ title: "Vitrine consome a API pública", type: "decision", project: "loja", body: "A vitrine lê o catálogo pela API pública da Plataforma, nunca direto do banco.", tags: [] }, human);
    await b.createNote({ title: "Mocks em dev", type: "learning", project: "loja", body: "Em dev, mocks substituem a Plataforma.", tags: [] }, human);

    const l1 = await b.localGraph(n.id, 1);
    expect(l1.nodes.map((x) => [x.id, x.depth]).sort()).toEqual([[n.id, 0], ["project-loja", 1], ["project-plataforma", 1]].sort());
    expect(l1.edges.find((e) => e.kind === "mention" && e.src === n.id)?.snippet).toMatch(/API pública da Plataforma/);
    const l2 = await b.localGraph(n.id, 2);
    expect(l2.nodes.some((x) => x.title === "Mocks em dev" && x.depth === 2)).toBe(true);

    const s = await b.relationSuggestions(n.id);
    expect(s).toEqual([expect.objectContaining({ dst: "project-plataforma", type: "references", dst_title: "Plataforma" })]);
    const ov = await b.relationSuggestions("project-loja");
    expect(ov[0]).toMatchObject({ dst: "project-plataforma", type: "related_to" });
    expect((await b.graph()).project_links[0]).toMatchObject({ a: "loja", b: "plataforma", confirmed: undefined });

    await expect(b.link(n.id, "project-plataforma", "references", claude)).rejects.toMatchObject({ code: "forbidden" }); // agente não registra
    await b.link("project-loja", "project-plataforma", "depends_on", human);
    expect((await b.graph()).project_links[0]).toMatchObject({ confirmed: "depends_on" }); // vira "registrada"
    expect(await b.relationSuggestions("project-loja")).toEqual([]);
    await b.link(n.id, "project-plataforma", "references", human);
    expect(await b.relationSuggestions(n.id)).toEqual([]);
  });

  it("nota arquivada ou visão geral arquivada não quebram a vizinhança", async () => {
    const b = await tempBrain();
    await b.createProject("loja", "Loja: vitrine", "Vitrine sobre a Plataforma.", human);
    await b.createProject("plataforma", "Plataforma: backend", "Backend.", human);
    const n = await b.createNote({ title: "Vitrine consome a API", type: "decision", project: "loja", body: "Lê o catálogo da Plataforma.", tags: [] }, human);
    await b.updateNote(n.id, { status: "archived", expected_revision: b.loadNote(n.id).revision }, human);
    expect((await b.localGraph(n.id, 2)).nodes.find((x) => x.id === n.id)?.depth).toBe(0);
    await b.updateNote("project-plataforma", { status: "archived", expected_revision: b.loadNote("project-plataforma").revision }, human);
    const m = await b.createNote({ title: "Mocks em dev", type: "learning", project: "loja", body: "Mocks substituem a Plataforma.", tags: [] }, human);
    const g = await b.localGraph(m.id, 2);
    expect(g.nodes.some((x) => x.id === "project-plataforma")).toBe(false);
  });
});
