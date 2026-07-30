import { test } from "node:test";
import assert from "node:assert/strict";

const { injectParams, skipOptionalStep, toolOrigin, needsBlankReset, wantsFocus } =
  await import("../src/runner/execute.ts");
const { parseTool } = await import("../src/schema/tool.ts");

const base = {
  name: "t",
  site: "s.com",
  intent: "x",
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  success_assertion: { type: "dom", expr: ".r" },
};
const playwrightTool = (steps: unknown[], extra: Record<string, unknown> = {}) =>
  parseTool({ ...base, ...extra, recipe: { kind: "playwright", steps } });

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

// --- worker tab selection --------------------------------------------------------

test("toolOrigin reads the origin from the first navigate, with params injected", () => {
  const tool = playwrightTool(
    [
      { action: "navigate", url: "https://es.wikipedia.org/w/index.php?search={{q}}" },
      { action: "navigate", url: "https://other.com/x" },
    ],
    { requires: { params: { q: "string" }, env: {} } },
  );
  assert.equal(toolOrigin(tool, { q: "san martin" }), "https://es.wikipedia.org");
});

test("toolOrigin falls back to `site` when there is no navigate", () => {
  const tool = playwrightTool([{ action: "click", selector: ".x" }]);
  assert.equal(toolOrigin(tool, {}), "https://s.com");
});

test("toolOrigin falls back to `site` when a param of the first navigate is missing", () => {
  const tool = playwrightTool([{ action: "navigate", url: "https://x.com/{{missing}}" }]);
  assert.equal(toolOrigin(tool, {}), "https://s.com");
});

test("toolOrigin uses the declared origin of a fetch-replay recipe", () => {
  const tool = parseTool({
    ...base,
    recipe: {
      kind: "fetch-replay",
      origin: "https://www.linkedin.com",
      fn: "async () => ({ ok: 1 })",
    },
  });
  assert.equal(toolOrigin(tool, {}), "https://www.linkedin.com");
});

test("needsBlankReset: a recipe that navigates first resets by itself", () => {
  assert.equal(
    needsBlankReset(playwrightTool([{ action: "navigate", url: "https://x.com" }]), {}),
    false,
  );
  // A recipe that starts by clicking must NOT inherit the previous run's page.
  assert.equal(
    needsBlankReset(playwrightTool([{ action: "click", selector: ".x" }]), {}),
    true,
  );
});

test("needsBlankReset never blanks a fetch-replay: reusing the live page is the point", () => {
  const tool = parseTool({
    ...base,
    recipe: {
      kind: "fetch-replay",
      origin: "https://s.com",
      fn: "async () => ({ ok: 1 })",
    },
  });
  assert.equal(needsBlankReset(tool, {}), false);
});

test("needsBlankReset looks past a skipped optional step", () => {
  const tool = playwrightTool(
    [
      { action: "upload", selector: "#f", value: "{{image}}", optional: true },
      { action: "navigate", url: "https://x.com" },
    ],
    { requires: { params: {}, env: {} } },
  );
  assert.equal(needsBlankReset(tool, {}), false, "the upload is skipped, so navigate is first");
  assert.equal(needsBlankReset(tool, { image: "/tmp/a.png" }), true);
});

test("wantsFocus honours both the new marker and the legacy _keep_page", () => {
  assert.equal(wantsFocus({ _focus_page: true }), true);
  assert.equal(wantsFocus({ _keep_page: true }), true);
  assert.equal(wantsFocus({ _keep_page: false }), false);
  assert.equal(wantsFocus({ data: 1 }), false);
  assert.equal(wantsFocus(null), false);
  assert.equal(wantsFocus("x"), false);
});
