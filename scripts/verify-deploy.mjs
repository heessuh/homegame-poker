// Used by .github/workflows/deploy.yml after `flyctl deploy`: waits for the live /version to report the commit CI just
// deployed, then fails unless the live manifest equals the manifest CI built.
// Usage: node scripts/verify-deploy.mjs <url> <commit> <manifest.json> [--tries 30] [--delay 10]
import { readFileSync } from "node:fs";

const [url, commit, file] = process.argv.slice(2);
const opt = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : d; };
const tries = opt("--tries", 30), delay = opt("--delay", 10);
if (!url || !commit || !file) { console.error("usage: verify-deploy.mjs <url> <commit> <manifest.json>"); process.exit(2); }
const built = JSON.parse(readFileSync(file, "utf8"));

let live = null;
for (let i = 1; i <= tries; i++) {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/version`, { headers: { "cache-control": "no-cache" } });
    if (r.ok) live = await r.json();
  } catch { /* not up yet */ }
  if (live?.commit === commit) break;
  console.log(`Attempt ${i}/${tries}: live commit is ${live?.commit ?? "unreachable"}, waiting for ${commit} ...`);
  await new Promise((r) => setTimeout(r, delay * 1000));
}
if (live?.commit !== commit) { console.error(`FAIL: live site reports commit ${live?.commit ?? "(none)"}, expected ${commit}.`); process.exit(1); }
if (live.web?.manifestHash !== built.manifestHash) { console.error(`FAIL: live manifestHash ${live.web?.manifestHash} differs from the CI build ${built.manifestHash}.`); process.exit(1); }
const a = JSON.stringify(live.web.files), b = JSON.stringify(built.files);
if (a !== b) { console.error("FAIL: live file list differs from the CI build."); process.exit(1); }
console.log(`OK: live site runs ${commit}, manifestHash ${built.manifestHash}.`);
