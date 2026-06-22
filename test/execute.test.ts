import { test } from "node:test";
import assert from "node:assert/strict";

const { injectParams, skipOptionalStep } = await import("../src/runner/execute.ts");

test("injectParams substitutes {{q}} in a URL", () => {
  const out = injectParams("https://x.com/s?q={{q}}&n={{n}}", { q: "cats", n: 5 });
  assert.equal(out, "https://x.com/s?q=cats&n=5");
});

test("injectParams tolerates spaces inside the braces", () => {
  assert.equal(injectParams("{{ name }}", { name: "ana" }), "ana");
});

test("injectParams throws if a parameter is missing", () => {
  assert.throws(() => injectParams("{{missing}}", {}), /Missing required par/);
});

test("injectParams leaves text without placeholders intact", () => {
  assert.equal(injectParams("button:has-text('Send')", {}), "button:has-text('Send')");
});

test("injectParams applies the kebab filter", () => {
  const out = injectParams("https://ml.com/{{q|kebab}}_OrderId", { q: "Nike  Pegasus" });
  assert.equal(out, "https://ml.com/nike-pegasus_OrderId");
});

test("injectParams applies encode/lower/upper", () => {
  assert.equal(injectParams("{{q|encode}}", { q: "a b&c" }), "a%20b%26c");
  assert.equal(injectParams("{{q|lower}}", { q: "AbC" }), "abc");
  assert.equal(injectParams("{{q|upper}}", { q: "AbC" }), "ABC");
});

test("injectParams throws with an unknown filter", () => {
  assert.throws(() => injectParams("{{q|nope}}", { q: "x" }), /Unknown filter/);
});

test("skipOptionalStep skips an optional step whose param did not arrive", () => {
  const step = {
    action: "upload" as const,
    selector: "[data-testid=fileInput]",
    value: "{{image}}",
    optional: true,
  };
  assert.equal(skipOptionalStep(step, {}), true);
  assert.equal(skipOptionalStep(step, { image: "/tmp/foto.png" }), false);
});

test("skipOptionalStep never skips a NON-optional step", () => {
  const step = {
    action: "type" as const,
    selector: "[data-testid=tweetTextarea_0]",
    value: "{{text}}",
  };
  // without optional:true, it is not skipped even if the param is missing (injectParams will fail at run time).
  assert.equal(skipOptionalStep(step, {}), false);
});
