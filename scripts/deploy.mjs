// Release: run the tests here, make sure main is pushed, let GitHub Actions deploy it, then run the QA plan.
// Usage: npm run deploy            (add -- --no-qa to skip the Haiku QA run)
//        npm run deploy -- --from-laptop   escape hatch: deploys straight from this machine (NOT recorded by CI)
//
// Deploys are normally made by .github/workflows/deploy.yml so that friends can match the live site to a commit
// (docs/PROVENANCE.md). This script only checks, triggers and waits.
import { spawnSync } from "node:child_process";

const skipQa = process.argv.includes("--no-qa");
const fromLaptop = process.argv.includes("--from-laptop");
const out = (cmd) => spawnSync(cmd, { shell: true, encoding: "utf8" }).stdout?.trim() ?? "";
const sleep = (s) => spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${s * 1000})`]);
const die = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };
const run = (label, cmd) => {
  console.log(`\n=== ${label}: ${cmd}`);
  const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
  if (r.status !== 0) die(`${label} failed — stopping. Nothing after this step ran.`);
};

run("Build", "npm run build");
run("Tests (engine, server, all games)", "npm run test:all");

if (fromLaptop) {
  const bar = "!".repeat(72);
  console.warn(`\n${bar}\n  WARNING: deploying from this laptop, not from GitHub Actions.\n  This deploy will NOT match any CI record, the Actions deploy history will not\n  show it, and friends running \`npm run check-site\` cannot tie it to a commit\n  (the server will report no commit). Use it only for an emergency.\n${bar}\n`);
  run("Deploy (laptop)", "fly deploy --remote-only --ha=false");
} else {
  const branch = out("git rev-parse --abbrev-ref HEAD");
  if (branch !== "main") die(`You are on "${branch}". Deploys come from main: merge and push main first.`);
  if (out("git status --porcelain")) die("The working tree has uncommitted changes. Commit them (or stash them), push main, then run this again.");
  run("Fetch", "git fetch origin main");
  const head = out("git rev-parse HEAD");
  const remote = out("git rev-parse origin/main");
  if (head !== remote) die(`Local main (${head.slice(0, 7)}) is not the same as origin/main (${remote.slice(0, 7)}). Push (or pull) first so CI deploys exactly what you tested.`);
  const since = Date.now() - 10_000;
  run("Trigger the deploy workflow", "gh workflow run deploy.yml --ref main");
  let id = "";
  for (let i = 0; i < 20 && !id; i++) {
    sleep(3); // the new run takes a few seconds to appear
    try {
      const runs = JSON.parse(out("gh run list --workflow deploy.yml --event workflow_dispatch --limit 10 --json databaseId,createdAt,headSha"));
      id = String(runs.find((r) => r.headSha === head && Date.parse(r.createdAt) >= since)?.databaseId ?? "");
    } catch { /* try again */ }
  }
  if (!id) die("Could not find the workflow run that was just triggered. Look in the Actions tab.");
  run(`Wait for deploy run ${id}`, `gh run watch ${id} --exit-status`);
}

if (skipQa) {
  run("Live check", "npm run test:live");
} else {
  run("QA (Haiku runs docs/TEST_PLAN.md)", "npm run qa");
}
console.log(fromLaptop ? "\n✔ Deployed from the laptop (no CI record) and tested." : "\n✔ Deployed by GitHub Actions and tested.");
