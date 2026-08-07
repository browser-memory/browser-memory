import { test } from "node:test";
import assert from "node:assert/strict";

const {
  injectParams,
  skipOptionalStep,
  toolOrigin,
  needsBlankReset,
  wantsFocus,
  requiresSession,
  looksLikeSessionRedirect,
  isNavigationRace,
  evaluateFetchReplay,
} = await import("../src/runner/execute.ts");
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

// --- fetch-replay: a navigation that races the evaluate --------------------------

const fetchTool = (extra: Record<string, unknown> = {}) =>
  parseTool({
    ...base,
    ...extra,
    success_assertion: { type: "json", jsonPath: "count" },
    recipe: {
      kind: "fetch-replay",
      origin: "https://www.doordash.com",
      fn: "async () => ({ count: 1 })",
    },
  });

/** Minimal Page double: fails the first N evaluates with `err`, then returns `value`. */
const flakyPage = (failures: number, err: string, value: unknown = { count: 1 }) => {
  const page = {
    calls: 0,
    waited: 0,
    async evaluate() {
      page.calls++;
      if (page.calls <= failures) throw new Error(err);
      return value;
    },
    async waitForLoadState() {
      page.waited++;
    },
  };
  return page;
};

test("isNavigationRace only matches a destroyed execution context", () => {
  assert.equal(
    isNavigationRace(
      new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation"),
    ),
    true,
  );
  assert.equal(isNavigationRace(new Error("Cannot find context with specified id")), true);
  assert.equal(isNavigationRace(new Error("Timeout 30000ms exceeded")), false);
  assert.equal(isNavigationRace(new Error("Target page, context or browser has been closed")), false);
});

test("evaluateFetchReplay retries a read once when a navigation destroyed the context", async () => {
  const page = flakyPage(1, "Execution context was destroyed, most likely because of a navigation");
  const out = await evaluateFetchReplay(fetchTool(), {}, page as never);
  assert.deepEqual(out, { count: 1 });
  assert.equal(page.calls, 2);
  assert.equal(page.waited, 1);
});

test("evaluateFetchReplay retries ONCE, then gives up", async () => {
  const page = flakyPage(2, "Execution context was destroyed, most likely because of a navigation");
  await assert.rejects(() => evaluateFetchReplay(fetchTool(), {}, page as never), /destroyed/);
  assert.equal(page.calls, 2);
});

test("evaluateFetchReplay never retries a write: the effect may already have landed", async () => {
  const page = flakyPage(1, "Execution context was destroyed, most likely because of a navigation");
  await assert.rejects(
    () => evaluateFetchReplay(fetchTool({ side_effect: "write-reversible" }), {}, page as never),
    /destroyed/,
  );
  assert.equal(page.calls, 1);
});

test("evaluateFetchReplay does not retry an ordinary failure", async () => {
  const page = flakyPage(1, "TypeError: fetch failed");
  await assert.rejects(() => evaluateFetchReplay(fetchTool(), {}, page as never), /fetch failed/);
  assert.equal(page.calls, 1);
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

// --- session-failure upgrade -----------------------------------------------------

const cotoLike = (env: Record<string, string>) =>
  playwrightTool(
    [{ action: "navigate", url: "https://www.cotodigital.com.ar/sitios/cdigi/nuevositio" }],
    { site: "cotodigital.com.ar", requires: { params: {}, env } },
  );

test("requiresSession reads the session precondition from requires.env", () => {
  assert.equal(requiresSession(cotoLike({ session: "logged-in Coto Digital session" })), true);
  assert.equal(requiresSession(cotoLike({ auth: "needs login" })), true);
  assert.equal(requiresSession(cotoLike({})), false);
  assert.equal(requiresSession(cotoLike({ store: "a store must be selected" })), false);
});

test("looksLikeSessionRedirect: bounced to another site with a session requirement", () => {
  const tool = cotoLike({ session: "logged-in Coto Digital session" });
  // Coto's logged-out pattern: cotodigital.com.ar redirects to coto.com.ar.
  assert.equal(looksLikeSessionRedirect(tool, {}, "https://www.coto.com.ar/"), true);
});

test("looksLikeSessionRedirect: a login URL counts even on the same site", () => {
  const tool = cotoLike({ session: "logged-in" });
  assert.equal(
    looksLikeSessionRedirect(tool, {}, "https://www.cotodigital.com.ar/login?next=/x"),
    true,
  );
});

test("looksLikeSessionRedirect: staying on the tool's site is NOT a session redirect", () => {
  const tool = cotoLike({ session: "logged-in" });
  assert.equal(
    looksLikeSessionRedirect(tool, {}, "https://www.cotodigital.com.ar/sitios/cdigi"),
    false,
  );
});

test("looksLikeSessionRedirect: a leading www never makes two origins differ", () => {
  // site fallback has no www; the live page does. Same site → no redirect.
  const tool = playwrightTool([{ action: "click", selector: ".x" }], {
    site: "cotodigital.com.ar",
    requires: { params: {}, env: { session: "logged-in" } },
  });
  assert.equal(looksLikeSessionRedirect(tool, {}, "https://www.cotodigital.com.ar/"), false);
});

test("looksLikeSessionRedirect: without a session requirement it never fires", () => {
  const tool = cotoLike({});
  assert.equal(looksLikeSessionRedirect(tool, {}, "https://www.coto.com.ar/"), false);
});
