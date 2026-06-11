# browser-memory

A local MCP server that gives an agent a **reusable memory of web actions**: the first
time an action is performed on a site it is *learned* and saved as an executable tool; the
next time it is *discovered* and *replayed deterministically*, with no model in the loop.

## Requirements

- **Node.js >= 20** (ships with `npx` — check with `node -v`).
- An MCP host such as **Claude Code**.
- A browser: the server uses your system **Google Chrome** if present, otherwise it falls
  back to Playwright's bundled Chromium (see [Linux notes](#linux--ubuntu-notes)).

No clone or build needed — `npx` downloads and runs the server on demand.

## Quick start (Claude Code)

The shared-Chrome design needs **two** servers registered together: `browser-memory`
(replays saved recipes) and `@playwright/mcp` (explores while learning). Add both:

```bash
claude mcp add --scope user browser-memory -- npx -y browser-memory
claude mcp add --scope user playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333
```

`--scope user` makes them available in every project. Use `--scope project` instead to add
them only to the current project (writes a committable `.mcp.json`).

Then open Claude Code and run `/mcp` to confirm both connect.

### Alternative: `.mcp.json` by hand

Works on any version/host — just drop this file in your project (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "browser-memory": {
      "command": "npx",
      "args": ["-y", "browser-memory"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9333"]
    }
  }
}
```

## Usage

Just ask your agent to do something on a website — e.g. *"search cats on wikipedia"*.

- **First time:** memory is empty, so the agent explores with Playwright, then captures the
  successful path. A background step distills it into a reusable tool.
- **Next time:** `discover` finds the saved tool and `run` replays it deterministically —
  no exploration, no model in the loop.

Memory is **local to each machine** and starts empty. Tools learned on one computer don't
travel automatically; to move them, copy `~/.tool-memory/tools/`.

## How it works

A single Chrome instance (dedicated profile + `--remote-debugging-port`) is shared over CDP.
Two MCP clients attach to it and see the same state — tabs, DOM and session:

- `@playwright/mcp` (`--cdp-endpoint`) — used to **explore** while learning.
- `browser-memory` (`connectOverCDP`) — used to **replay** saved recipes.

`browser-memory` owns the Chrome lifecycle and launches it on startup; `@playwright/mcp`
attaches to the same endpoint.

## MCP tools

- `discover(goal)` → scored candidates with params and side_effect.
- `run(name, params)` → structured data. Typed errors: `re-auth`, `no-aplica`, `tool-roto`.
- `save(tool)` → validates and persists a tool.
- `request(goal, narration, network)` → freezes a trace and returns a distill prompt so a
  background subagent can turn it into reusable tools.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `TOOL_MEMORY_HOME` | `~/.tool-memory` | Where tools, index, traces and the Chrome profile live |
| `TOOL_MEMORY_CDP_PORT` | `9333` | Remote-debugging port of the shared Chrome (must match the `--cdp-endpoint` passed to `@playwright/mcp`) |
| `TOOL_MEMORY_CHROME_BIN` | system Chrome, else Playwright's Chromium | Chrome binary to launch |

Secrets are never stored in tools or traces — they live in the persistent Chrome profile.

## Linux / Ubuntu notes

If you don't have Google Chrome installed, install Playwright's Chromium and its system
dependencies once:

```bash
npx playwright install chromium
npx playwright install-deps chromium
```

If the server times out on startup, run it by hand to see the real log:

```bash
npx -y browser-memory
# expect: [tool-memory] Chrome compartido lanzado en CDP.
```

To point at a system Chrome explicitly, set `TOOL_MEMORY_CHROME_BIN` (e.g.
`/usr/bin/google-chrome`) in the server's `env` block.

## Development

```bash
npm install
npm run build
npm test               # unit tests (no browser)
npm run smoke          # end-to-end: launches Chrome, discover → run over Wikipedia
```
