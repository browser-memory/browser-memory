# Install browser-memory

You are an AI coding agent. Do exactly these steps, then stop. Do not improvise another route.

## 0. Requirements
Google Chrome must already be on this machine. Check it. If it is not installed, STOP and tell
the user to install it from https://google.com/chrome — browser-memory drives its own dedicated
Chrome and cannot run without it.

## 1. Pick your route

**Route B — the bundle** — if ANY of these is true:
- you are Claude Cowork, or you are running inside the Claude desktop app;
- you are sandboxed and cannot write files outside the folder you were given;
- you have no way to register an MCP server yourself.

**Route A — the installer** — otherwise (Claude Code, Cursor, VS Code/Copilot, Codex). Route A
also needs Node.js 20+: run `node -v`, and if Node is missing or older than 20, STOP and tell
the user to install it from https://nodejs.org/en/download — do not try to install it yourself.

If you are unsure, try Route A. If it errors out or reports `unavailable` for every host, do
Route B instead.

---

## Route A — the installer

### A1. Install
    npx -y browser-memory install

That's the whole install. It autodetects every supported agent on this machine (Claude Code,
Cursor, VS Code/Copilot, Codex) and writes the MCP entry in the format each one needs. It is
idempotent: it never overwrites an entry that is already there.

### A2. Only if A1 fails
If — and only if — A1 errors out or reports `unavailable` for your host, add the entry by hand.
Use the section for the agent you are, at USER level (never a project-scoped config), and never
overwrite an existing browser-memory entry. If none of these match you, tell the user and stop.

Claude Code:
    claude mcp add --scope user browser-memory -- npx -y browser-memory

Cursor — ~/.cursor/mcp.json:
    { "mcpServers": { "browser-memory": { "command": "npx", "args": ["-y", "browser-memory"] } } }

VS Code (Copilot) — the user-level mcp.json:
    { "servers": { "browser-memory": { "type": "stdio", "command": "npx", "args": ["-y", "browser-memory"] } } }

Codex — ~/.codex/config.toml:
    [mcp_servers.browser-memory]
    command = "npx"
    args = ["-y", "browser-memory"]

### A3. Finish
Say this to the user, in one line, and nothing else:
"Done — restart me so I pick up the server: if you run me from a terminal, exit and start me
again; in a desktop app, quit it fully and reopen it. Then ask me for something, for example:
search Airbnb for stays in Bariloche from August 10th to 15th for two people."

---

## Route B — the bundle

You cannot install this yourself: you download a file and the user installs it with two clicks.
Do not try to edit any config, and do not try to run `npx -y browser-memory install`.

### B1. Download it into the folder you are working in

    curl -fL --retry 2 https://github.com/browser-memory/browser-memory/releases/latest/download/browser-memory.mcpb -o ./browser-memory.mcpb

The user has to end up with this file on the machine their Claude app runs on. Which is where
it already is, or one extra click, depending on where you run:

- **Your folder is on the user's own machine** — they open it from there.
- **You are a remote or cloud session** — your folder is NOT their disk. Attach the file to your
  reply / present it as a download, so they can save it. Say which button to use rather than
  telling them to look for a file they cannot see.

### B2. Verify it
Run both of these and compare. This is the only check that counts.

    curl -fsSL https://github.com/browser-memory/browser-memory/releases/latest/download/SHA256SUMS
    shasum -a 256 ./browser-memory.mcpb          # Windows: certutil -hashfile browser-memory.mcpb SHA256

The two hashes must match, and you must tell the user the hash you got. Do NOT substitute a
different check: unzipping the bundle and reading its manifest proves it is *a* bundle, not that
it is *this* bundle, and it is not a verification. If the hashes differ, delete the file and say
the download was corrupt — do not tell them to install it anyway. If neither hashing command
exists here, say plainly that you could not verify it instead of implying you did.

### B3. Tell the user to install it
Print this and nothing else, with step 1 matching where the file actually is:

> Listo — `browser-memory.mcpb`, hash verificado ✓
>
> 1. Abrí el archivo — está en tu carpeta *(o: bajalo con el botón de descarga acá arriba)*
> 2. Apretá **Instalar**
> 3. Reiniciá la app por completo — cerrala del todo y volvé a abrirla
>
> Cuando vuelvas decime "listo" y verifico que quedó andando.

The install dialog will warn that the developer is not verified by Anthropic. That is expected
for any extension installed from a file. Do not tell the user to ignore security warnings; just
confirm it comes from https://browser-memory.com if they ask.

### B4. After the restart
When the user says it is done, verify it yourself — do not make them interpret anything:

- Call `list_sites`. If it answers, the server is connected.
- Call `bm_navigate` with `https://example.com`. A Chrome window should open on their screen.
  If it fails saying no browser could be launched, they need Google Chrome installed.
- Then tell them: the first time you use a site that needs a login, log in **by hand** in that
  Chrome window. That session is saved and survives every later run.

### If the download fails
Do not retry in a loop. Hand the link over and let their own browser do it:

> No pude descargarlo desde acá. Bajalo vos de
> https://github.com/browser-memory/browser-memory/releases/latest/download/browser-memory.mcpb,
> hacele doble click, apretá Instalar y reiniciá la app.

---

## Before the restart, in either route
Do NOT try to call the browser-memory tools yet. An MCP server is launched and its tools
negotiated when the host process starts, so it only exists after that restart. Opening a new
chat inside the app that is already running is NOT enough.

## Removing it later
Route A:
    npx -y browser-memory uninstall

Route B: Settings → Extensions → Browser Memory → **Uninstall**.

Either way, restart the host afterwards — an MCP server cannot unload itself from a live
session. Both only touch the host's config: learned tools (~/.tool-memory) and the Chrome
profile are left alone.
