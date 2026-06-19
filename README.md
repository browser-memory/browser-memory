# browser-memory

**Give your AI agent a reusable memory of web actions.** The first time it does
something on a website, it *learns* the steps and saves them as a tool. Every
time after that, it *replays* that tool directly — no exploring, no model in the
loop, same result.

Open source (MIT). It runs on your machine and your memory is yours.

## What it does

Ask your agent to do something on a site, e.g. *"search cats on Wikipedia"*:

- **First time** → memory is empty, so the agent explores the page, finds the
  path that works, and distills it into a small reusable tool.
- **Next time** → it finds that saved tool and replays it deterministically —
  fast, cheap, and repeatable.

It's an MCP server, so it plugs into any MCP-compatible agent (Claude Code,
etc.). It drives a real Chrome over the DevTools Protocol, so it reuses your
logged-in sessions instead of asking you to re-authenticate.

## Install

browser-memory needs **two** MCP servers working together:

- `browser-memory` — replays your saved tools.
- `@playwright/mcp` — drives the browser while learning something new.

### Add to Claude Code

```bash
claude mcp add --scope user browser-memory -- npx -y browser-memory
claude mcp add --scope user playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333
```

Run `/mcp` inside Claude Code to confirm both connect.

> `--scope user` enables them in every project. Nothing to clone or build —
> `npx` downloads and runs on demand. Requires **Node.js >= 20** and a browser
> (uses your system Google Chrome if present, otherwise Playwright's Chromium).

### Or with a `.mcp.json` file

Drop this in your project (works with any MCP host):

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

### Run it directly

```bash
npm i browser-memory
npx browser-memory
```

The server launches the shared Chrome and listens on stdio for any MCP host.

## Local or server

You can use browser-memory in two ways — they combine freely:

- **Local (default).** Everything your agent learns is saved on *your* machine
  in `~/.tool-memory` (tools, index, traces, and a dedicated Chrome profile).
  Nothing leaves your computer. Your memory starts empty and grows as you use
  it. Secrets live in the Chrome profile — never in tools or traces.

- **Server (shared registry).** browser-memory can also pull ready-made tools
  from a remote registry, so your agent starts with actions other people
  already figured out instead of learning every site from scratch. It's **off by
  default** (fully local). Turn it on, and optionally point it at any registry —
  yours, a team's, dev/staging:

  ```bash
  npx browser-memory config server on                              # enable the remote registry
  npx browser-memory config set-url https://api.browser-memory.com  # point at the hosted registry (or your own)
  npx browser-memory config server off                             # back to 100% local
  ```

  See [Configuration](#configuration).

In both cases the browser, the replay engine, and your local memory stay on your
machine — the registry only serves tool *definitions*.

