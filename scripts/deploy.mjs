// One-command release: build, test everything locally, deploy to Fly.io, then run the QA plan.
// Usage: npm run deploy            (add -- --no-qa to skip the Haiku QA run)
import { spawnSync } from "node:child_process";

const skipQa = process.argv.includes("--no-qa");
const run = (label, cmd) => {
  console.log(`\n=== ${label}: ${cmd}`);
  const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✖ ${label} failed — stopping. Nothing after this step ran.`);
    process.exit(r.status ?? 1);
  }
};

run("Build", "npm run build");
run("Tests (engine, server, all games)", "npm run test:all");
run("Deploy", "fly deploy --remote-only --ha=false");
if (skipQa) {
  run("Live check", "npm run test:live");
} else {
  run("QA (Haiku runs docs/TEST_PLAN.md)", "npm run qa");
}
console.log("\n✔ Deployed and tested.");
