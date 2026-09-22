/**
 * Run `test/plugin.mjs` where the Harness packages resolve.
 *
 * ESM resolves a bare import relative to the importing file, not the working
 * directory, so a suite importing `@deepseek-ai/dsh-tools` must physically live
 * inside the Harness checkout. Rather than duplicate the suite there, this
 * copies it in, runs it, and removes the copy — so the repository stays the one
 * source of truth.
 *
 * Usage: node scripts/run-plugin-suite.mjs [--harness <path>]
 *        DSH_HARNESS=/path/to/deepseek-harness npm run test:plugin
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

const argIndex = process.argv.indexOf("--harness");
const harness = argIndex === -1 ? process.env.DSH_HARNESS : process.argv[argIndex + 1];
if (!harness) {
  console.error("usage: node scripts/run-plugin-suite.mjs --harness /path/to/deepseek-harness");
  console.error("   or: DSH_HARNESS=/path/to/deepseek-harness npm run test:plugin");
  process.exit(2);
}
if (!existsSync(join(harness, "packages/core/tools"))) {
  console.error(`${harness} does not look like a DeepSeek Harness checkout (no packages/core/tools)`);
  process.exit(2);
}

// Stage inside the harness ROOT: a package manager's node_modules resolution
// walks up from the importing file, so a nested staging directory cannot see
// the harness's own linked packages.
const suite = join(harness, ".rakazo-suite.mjs");
const pluginCopy = join(harness, ".rakazo-suite-plugin");
try {
  rmSync(suite, { force: true });
  rmSync(pluginCopy, { recursive: true, force: true });
  cpSync(join(repo, "plugin"), pluginCopy, { recursive: true });
  cpSync(join(repo, ".env"), join(pluginCopy, ".env"), { force: true });
  // The staged copy imports the copied plugin and reads the copied env, since
  // it now lives in the harness root rather than beside its own project files.
  const source = readFileSync(join(repo, "test/plugin.mjs"), "utf8")
    .replace("../plugin/index.js", "./.rakazo-suite-plugin/index.js")
    .replace(
      'process.env.BRIDGE_ENV_FILE ?? fileURLToPath(new URL("../.env", import.meta.url))',
      'join(dirname(fileURLToPath(import.meta.url)), ".rakazo-suite-plugin", ".env")',
    )
    .replace('import { fileURLToPath } from "node:url";', 'import { fileURLToPath } from "node:url";\nimport { dirname, join } from "node:path";');
  writeFileSync(suite, source);
  // Run through the harness's own toolchain: its workspace packages (including
  // vendor/cordis) are linked by pnpm and resolve only under its module graph,
  // so plain `node` cannot import them. tsx is what the harness uses for its
  // own scripts, so it is the honest runner here.
  execFileSync("npx", ["--yes", "pnpm@11.7.0", "exec", "tsx", suite], { cwd: harness, stdio: "inherit" });
} finally {
  rmSync(suite, { force: true });
  rmSync(pluginCopy, { recursive: true, force: true });
}
