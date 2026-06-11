# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local MCP server (`tool-memory` / package `browser-memory`) that gives an agent a **reusable memory of web actions**: the first time an action is performed on a site it is *learned* and saved as an executable tool; the next time it is *discovered* and *replayed deterministically*, with no model in the loop. Spec stages: E0–E2 (shared Chrome, on-disk memory + discovery, runner) are the MVP; E3 (learn/distiller) and E4 (composites) are also implemented.

Source is TypeScript (ESM, `.js` import specifiers required by `moduleResolution: Bundler`). Comments and user-facing strings are in Spanish — match that when editing.

## Commands

```bash
npm install
npm run build              # tsc + copies src/learn/distill-prompt.md into dist/learn/
npm test                   # all unit tests (no browser)
npm run smoke              # e2e: launches Chrome, discover → run over Wikipedia
npm run smoke:composite    # e2e for the composite runner

# Run a single test file:
node --test --import tsx ./test/execute.test.ts
```

Tests import from `../src/**/*.ts` directly via `tsx` (not from `dist`), so they run without a build. They are pure unit tests and never touch the browser.

## Architecture

### Shared Chrome over CDP (the core trick)
A **single** Chrome instance is launched with a dedicated persistent profile and `--remote-debugging-port` ([src/browser/chrome.ts](src/browser/chrome.ts)). Two clients attach to the *same* browser and see the same tabs/DOM/session:
- `@playwright/mcp` (`--cdp-endpoint`) — used to **explore** while learning.
- `tool-memory` (`connectOverCDP`, [src/browser/connect.ts](src/browser/connect.ts)) — used to **replay** saved recipes.

`tool-memory` owns the Chrome lifecycle: it launches it on startup (idempotent — reuses an already-listening CDP endpoint instead of relaunching, which avoids the profile lock) and only kills it on shutdown if it launched it. Each `run` uses a **fresh page** (`withFreshPage`) so tools are self-contained. Both MCP servers must be registered together — see [.mcp.json](.mcp.json). The runner reuses the system Google Chrome if present (real user profile → manual auth survives), else falls back to Playwright's bundled chromium.

### The four MCP tools ([src/index.ts](src/index.ts))
The intended agent loop is encoded in the server's `instructions` (injected into the model at MCP handshake — it installs the loop without editing the user's CLAUDE.md):
1. `discover(goal)` — natural-language search of the memory index; returns scored candidates with params + side_effect. **Call before opening the browser.**
2. `run(name, params)` — deterministically replays a tool/composite, returns **structured data** (not instructions). Dispatches to the primitive runner or composite runner based on the item's `type`.
3. `request(goal, narration, network)` — call *after* a new web action succeeds. Non-blocking: freezes the trace and returns `pending_distill` + a `suggested_prompt`. **Contract:** the agent must then spawn a background subagent with that prompt to distill the trace and persist tools via `save`. The distiller never touches the browser.
4. `save(tool, verify_with?)` — validates + persists a tool/composite.

### Memory model ([src/schema/tool.ts](src/schema/tool.ts), [src/memory/store.ts](src/memory/store.ts))
On-disk, global (not per-project), in `~/.tool-memory/` (override with `TOOL_MEMORY_HOME`): `tools/<name>.json` + `index.json` (rebuilt from the tool files by `reindex`). Two item types share the tree:
- **Primitive** (`type: "primitive"`): a single web action. Holds a `recipe` (`playwright` steps or a direct `http` call), `requires` (params + env preconditions), an optional `result_extractor` (DOM `fn` or JSON `jsonPath`), and a **mandatory** `success_assertion`. The assertion is the safety net that replaces proactive verification.
- **Composite** (`type: "composite"`, [src/runner/compose.ts](src/runner/compose.ts)): a chain of tools glued by **handles** (stable data like a URL), not live browser state. `out` of one step maps to `in` of later steps; the chain aborts and reports which step failed if a precondition fails. Discovery boosts composites over their paired primitives.

### Runner ([src/runner/execute.ts](src/runner/execute.ts))
Deterministic replay. `injectParams` substitutes `{{param}}` and `{{param|filter}}` placeholders — literal replacement plus a fixed filter set (`kebab`, `lower`, `upper`, `encode`); it never evals arbitrary code. **Keep the `FILTERS` map in sync with `KNOWN_FILTERS` in [src/memory/lint.ts](src/memory/lint.ts).** Failures are classified into three typed modes, each with a remedy:
- `re-auth` — session expired (redirected to login, or HTTP 401/403). Re-login manually; do **not** re-learn.
- `no-aplica` — doesn't apply (no permission / doesn't exist). Report and stop.
- `tool-roto` — selector/API changed. Re-learn from a fresh trace. **Only this mode bumps `health.fail_count`** — env failures must not inflate it.

Note `wait_for` steps are best-effort (a timeout does **not** fail the tool); the `success_assertion` is the real correctness gate.

### Two save-time guards (neither blocks on a write's real effect)
- **Static lint** ([src/memory/lint.ts](src/memory/lint.ts)) runs on every primitive `save`. Catches param-wiring bugs without executing: single-brace `{q}` placeholders, declared-but-unused params, unknown filters, and extractors that reference a param as a free variable instead of reading it from the `params` arg. This is the *only* net for `write-irreversible` tools, which can't be smoke-tested.
- **Smoke-run** (in the `save` handler): only for **read** primitives, and only when `verify_with` is passed. Does a real run with concrete trace params and **rejects + removes** the tool if it returns null/no result.

### Learn / distill ([src/learn/signal.ts](src/learn/signal.ts), [src/memory/traces.ts](src/memory/traces.ts))
`request` persists a frozen trace and returns a self-contained `suggested_prompt` (the contract lives in [src/learn/distill-prompt.md](src/learn/distill-prompt.md), copied into `dist/` by the build). A background subagent consumes the prompt, distills the trace into tools, and saves them.

## Conventions & constraints
- **Secrets are never written to tools or traces** — they live in the persistent Chrome profile or `creds.local.json` (gitignored, never versioned).
- `write-irreversible` tools have **no confirmation gate yet** — every `run` executes for real. Confirm with the user before replaying a write.
- Extractor `fn`s are called as `(document, params)` in the page context and must read inputs from `params.<name>` (lint enforces this); they avoid `eval`/`Function` since many sites' CSP blocks them.
