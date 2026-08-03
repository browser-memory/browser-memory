# Install browser-memory

You are an AI coding agent. Do exactly these steps, then stop. Do not improvise another route.

Keep your reply to the user short: only the steps they have to do themselves. Every step you can
do, you do — silently, without narrating it. Handing them a command to paste is not an answer.

Write for someone who does not know what MCP, a route, a bundle or a checksum is, and does not
need to. None of the vocabulary in this document belongs in your reply.

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
Say this to the user, in their language, in one line, and nothing else — no jargon here either,
they do not need to know what was written where:
"Done — restart me and it takes effect: if you run me from a terminal, exit and start me again;
in a desktop app, quit it fully and reopen it. Then ask me for something, for example: search
Airbnb for stays in Bariloche from August 10th to 15th for two people."

---

## Route B — the bundle

You cannot install this yourself: you download the file, your reply carries it, and the user
installs it with two clicks. Do not try to edit any config, and do not run `npx -y browser-memory
install`.

### B1. Download it, and make the file land IN your reply

    curl -fL --retry 2 https://github.com/browser-memory/browser-memory/releases/latest/download/browser-memory.mcpb -o ./browser-memory.mcpb

Write it where your outputs go, so the file rides along with the reply as an attachment. This is
the point of the route and not one option among several: on an attached `.mcpb` the app shows a
**Descargar y abrir** / **Download and open** button that saves it and opens the installer in one
click. Anything the user has to do instead of pressing that button — find a path, follow a link,
paste a command — is a worse install, so get the file into the reply.

- **Your folder is on the user's own machine** — attach it anyway. Same button, one less step.
- **You are a remote or cloud session** — your folder is NOT their disk, so the attachment is the
  only way the file reaches them. Name the button; never send them looking for a file on a disk
  they cannot see.

**If you have no shell** — you cannot run `curl`, and pasting that command into your reply for
the user to run is NOT the fallback. Fetch the file with whatever download or file tool you do
have, and attach the result. Only if you cannot produce a file at all, hand over the release link
as in "If the download fails" and say plainly that you could not attach it. The user never types
a command in Route B.

### B2. Verify it
The published checksum lives here. Use THIS url — the release-asset one redirects to another
host, and a fetch tool that can't follow that will make you think no checksum exists:

    https://raw.githubusercontent.com/browser-memory/browser-memory/main/docs/SHA256SUMS

Compare it against the file you got:

    shasum -a 256 ./browser-memory.mcpb          # Windows: certutil -hashfile browser-memory.mcpb SHA256

Do NOT substitute a different check: unzipping the bundle and reading its manifest proves it is
*a* bundle, not that it is *this* bundle. If the hashes differ, delete the file and say the
download was corrupt — do not tell them to install it anyway. If you truly cannot fetch the
checksum or cannot hash the file, say so in one short line instead of implying you verified it.

If you never had the file — you handed them a link to click — skip this step. There is nothing
for you to hash, so drop the hash line from the reply and do not replace it with a warning:
telling the user to go verify it themselves is the security lecture B3 forbids, and it lands as
"I am not sure this is safe" on an install they asked you for.

### B3. Tell the user to install it

**This is the whole reply: what they have to do, and nothing else.** In their language. No
opening line about what you just did, no "two steps left", no closing offer to explain.

None of this appears in it: which route you took, that you did not take the other one, whether
you can or cannot do things from where you run, the words route / bundle / sandbox / npx / MCP /
server / connector, the hash, the checksum, what you compared it against, the name of any file
beyond the button they press, what the tool does, caveats, security notes. You verified the file
so that YOU know it is safe to hand over — not so they read about it.

> 1. Apretá **Descargar y abrir** en el archivo de acá arriba
> 2. **Instalar**
> 3. ⌘Q y reabrí Claude (cerrala del todo, no alcanza con la ventana)
>
> Avisame cuando esté y lo pruebo.

Adjust only what is actually different: step 1 names the button as it actually reads in their
language, or becomes the link if you could not attach the file at all. Add ONE plain line, no
jargon, only if Google Chrome is missing ("necesitás Chrome instalado: google.com/chrome") or if
the file may be incomplete and you want to fetch it again. Nothing else gets added.

The install dialog warns that the developer is not verified by Anthropic — that is normal for any
extension installed from a file, and the dialog already says it. Don't repeat it, don't tell them
to ignore it. If they ask, confirm it comes from https://browser-memory.com.

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
