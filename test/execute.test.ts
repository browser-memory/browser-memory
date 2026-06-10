import { test } from "node:test";
import assert from "node:assert/strict";

const { injectParams } = await import("../src/runner/execute.ts");

test("injectParams sustituye {{q}} en una URL", () => {
  const out = injectParams("https://x.com/s?q={{q}}&n={{n}}", { q: "gatos", n: 5 });
  assert.equal(out, "https://x.com/s?q=gatos&n=5");
});

test("injectParams tolera espacios dentro de las llaves", () => {
  assert.equal(injectParams("{{ name }}", { name: "ana" }), "ana");
});

test("injectParams lanza si falta un parámetro", () => {
  assert.throws(() => injectParams("{{missing}}", {}), /Falta el par/);
});

test("injectParams deja el texto sin placeholders intacto", () => {
  assert.equal(injectParams("button:has-text('Send')", {}), "button:has-text('Send')");
});

test("injectParams aplica el filtro kebab", () => {
  const out = injectParams("https://ml.com/{{q|kebab}}_OrderId", { q: "Nike  Pegasus" });
  assert.equal(out, "https://ml.com/nike-pegasus_OrderId");
});

test("injectParams aplica encode/lower/upper", () => {
  assert.equal(injectParams("{{q|encode}}", { q: "a b&c" }), "a%20b%26c");
  assert.equal(injectParams("{{q|lower}}", { q: "AbC" }), "abc");
  assert.equal(injectParams("{{q|upper}}", { q: "AbC" }), "ABC");
});

test("injectParams lanza con un filtro desconocido", () => {
  assert.throws(() => injectParams("{{q|nope}}", { q: "x" }), /Filtro desconocido/);
});
