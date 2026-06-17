# browser-memory

Give your agent a **reusable memory of web actions**. The first time it does
something on a site, it *learns* and saves it as a tool. The next time, it
*replays* that tool deterministically — no exploration, no model in the loop.

🌐 **[browser-memory.com](https://browser-memory.com/)**

## What it does

Ask your agent to do something on a website (e.g. *"search cats on Wikipedia"*):

- **First time** → memory is empty, so the agent explores the site and captures
  the path that worked, distilling it into a reusable tool.
- **Next time** → it finds the saved tool and replays it directly.

Memory is local to your machine and starts empty.

## Add to Claude Code

It needs **two** MCP servers together: `browser-memory` (replays saved tools)
and `@playwright/mcp` (explores while learning). Add both:

```bash
claude mcp add --scope user browser-memory -- npx -y browser-memory
claude mcp add --scope user playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333
```

Then run `/mcp` inside Claude Code to confirm both connect.

> `--scope user` enables them in every project. Nothing to clone or build —
> `npx` downloads and runs on demand. Requires **Node.js >= 20** and a browser
> (uses your system Google Chrome if present, else Playwright's Chromium).

### Or with a `.mcp.json` file

Drop this in your project (works on any host):

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

## Run with npm

```bash
npm i browser-memory
npx browser-memory
```

The server launches the shared Chrome and listens on stdio for any MCP host.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `TOOL_MEMORY_HOME` | `~/.tool-memory` | Where tools, index, traces and the Chrome profile live |
| `TOOL_MEMORY_CDP_PORT` | `9333` | Remote-debugging port of the shared Chrome (must match `@playwright/mcp`'s `--cdp-endpoint`) |
| `TOOL_MEMORY_CHROME_BIN` | system Chrome, else Playwright's Chromium | Chrome binary to launch |
| `TOOL_MEMORY_RESEED` | `1` | Refresh session/auth from your real Chrome on every launch; set `0` to disable |

On first launch the dedicated profile is seeded from your real Chrome's most-used
profile, so you start already logged in. Secrets live in that profile — never in
tools or traces.

## License

MIT
