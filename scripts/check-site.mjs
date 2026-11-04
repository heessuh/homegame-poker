// Usage: npm run check-site [url] [-- --no-build]
// Confirms the web code served by the live site is byte-for-byte the code in this repository. See docs/PROVENANCE.md.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./lib/manifest.mjs";
import { crawlSite, evaluate, formatReport } from "./lib/check-site.mjs";

const args = process.argv.slice(2);
const url = (args.find((a) => !a.startsWith("--")) ?? "https://mochapoker.fly.dev").replace(/\/+$/, "");
const reuse = args.includes("--no-build");
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = fileURLToPath(new URL("../apps/web/dist", import.meta.url));
const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
const fail = (m) => { console.error(`✗ ${m}`); process.exit(2); };

console.log(`Fetching ${url}/version ...`);
let version;
try {
  const r = await fetch(`${url}/version`, { headers: { "accept-encoding": "identity", "cache-control": "no-cache" } });
  if (!r.ok) fail(`${url}/version answered ${r.status}. Is the address right, and has a version with /version been deployed yet?`);
  version = await r.json();
} catch (e) { fail(`Could not reach ${url}/version (${e.message}).`); }

const head = git("rev-parse", "HEAD");
const gitInfo = head.status === 0 ? { head: head.stdout.trim(), dirty: git("status", "--porcelain").stdout.trim() !== "" } : null;

if (version.commit && gitInfo && gitInfo.head !== version.commit) {
  const result = evaluate({ version, local: {}, served: {}, errors: {}, git: gitInfo });
  console.log("\n" + formatReport(url, { ok: false, checks: result.checks.slice(0, 1) }));
  console.log("\nThen run `npm ci` and `npm run check-site` again.");
  process.exit(1);
}

if (!reuse) {
  console.log("Building apps/web from scratch (run `npm ci` first if you have not) ...");
  rmSync(dist, { recursive: true, force: true });
  const b = spawnSync("npm run build -w @homegame/web", { cwd: root, shell: true, stdio: "inherit" });
  if (b.status !== 0) fail("The local build failed. Run `npm ci` and try again.");
} else if (!existsSync(dist)) fail("--no-build was given but apps/web/dist does not exist.");

const local = buildManifest(dist);
console.log(`Built ${Object.keys(local).length} files. Downloading everything the live site serves ...`);
const crawl = await crawlSite({ baseUrl: url, manifestPaths: Object.keys(version.web?.files ?? {}), fetchFn: fetch });
const result = evaluate({ version, local, served: crawl.served, errors: crawl.errors, git: gitInfo });
console.log("\n" + formatReport(url, result));
process.exit(result.ok ? 0 : 1);
