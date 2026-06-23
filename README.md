<p align="center">
  <a href="https://browser-memory.com">
    <img src="https://browser-memory.com/banner.png" alt="browser-memory" width="640">
  </a>
</p>

<p align="center">
  <a href="https://browser-memory.com"><img src="https://img.shields.io/badge/docs-browser--memory.com-4ade80?style=for-the-badge&labelColor=0a0a0a" alt="Docs"></a>
  <a href="https://www.npmjs.com/package/browser-memory"><img src="https://img.shields.io/npm/v/browser-memory?style=for-the-badge&logo=npm&color=4ade80&labelColor=0a0a0a" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4ade80?style=for-the-badge&labelColor=0a0a0a" alt="License MIT"></a>
</p>

<p align="center">
  <b>Give your AI agent a reusable memory of web actions.</b>
</p>

---

A single, self-contained MCP server (open source, MIT). It runs on your machine, drives its own Chrome, and your memory is yours.

## Install

Requires Node.js ≥ 20 and Chrome (uses your system Google Chrome if present, otherwise Playwright's Chromium).

**One command — configures every supported agent it finds on your machine:**

```bash
npx -y browser-memory install
```

It autodetects **Codex, Cursor, VS Code (Copilot) and Claude Code** and registers the server in each (idempotent — it never overwrites an entry you already have). Restart the app afterwards. Undo any time with `npx -y browser-memory uninstall`.

**Or target one host** — `codex` · `cursor` · `vscode` · `claude`:

```bash
npx -y browser-memory install codex
npx -y browser-memory uninstall codex   # to remove it
```

What it writes per host, and the equivalent if you'd rather use the UI:

| Host | What `install` writes | UI alternative |
|---|---|---|
| **Codex** | `[mcp_servers.browser-memory]` in `~/.codex/config.toml` | App → Settings → MCP servers |
| **Cursor** | `mcpServers` entry in `~/.cursor/mcp.json` | Settings → MCP → *Add new server* |
| **VS Code (Copilot)** | `servers` entry (`"type": "stdio"`) in the user `mcp.json` | Command Palette → *MCP: Add Server* |
| **Claude Code** | delegates to `claude mcp add --scope user …` | `claude mcp add …` · list with `/mcp` |

> **Codex:** the `codex` command only exists if you installed the standalone CLI — the **desktop app doesn't put it on your PATH** (so `codex mcp add` says `command not found`). `install codex` edits the config file directly, so it works for both.
>
> **Claude Code:** we never hand-edit your `~/.claude.json`; `install claude` shells out to Claude's own CLI. If `claude` isn't on your PATH, run the command above yourself.

Replay (`discover`/`run`) works out of the box on any of them. Two Codex-specific notes: the discover → run → request loop travels in the MCP handshake `instructions` — if Codex doesn't follow it, drop the loop into an `AGENTS.md`; and learning a new action (`request` → distill → `save`) expects the host to spawn a background subagent, so outside Claude Code you may need to run the distill step inline.

**Any other MCP host** — drop this into its config (`.mcp.json` and most clients use the `mcpServers` key; VS Code uses `servers`):

```json
{ "mcpServers": { "browser-memory": { "command": "npx", "args": ["-y", "browser-memory"] } } }
```

**Standalone:**

```bash
npm i browser-memory && npx browser-memory
```

## Registry (optional)

On by default — it pulls ready-made tools from the hosted registry (`https://api.browser-memory.com`). Turn it off to run 100% local, or point it at another backend:

```bash
npx browser-memory config server off
npx browser-memory config server on
npx browser-memory config set-url https://api.browser-memory.com
```
