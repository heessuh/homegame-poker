// Runs docs/TEST_PLAN.md with Claude Haiku, then has Sonnet review the report if anything failed.
// Usage: npm run qa   (needs the `claude` CLI, signed in)
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const reports = join(root, "test-reports");
mkdirSync(reports, { recursive: true });
const startedAt = Date.now();

function claude(model, tools, prompt) {
  // No shell: permission rules contain spaces ("Bash(curl -s …)") and must reach the CLI intact.
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const r = spawnSync(exe, ["-p", "--model", model, "--allowedTools", ...tools], {
    cwd: root,
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    timeout: 30 * 60 * 1000,
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function newestReport() {
  const files = readdirSync(reports)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ f, t: statSync(join(reports, f)).mtimeMs }))
    .filter((x) => x.t >= startedAt)
    .sort((a, b) => b.t - a.t);
  return files[0] ? join(reports, files[0].f) : null;
}

console.log("QA: running docs/TEST_PLAN.md with Haiku…");
claude(
  "haiku", // alias for the latest Haiku
  [
    "Read", "Glob", "Grep",
    "Edit(test-reports/**)",
    "Bash(git rev-parse:*)", "Bash(git log:*)", "Bash(date:*)", "Bash(ls:*)",
    "Bash(npm test)", "Bash(npm run test:server)", "Bash(npm run test:games)", "Bash(npm run test:live)",
    "Bash(curl -s https://mochapoker.fly.dev/healthz)",
    "Bash(node apps/server/test/e2e-features.mjs:*)",
  ],
  "Follow docs/TEST_PLAN.md exactly, from step 1 to the report. Obey its “Rules for the agent running this plan”. " +
    "Write the report file in test-reports/ as described, then print its path and Result line.",
);

const report = newestReport();
if (!report) {
  console.error("QA: Haiku did not write a report. Treating this run as NEEDS REVIEW.");
  process.exit(1);
}
const text = readFileSync(report, "utf8");
if (/\*\*Result:\*\*\s*ALL PASS/.test(text)) {
  console.log(`QA: ALL PASS — ${report}`);
  process.exit(0);
}

console.log(`QA: NEEDS REVIEW — asking Sonnet to review ${report}…`);
claude(
  "sonnet", // alias for the latest Sonnet
  [
    "Read", "Glob", "Grep",
    "Edit(test-reports/**)",
    "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
    "Bash(npm test)", "Bash(npm run test:server)", "Bash(npm run test:games)",
  ],
  `A Haiku QA run wrote ${report.replace(root, ".")} with Result: NEEDS REVIEW. ` +
    "Read it, the test output files in test-reports/, docs/TEST_PLAN.md and the relevant source. " +
    "Do not edit source code, commit or deploy. Append a '## Review' section to that report: for each failure, " +
    "say whether it is a real bug or a flaky/broken test, the likely cause with file:line, and the recommended fix.",
);
console.log(`QA: review added — ${report}`);
process.exit(1);
