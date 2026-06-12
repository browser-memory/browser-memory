import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeNetwork,
  sanitizeHeaders,
  scrubBody,
  type NetEntry,
} from "../src/browser/netlog.ts";

const captured: NetEntry[] = [
  { n: 1, method: "GET", url: "https://x.com/a", status: 200, type: "document", source: "cdp" },
  { n: 2, method: "POST", url: "https://x.com/graphql", status: 200, type: "fetch", source: "cdp" },
];

test("mergeNetwork dedupea por method+url y conserva la captura del server", () => {
  const agent = [{ method: "POST", url: "https://x.com/graphql", role: "add-to-cart" }];
  const out = mergeNetwork(captured, agent);
  assert.equal(out.length, 2); // no duplica el graphql
  const gql = out.find((e) => e.url.endsWith("/graphql"));
  assert.equal(gql?.role, "add-to-cart"); // anotación del agente preservada
  assert.equal(gql?.source, "cdp+agent"); // marcado como visto por ambos
  assert.equal(gql?.status, 200); // el status de la captura no se pierde
});

test("mergeNetwork suma requests que solo vio el agente", () => {
  const agent = [{ method: "GET", url: "https://x.com/solo-agente" }];
  const out = mergeNetwork(captured, agent);
  assert.equal(out.length, 3);
  const solo = out.find((e) => e.url.endsWith("/solo-agente"));
  assert.equal(solo?.source, "agent");
});

test("mergeNetwork normaliza el network como string JSON (doble-encoding histórico)", () => {
  const agentAsString = JSON.stringify([
    { method: "POST", url: "https://x.com/graphql", role: "mutation" },
  ]);
  const out = mergeNetwork(captured, agentAsString);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.url.endsWith("/graphql"))?.role, "mutation");
});

test("mergeNetwork tolera network nulo/indefinido/basura", () => {
  assert.equal(mergeNetwork(captured, undefined).length, 2);
  assert.equal(mergeNetwork(captured, null).length, 2);
  assert.equal(mergeNetwork(captured, "no-es-json").length, 2);
});

test("mergeNetwork sin captura del server cae al snapshot del agente", () => {
  const out = mergeNetwork([], [{ method: "GET", url: "https://x.com/a" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "agent");
});

// --- sanitización de secretos (captura enriquecida xhr/fetch) ---

test("sanitizeHeaders redacta credenciales y conserva la key, deja pasar el resto", () => {
  const out = sanitizeHeaders({
    cookie: "SID=abc; HSID=def",
    authorization: "Bearer xyz",
    "x-csrf-token": "tok123",
    "x-api-key": "k_live_secret",
    "content-type": "application/json",
    accept: "*/*",
    "apollographql-client-name": "web",
  });
  assert.equal(out["cookie"], "<redacted>");
  assert.equal(out["authorization"], "<redacted>");
  assert.equal(out["x-csrf-token"], "<redacted>");
  assert.equal(out["x-api-key"], "<redacted>");
  // no-secretos intactos: son los que el endpoint necesita para responder
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["accept"], "*/*");
  assert.equal(out["apollographql-client-name"], "web");
});

test("scrubBody JSON: redacta valores sensibles y preserva la query de búsqueda", () => {
  const body = JSON.stringify({
    variables: { query: "nike pegasus", first: 10 },
    password: "hunter2",
    auth: { token: "t_secret" },
  });
  const out = JSON.parse(scrubBody(body, "application/json"));
  assert.equal(out.variables.query, "nike pegasus"); // la query NO es secreto: se conserva
  assert.equal(out.variables.first, 10);
  assert.equal(out.password, "<redacted>");
  assert.equal(out.auth, "<redacted>"); // clave 'auth' redactada entera
});

test("scrubBody form-urlencoded: redacta password, conserva q", () => {
  const out = scrubBody("q=limon&password=hunter2&page=2", "application/x-www-form-urlencoded");
  const p = new URLSearchParams(out);
  assert.equal(p.get("q"), "limon");
  assert.equal(p.get("password"), "<redacted>");
  assert.equal(p.get("page"), "2");
});

test("scrubBody deja intacto un body no parseable", () => {
  assert.equal(scrubBody("--boundary\r\nbinary", "multipart/form-data"), "--boundary\r\nbinary");
});
