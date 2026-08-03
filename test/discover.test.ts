import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the memory to a temp dir BEFORE importing the modules that read config.
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-discover-"));

const { saveTool } = await import("../src/memory/store.ts");
const { discover, matchRemoteSites, listSites, mergeSites, forgetSite } =
  await import("../src/memory/discover.ts");

const wikiTool = {
  name: "wikipedia-search",
  site: "es.wikipedia.org",
  intent: "search wikipedia articles by text",
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

test("discovery matches the site by brand", () => {
  const r = discover(["wikipedia"]);
  assert.equal(r[0]?.name, "wikipedia-search");
  assert.equal(r[0].site, "es.wikipedia.org");
});

test("discovery matches the site by full domain", () => {
  const r = discover(["es.wikipedia.org"]);
  assert.equal(r[0]?.name, "wikipedia-search");
  assert.equal(r[0].side_effect, "read");
});

const xTool = {
  name: "x-post",
  site: "x.com",
  intent: "post a tweet on x",
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

test("matches a single-letter domain (x.com) by brand, domain or www", () => {
  for (const term of ["x", "x.com", "www.x.com", "https://x.com/home"]) {
    const r = discover([term]);
    assert.ok(
      r.some((c) => c.name === "x-post"),
      `expected to match x-post with "${term}"`,
    );
  }
});

test("an unknown site does not match", () => {
  const r = discover(["aerolineas-argentinas"]);
  assert.equal(r.length, 0);
});

// A ccTLD is not a brand. While "mx" counted as a significant token, every .mx site matched
// every other one, so asking about Amazon Mexico also returned Airbnb's and Walmart's tools.
const mxTools = [
  { name: "amazon-mx-probe", site: "amazon.com.mx" },
  { name: "airbnb-mx-probe", site: "airbnb.mx" },
  { name: "walmart-mx-probe", site: "walmart.com.mx" },
  { name: "walmart-us-probe", site: "walmart.com" },
].map((t) => ({
  ...t,
  intent: `probe ${t.name}`,
  keywords: [t.name],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  recipe: { kind: "playwright", steps: [{ action: "navigate", url: `https://${t.site}/` }] },
  success_assertion: { type: "dom", expr: "body" },
}));
for (const t of mxTools) saveTool(t);

test("a shared ccTLD does not bridge unrelated brands", () => {
  const names = discover(["amazon.com.mx"]).map((c) => c.name);
  assert.deepEqual(names, ["amazon-mx-probe"], `.mx leaked into the match: ${names.join(", ")}`);
  assert.ok(!discover(["airbnb.mx"]).some((c) => c.name === "amazon-mx-probe"));
});

test("the ccTLD site is still findable by its own domain and by brand", () => {
  for (const term of ["amazon.com.mx", "www.amazon.com.mx", "https://amazon.com.mx/gp/cart", "amazon"]) {
    assert.ok(
      discover([term]).some((c) => c.name === "amazon-mx-probe"),
      `expected to match amazon-mx-probe with "${term}"`,
    );
  }
});

test("the same brand across countries keeps matching (that's what bridges .com ↔ .mx)", () => {
  const byBrand = discover(["walmart"]).map((c) => c.name).sort();
  assert.deepEqual(byBrand, ["walmart-mx-probe", "walmart-us-probe"]);
  // and asking for the US domain still reaches the MX one, via the brand token
  assert.ok(discover(["walmart.com"]).some((c) => c.name === "walmart-mx-probe"));
});

test("a leading two-letter label is NOT a ccTLD: es.wikipedia.org keeps matching 'es'", () => {
  assert.ok(discover(["es"]).some((c) => c.name === "wikipedia-search"));
  assert.ok(discover(["es.wikipedia.org"]).some((c) => c.name === "wikipedia-search"));
});

// Neither is `gob` a brand. Four unrelated Argentine agencies share it (the central bank,
// the official gazette, the state's procurement portal and the tax agency), so while it
// counted as a significant token, asking about any one of them by domain returned all four
// — and so did a host nobody ever published.
const gobTools = [
  { name: "bcra-probe", site: "bcra.gob.ar" },
  { name: "boletin-probe", site: "boletinoficial.gob.ar" },
  { name: "comprar-probe", site: "comprar.gob.ar" },
  { name: "afip-probe", site: "fe.afip.gob.ar" },
].map((t) => ({
  ...t,
  intent: `probe ${t.name}`,
  keywords: [t.name],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  recipe: { kind: "playwright", steps: [{ action: "navigate", url: `https://${t.site}/` }] },
  success_assertion: { type: "dom", expr: "body" },
}));
for (const t of gobTools) saveTool(t);

test("a shared `gob` does not bridge unrelated agencies", () => {
  assert.deepEqual(discover(["bcra.gob.ar"]).map((c) => c.name), ["bcra-probe"]);
  assert.deepEqual(discover(["comprar.gob.ar"]).map((c) => c.name), ["comprar-probe"]);
  // and an unpublished government host matches nothing instead of everything
  assert.equal(discover(["anses.gob.ar"]).length, 0);
});

test("each agency stays findable by its own brand, domain or subdomain", () => {
  for (const [term, name] of [
    ["bcra", "bcra-probe"],
    ["boletinoficial", "boletin-probe"],
    ["comprar", "comprar-probe"],
    ["afip", "afip-probe"],
    ["fe.afip.gob.ar", "afip-probe"],
    ["https://www.bcra.gob.ar/BCRAyVos/", "bcra-probe"],
  ] as const) {
    assert.ok(
      discover([term]).some((c) => c.name === name),
      `expected to match ${name} with "${term}"`,
    );
  }
});

test("an empty list returns empty", () => {
  assert.equal(discover([]).length, 0);
});

// --- Brings ALL tools for the requested site(s) ----------------------------------

const infobaePortada = {
  name: "infobae-portada",
  site: "infobae.com",
  intent: "read the first news on the front page",
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

// Login for the SAME site: almost no textual overlap with the "noticias" goal.
const infobaeLogin = {
  name: "infobae-login",
  site: "infobae.com",
  intent: "log in",
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

test("asking for the site brings ALL its tools, including the login one", () => {
  const r = discover(["infobae"]);
  const names = r.map((c) => c.name);
  assert.ok(names.includes("infobae-portada"), "missing the front page");
  assert.ok(names.includes("infobae-login"), "missing the site login");
});

test("does NOT leak tools from another site", () => {
  const r = discover(["infobae"]);
  assert.ok(r.every((c) => c.site === "infobae.com"), `leaked another site: ${JSON.stringify(r.map((c) => c.site))}`);
});

test("asking for several sites brings tools from all of them", () => {
  const r = discover(["infobae", "wikipedia"]);
  const sites = new Set(r.map((c) => c.site));
  assert.ok(sites.has("infobae.com"), "missing infobae tools");
  assert.ok(sites.has("es.wikipedia.org"), "missing wikipedia tools");
});

test("domain and brand return the same, with no score field", () => {
  const porDominio = discover(["infobae.com"]);
  const porMarca = discover(["infobae"]);
  assert.deepEqual(
    porDominio.map((c) => c.name).sort(),
    porMarca.map((c) => c.name).sort(),
  );
  assert.ok(porMarca.every((c) => !("score" in c)), "score should not be present");
});

test("the site match is case-insensitive: INFOBAE == infobae", () => {
  const enMayus = discover(["INFOBAE"]);
  const enMinus = discover(["infobae"]);
  assert.deepEqual(
    enMayus.map((c) => c.name).sort(),
    enMinus.map((c) => c.name).sort(),
    "uppercase and lowercase should bring the same tools",
  );
  assert.ok(enMayus.length > 0, "INFOBAE should match");
});

// --- matchRemoteSites: translates the requested term into exact remote sites -----

test("matchRemoteSites resolves token, domain and www to the remote site (x → x.com)", () => {
  const remotos = ["x.com", "linkedin.com", "reddit.com"];
  for (const term of ["x", "x.com", "www.x.com", "X", "https://x.com/home"]) {
    assert.deepEqual(
      matchRemoteSites([term], remotos),
      ["x.com"],
      `expected "${term}" to resolve to x.com`,
    );
  }
});

test("matchRemoteSites returns [] if no remote site matches", () => {
  assert.deepEqual(matchRemoteSites(["airbnb"], ["x.com", "linkedin.com"]), []);
  assert.deepEqual(matchRemoteSites([], ["x.com"]), []);
  assert.deepEqual(matchRemoteSites(["x"], []), []);
});

test("matchRemoteSites dedups and normalizes the remote candidates", () => {
  const out = matchRemoteSites(
    ["wikipedia"],
    ["es.wikipedia.org", "https://es.Wikipedia.org/", "en.wikipedia.org"],
  );
  assert.deepEqual(out.sort(), ["en.wikipedia.org", "es.wikipedia.org"]);
});

// --- listSites: aggregates the local memory by site -----------------------------

test("listSites groups by site with the tool count", () => {
  const sites = listSites();
  const infobae = sites.find((s) => s.site === "infobae.com");
  const wiki = sites.find((s) => s.site === "es.wikipedia.org");
  assert.equal(infobae?.count, 2, "infobae has front page + login");
  assert.equal(wiki?.count, 1, "wikipedia has a single tool");
});

// --- mergeSites: combines local + remote, deduping by site ----------------------

test("mergeSites marks source and does not clobber counts across sources", () => {
  const merged = mergeSites(
    [
      { site: "infobae.com", count: 2 },
      { site: "wikipedia.org", count: 1 },
    ],
    [
      { site: "https://www.Infobae.com/", count: 5 }, // same site, not normalized
      { site: "airbnb.com", count: 3 },
    ],
  );

  const infobae = merged.find((s) => s.site === "infobae.com");
  assert.equal(infobae?.source, "both", "infobae is in local and remote");
  assert.deepEqual(infobae?.tools, { local: 2, remote: 5 });

  assert.equal(merged.find((s) => s.site === "wikipedia.org")?.source, "local");
  assert.equal(merged.find((s) => s.site === "airbnb.com")?.source, "remote");

  // Alphabetically ordered.
  assert.deepEqual(
    merged.map((s) => s.site),
    ["airbnb.com", "infobae.com", "wikipedia.org"],
  );
});

// --- forgetSite: deletes all local tools of a site (last: it is destructive) ----

test("forgetSite deletes ALL tools of the site and does not touch others", () => {
  // Pre: infobae has 2 (front page + login), wikipedia has 1.
  const res = forgetSite("infobae");
  assert.equal(res.site, "infobae"); // normalized echo of the requested term, not of the matched domain
  assert.deepEqual(res.deleted.sort(), ["infobae-login", "infobae-portada"]);

  // Infobae disappears; wikipedia stays intact.
  assert.equal(discover(["infobae"]).length, 0);
  assert.equal(discover(["wikipedia"]).length, 1);
  assert.ok(!listSites().some((s) => s.site === "infobae.com"));
});

test("forgetSite of a nonexistent site deletes nothing", () => {
  const res = forgetSite("nonexistent-site");
  assert.deepEqual(res.deleted, []);
});
