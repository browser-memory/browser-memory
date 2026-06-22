<p align="center">
  <a href="https://browser-memory.com">
    <img src="assets/banner.svg" alt="browser-memory" width="640">
  </a>
</p>

<p align="center">
  <a href="https://browser-memory.com"><img src="https://img.shields.io/badge/docs-browser--memory.com-4ade80?style=for-the-badge&labelColor=0a0a0a" alt="Docs"></a>
  <a href="https://www.npmjs.com/package/browser-memory"><img src="https://img.shields.io/npm/v/browser-memory?style=for-the-badge&logo=npm&color=4ade80&labelColor=0a0a0a" alt="npm version"></a>
  <a href="https://github.com/frisbee-one/browser-memory/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/frisbee-one/browser-memory/ci.yml?style=for-the-badge&label=CI&color=4ade80&labelColor=0a0a0a" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4ade80?style=for-the-badge&labelColor=0a0a0a" alt="License MIT"></a>
  <img src="https://img.shields.io/node/v/browser-memory?style=for-the-badge&color=4ade80&labelColor=0a0a0a" alt="Node">
</p>

<p align="center">
  <b>Give your AI agent a reusable memory of web actions.</b><br>
  Make your browsing agent <b>20× faster</b> with <b>4× fewer tokens</b> — stop re-learning the same page every visit.
</p>

---

The first time your agent does something on a website, it *learns* the steps and
saves them as a tool. Every time after that, it *replays* that tool directly — no
exploring, no model in the loop, same result.

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

