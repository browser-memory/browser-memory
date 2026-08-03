#!/usr/bin/env node
/**
 * `npm run bundle` — builds the one-click MCPB bundle (`browser-memory.mcpb`).
 *
 * The bundle is what a host that can't run `npx` installs: a zip with the manifest, the
 * compiled `dist/` and a PRODUCTION-ONLY `node_modules/`, which the host runs with its own
 * Node (`server.type: "node"` in manifest.json). It is therefore ONE artifact for every
 * platform — there is nothing native in it.
 *
 * Two things are deliberate:
 *   - The staged package.json keeps `"type": "module"`. Without it Node reads the ESM
 *     `dist/*.js` as CommonJS and the server dies on the first import.
 *   - Deps are installed with `--ignore-scripts`, which skips Playwright's postinstall
 *     browser download (~150MB). We don't need it: chrome.ts prefers the SYSTEM Chrome
 *     (resolveChromeBinary in src/config.ts). Playwright's bundled chromium fallback is
 *     the price — a machine with no Chrome installed has to install Chrome.
 *
 * The manifest version is stamped from package.json at pack time so the two can't drift.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STAGE = join(ROOT, "build", "bundle");
const OUT = join(ROOT, "browser-memory.mcpb");

const run = (cmd, args, cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

const step = (msg) => console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`);

/**
 * Drops every package that declares an `os`/`cpu` restriction it doesn't satisfy everywhere.
 *
 * We pack on ONE machine but the bundle must run on all of them, and npm resolves optional
 * platform-specific deps against the packing machine: building on macOS pulls in Playwright's
 * optional `fsevents`, a darwin-only .node binary that would ride along to Windows. A package
 * that restricts its platform is optional by construction (npm skips it elsewhere), so removing
 * it is exactly what a Windows or Linux install would have done.
 */
function pruneNonPortable(modules) {
  if (!existsSync(modules)) return;
  for (const name of readdirSync(modules)) {
    const dir = join(modules, name);
    if (name.startsWith("@")) {
      pruneNonPortable(dir); // scope dir: recurse one level
      continue;
    }
    const pkgFile = join(dir, "package.json");
    if (!existsSync(pkgFile)) continue;
    const { os, cpu } = JSON.parse(readFileSync(pkgFile, "utf8"));
    if (Array.isArray(os) || Array.isArray(cpu)) {
      rmSync(dir, { recursive: true, force: true });
      console.log(`  dropped ${name} (os=${os ?? "*"} cpu=${cpu ?? "*"})`);
    }
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

step("compiling (npm run build)");
run("npm", ["run", "build"]);

step(`staging into ${STAGE}`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(join(ROOT, "dist"), join(STAGE, "dist"), { recursive: true });
for (const f of ["README.md", "LICENSE"]) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(STAGE, f));
}

// `npm ci` refuses to run unless package.json and the lockfile agree, so stage the FULL
// package.json (minus scripts, so no lifecycle hook fires) and let --omit=dev do the pruning.
const { scripts: _drop, ...forInstall } = pkg;
writeFileSync(join(STAGE, "package.json"), JSON.stringify(forInstall, null, 2));
cpSync(join(ROOT, "package-lock.json"), join(STAGE, "package-lock.json"));

step("installing production dependencies");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], STAGE);

// Now that node_modules is in place, ship a package.json with nothing but what the runtime
// needs. `type: module` is load-bearing; the lockfile is not shipped.
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      type: pkg.type,
      main: pkg.main,
      license: pkg.license,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ) + "\n",
);
rmSync(join(STAGE, "package-lock.json"), { force: true });

step("pruning platform-locked packages");
pruneNonPortable(join(STAGE, "node_modules"));

step("stamping the manifest");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
run("npx", ["mcpb", "validate", join(STAGE, "manifest.json")]);

step("packing");
rmSync(OUT, { force: true });
run("npx", ["mcpb", "pack", STAGE, OUT]);

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`\n\x1b[32m✓ ${OUT} — ${mb} MB (v${pkg.version})\x1b[0m`);
console.log(`  verify:  npm run bundle:verify`);
console.log(`  sign:    npx mcpb sign ${OUT} --self-signed`);
