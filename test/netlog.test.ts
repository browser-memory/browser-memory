import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeNetwork, type NetEntry } from "../src/browser/netlog.ts";

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
