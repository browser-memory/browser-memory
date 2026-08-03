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

## Install

Requires **Node.js ≥ 18** and **Google Chrome** installed.

One command configures every supported agent it finds on the machine — **Codex, Cursor, VS Code (Copilot) and Claude Code**:

```bash
npx -y browser-memory@latest install
```

Then **restart the app**: MCP servers are negotiated when the session starts, so a new chat isn't enough. It's idempotent (never overwrites an existing entry).

To install into a single host, name it (`codex` · `cursor` · `vscode` · `claude`):

```bash
npx -y browser-memory@latest install cursor
```

### Claude desktop app & Cowork

Those run the agent in a sandbox, where `npx … install` can't reach your machine's config. Paste
this instead — the agent fetches the doc, downloads the bundle and tells you the two clicks:

```
Install browser-memory by following https://raw.githubusercontent.com/browser-memory/browser-memory/main/docs/install.md — keep your reply short: only the steps I have to do myself.
```

Or skip the agent: [download the bundle](https://github.com/browser-memory/browser-memory/releases/latest/download/browser-memory.mcpb),
double-click it, install, and restart the app. Same result.

## Update

The entry written above runs `browser-memory@latest`, so new releases are picked up on their own
when the app starts a session. If the server was installed **before v0.1.22** — or ever seems
stuck on an old version — rewrite the entry once:

```bash
npx -y browser-memory@latest update
```

…and restart the app. Takes the same optional host as `install`.

## Disconnect

```bash
npx -y browser-memory@latest uninstall
```

…and restart the app. This is the only way to remove it — an MCP server cannot unload itself from a live session. It takes the same optional host as `install`, and it only touches the host's config: your learned tools (`~/.tool-memory`) and the Chrome profile are left alone.

**Any other MCP host** — drop this into its config (most clients use the `mcpServers` key; VS Code uses `servers`):

```json
{ "mcpServers": { "browser-memory": { "command": "npx", "args": ["-y", "browser-memory@latest"] } } }
```

## Registry (optional)

On by default — it pulls ready-made tools from the hosted registry (`https://api.browser-memory.com`), **anonymously**: no account, no sign-up, no login prompt. If the registry refuses the request, you're told once and everything keeps working with your local tools.

Signing in is optional, and only if the backend asks for a key:

```bash
npx -y browser-memory@latest login
```

(or set `TOOL_MEMORY_REGISTRY_KEY` yourself). The server never starts a login flow on its own.

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
npx browser-memory config set-url https://your-registry.example.com
```

