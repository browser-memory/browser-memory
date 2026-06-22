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

test("mergeNetwork dedups by method+url and keeps the server's capture", () => {
  const agent = [{ method: "POST", url: "https://x.com/graphql", role: "add-to-cart" }];
  const out = mergeNetwork(captured, agent);
  assert.equal(out.length, 2); // does not duplicate the graphql
  const gql = out.find((e) => e.url.endsWith("/graphql"));
  assert.equal(gql?.role, "add-to-cart"); // agent's annotation preserved
  assert.equal(gql?.source, "cdp+agent"); // marked as seen by both
  assert.equal(gql?.status, 200); // the capture's status is not lost
});

test("mergeNetwork adds requests that only the agent saw", () => {
  const agent = [{ method: "GET", url: "https://x.com/solo-agente" }];
  const out = mergeNetwork(captured, agent);
  assert.equal(out.length, 3);
  const solo = out.find((e) => e.url.endsWith("/solo-agente"));
  assert.equal(solo?.source, "agent");
});

test("mergeNetwork normalizes the network as a JSON string (historical double-encoding)", () => {
  const agentAsString = JSON.stringify([
    { method: "POST", url: "https://x.com/graphql", role: "mutation" },
  ]);
  const out = mergeNetwork(captured, agentAsString);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.url.endsWith("/graphql"))?.role, "mutation");
});

test("mergeNetwork tolerates null/undefined/garbage network", () => {
  assert.equal(mergeNetwork(captured, undefined).length, 2);
  assert.equal(mergeNetwork(captured, null).length, 2);
  assert.equal(mergeNetwork(captured, "no-es-json").length, 2);
});

test("mergeNetwork with no server capture falls back to the agent's snapshot", () => {
  const out = mergeNetwork([], [{ method: "GET", url: "https://x.com/a" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "agent");
});

// --- secret sanitization (enriched xhr/fetch capture) ---

test("sanitizeHeaders redacts credentials and keeps the key, lets the rest through", () => {
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
  // non-secrets intact: these are the ones the endpoint needs in order to respond
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["accept"], "*/*");
  assert.equal(out["apollographql-client-name"], "web");
});

test("scrubBody JSON: redacts sensitive values and preserves the search query", () => {
  const body = JSON.stringify({
    variables: { query: "nike pegasus", first: 10 },
    password: "hunter2",
    auth: { token: "t_secret" },
  });
  const out = JSON.parse(scrubBody(body, "application/json"));
  assert.equal(out.variables.query, "nike pegasus"); // the query is NOT a secret: it is kept
  assert.equal(out.variables.first, 10);
  assert.equal(out.password, "<redacted>");
  assert.equal(out.auth, "<redacted>"); // the 'auth' key redacted entirely
});

test("scrubBody form-urlencoded: redacts password, keeps q", () => {
  const out = scrubBody("q=lemon&password=hunter2&page=2", "application/x-www-form-urlencoded");
  const p = new URLSearchParams(out);
  assert.equal(p.get("q"), "lemon");
  assert.equal(p.get("password"), "<redacted>");
  assert.equal(p.get("page"), "2");
});

test("scrubBody leaves a non-parseable body intact", () => {
  assert.equal(scrubBody("--boundary\r\nbinary", "multipart/form-data"), "--boundary\r\nbinary");
});
