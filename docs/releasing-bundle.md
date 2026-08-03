# Releasing the one-click bundle

`browser-memory.mcpb` is what a host installs when it can't run `npx` — a sandboxed one like
Claude Cowork, or the Claude desktop app. It is Route B of [install.md](install.md).

## Cut a release

```bash
npm version patch                # or edit package.json — bundle.mjs stamps the manifest from it
npm run bundle                   # → browser-memory.mcpb
npm run bundle:verify            # speaks real MCP to the packed bundle; must print "bundle is live"

shasum -a 256 browser-memory.mcpb > SHA256SUMS
gh release create "v$(node -p "require('./package.json').version")" \
  browser-memory.mcpb SHA256SUMS \
  --title "v$(node -p "require('./package.json').version")" --generate-notes
```

`install.md` points at `releases/latest/download/…`, so a new release is picked up with no doc
change. If you ever want prettier URLs, redirect `browser-memory.com/dl/browser-memory.mcpb`
there — `curl -fL` follows it.

## What's in the bundle, and why

- **`server.type: "node"`** — the host supplies the Node runtime. One artifact for macOS and
  Windows, nothing native inside, no Apple notarization.
- **No browser inside.** [scripts/bundle.mjs](../scripts/bundle.mjs) installs deps with
  `--ignore-scripts`, so Playwright never downloads its ~150 MB Chromium: 7.5 MB instead of
  ~160. `resolveChromeBinary` in [src/config.ts](../src/config.ts) prefers the system Google
  Chrome anyway, and `launchSharedChrome` fails with an explicit "install Google Chrome"
  message when there is no browser at all.
- **Version can't drift** — `bundle.mjs` stamps `manifest.json` from `package.json` at pack
  time. The `manifest.json` in the repo is the source of truth for everything else.
- **`"type": "module"` is load-bearing** in the staged package.json. Without it Node reads the
  ESM `dist/*.js` as CommonJS and the server dies on its first import. `bundle:verify` is what
  catches that.
- **Signing** is optional; unsigned installs fine. `npx mcpb sign browser-memory.mcpb
  --self-signed` only changes what the install dialog says about the publisher — the "developer
  not verified by Anthropic" warning stays either way.
- **No auto-update.** `npx -y browser-memory` always runs the latest; a bundle is pinned to the
  version the user installed. A new release means telling bundle users to download again.

## Platform support

| | Route A (`npx`) | Route B (bundle) |
|---|---|---|
| macOS | yes | yes — verified |
| Windows | yes | should work, untested: the bundle is cross-platform, `resolveChromeBinary` has the win32 Chrome paths, and `launchSharedChrome` spawns Chrome directly (the `open`/`lsof` path is macOS-only) |
| Linux | yes | n/a — the desktop app that installs bundles doesn't ship for Linux |
