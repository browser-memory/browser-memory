import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Aislamos la memoria a un dir temporal ANTES de importar los módulos que leen config.
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-discover-"));

const { saveTool } = await import("../src/memory/store.ts");
const { discover, listSites, mergeSites, forgetSite } = await import(
  "../src/memory/discover.ts"
);

const wikiTool = {
  name: "wikipedia-search",
  site: "es.wikipedia.org",
  intent: "buscar articulos en wikipedia por texto",
  keywords: ["wikipedia", "buscar", "search", "wiki"],
  type: "primitive",
  side_effect: "read",
  requires: { params: { q: "string" }, env: {} },
  recipe: {
    kind: "playwright",
    steps: [{ action: "navigate", url: "https://es.wikipedia.org?q={{q}}" }],
  },
  success_assertion: { type: "dom", expr: ".result" },
};

saveTool(wikiTool);

test("discovery matchea el sitio por marca", () => {
  const r = discover(["wikipedia"]);
  assert.equal(r[0]?.name, "wikipedia-search");
  assert.equal(r[0].site, "es.wikipedia.org");
});

test("discovery matchea el sitio por dominio completo", () => {
  const r = discover(["es.wikipedia.org"]);
  assert.equal(r[0]?.name, "wikipedia-search");
  assert.equal(r[0].side_effect, "read");
});

const xTool = {
  name: "x-post",
  site: "x.com",
  intent: "postear un tweet en x",
  keywords: ["x", "twitter", "tweet", "postear"],
  type: "primitive",
  side_effect: "write-irreversible",
  requires: { params: { text: "string" }, env: {} },
  recipe: {
    kind: "playwright",
    steps: [{ action: "navigate", url: "https://x.com/compose/post?text={{text}}" }],
  },
  success_assertion: { type: "dom", expr: ".tweet" },
};

saveTool(xTool);

test("matchea un dominio de una sola letra (x.com) por marca, dominio o www", () => {
  for (const term of ["x", "x.com", "www.x.com", "https://x.com/home"]) {
    const r = discover([term]);
    assert.ok(
      r.some((c) => c.name === "x-post"),
      `esperaba matchear x-post con "${term}"`,
    );
  }
});

test("un sitio desconocido no matchea", () => {
  const r = discover(["aerolineas-argentinas"]);
  assert.equal(r.length, 0);
});

test("lista vacía devuelve vacío", () => {
  assert.equal(discover([]).length, 0);
});

// --- Trae TODAS las tools del/los sitio(s) pedido(s) -----------------------------

const infobaePortada = {
  name: "infobae-portada",
  site: "infobae.com",
  intent: "leer las primeras noticias de la portada",
  keywords: ["noticias", "portada", "primeras", "diario"],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  recipe: {
    kind: "playwright",
    steps: [{ action: "navigate", url: "https://infobae.com" }],
  },
  success_assertion: { type: "dom", expr: "article" },
};

// Login del MISMO sitio: casi sin overlap textual con el goal de "noticias".
const infobaeLogin = {
  name: "infobae-login",
  site: "infobae.com",
  intent: "iniciar sesion",
  keywords: ["login", "ingresar", "sesion"],
  type: "primitive",
  side_effect: "write-reversible",
  requires: { params: { user: "string", pass: "string" }, env: {} },
  recipe: {
    kind: "playwright",
    steps: [
      { action: "navigate", url: "https://infobae.com/login" },
      { action: "fill", selector: "#user", value: "{{user}}" },
      { action: "fill", selector: "#pass", value: "{{pass}}" },
    ],
  },
  success_assertion: { type: "dom", expr: ".avatar" },
};

saveTool(infobaePortada);
saveTool(infobaeLogin);

test("pedir el sitio trae TODAS sus tools, incluida la de login", () => {
  const r = discover(["infobae"]);
  const names = r.map((c) => c.name);
  assert.ok(names.includes("infobae-portada"), "falta la portada");
  assert.ok(names.includes("infobae-login"), "falta el login del sitio");
});

test("NO cuela tools de otro sitio", () => {
  const r = discover(["infobae"]);
  assert.ok(r.every((c) => c.site === "infobae.com"), `coló otro sitio: ${JSON.stringify(r.map((c) => c.site))}`);
});

test("pedir varios sitios trae tools de todos", () => {
  const r = discover(["infobae", "wikipedia"]);
  const sites = new Set(r.map((c) => c.site));
  assert.ok(sites.has("infobae.com"), "faltan tools de infobae");
  assert.ok(sites.has("es.wikipedia.org"), "faltan tools de wikipedia");
});

test("dominio y marca devuelven lo mismo, sin campo score", () => {
  const porDominio = discover(["infobae.com"]);
  const porMarca = discover(["infobae"]);
  assert.deepEqual(
    porDominio.map((c) => c.name).sort(),
    porMarca.map((c) => c.name).sort(),
  );
  assert.ok(porMarca.every((c) => !("score" in c)), "no debería venir score");
});

// --- listSites: agrega la memoria local por sitio -------------------------------

test("listSites agrupa por sitio con el conteo de tools", () => {
  const sites = listSites();
  const infobae = sites.find((s) => s.site === "infobae.com");
  const wiki = sites.find((s) => s.site === "es.wikipedia.org");
  assert.equal(infobae?.count, 2, "infobae tiene portada + login");
  assert.equal(wiki?.count, 1, "wikipedia tiene una sola tool");
});

// --- mergeSites: combina local + remoto deduplicando por sitio ------------------

test("mergeSites marca source y no pisa conteos entre fuentes", () => {
  const merged = mergeSites(
    [
      { site: "infobae.com", count: 2 },
      { site: "wikipedia.org", count: 1 },
    ],
    [
      { site: "https://www.Infobae.com/", count: 5 }, // mismo sitio, sin normalizar
      { site: "airbnb.com", count: 3 },
    ],
  );

  const infobae = merged.find((s) => s.site === "infobae.com");
  assert.equal(infobae?.source, "both", "infobae está en local y remoto");
  assert.deepEqual(infobae?.tools, { local: 2, remote: 5 });

  assert.equal(merged.find((s) => s.site === "wikipedia.org")?.source, "local");
  assert.equal(merged.find((s) => s.site === "airbnb.com")?.source, "remote");

  // Ordenado alfabético.
  assert.deepEqual(
    merged.map((s) => s.site),
    ["airbnb.com", "infobae.com", "wikipedia.org"],
  );
});

// --- forgetSite: borra todas las tools locales de un sitio (al final: es destructivo) ---

test("forgetSite borra TODAS las tools del sitio y no toca otros", () => {
  // Pre: infobae tiene 2 (portada + login), wikipedia tiene 1.
  const res = forgetSite("infobae");
  assert.equal(res.site, "infobae"); // eco normalizado del término pedido, no del dominio matcheado
  assert.deepEqual(res.deleted.sort(), ["infobae-login", "infobae-portada"]);

  // Infobae desaparece; wikipedia sigue intacta.
  assert.equal(discover(["infobae"]).length, 0);
  assert.equal(discover(["wikipedia"]).length, 1);
  assert.ok(!listSites().some((s) => s.site === "infobae.com"));
});

test("forgetSite de un sitio inexistente no borra nada", () => {
  const res = forgetSite("sitio-que-no-existe");
  assert.deepEqual(res.deleted, []);
});
