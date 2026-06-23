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

One command configures every supported agent it finds — **Codex, Cursor, VS Code (Copilot) and Claude Code**:

All detected hosts:

```bash
npx -y browser-memory install
```

Or a single host (`codex` · `cursor` · `vscode` · `claude`):

```bash
npx -y browser-memory install codex
```

Undo (same host forms):

```bash
npx -y browser-memory uninstall
```

It's idempotent (never overwrites an existing entry). Restart the app afterwards.

**Any other MCP host** — drop this into its config (most clients use the `mcpServers` key; VS Code uses `servers`):

```json
{ "mcpServers": { "browser-memory": { "command": "npx", "args": ["-y", "browser-memory"] } } }
```

## Registry (optional)

On by default — it pulls ready-made tools from the hosted registry (`https://api.browser-memory.com`).

Turn it off to run 100% local:

```bash
npx browser-memory config server off
```

Turn it back on:

```bash
npx browser-memory config server on
```

Point it at another backend:

```bash
npx browser-memory config set-url https://api.browser-memory.com
```
