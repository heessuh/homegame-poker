// Prints (or writes with --out FILE) the manifest of apps/web/dist as JSON. Used by the deploy workflow.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { webManifest } from "./lib/manifest.mjs";

const dist = fileURLToPath(new URL("../apps/web/dist", import.meta.url));
const json = JSON.stringify(webManifest(dist), null, 2) + "\n";
const i = process.argv.indexOf("--out");
if (i > 0) writeFileSync(process.argv[i + 1], json);
else process.stdout.write(json);
