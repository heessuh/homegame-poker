// Web bundle manifest: the list of every file the server serves from apps/web/dist, with the sha256 of its exact bytes.
// Shared by CI (scripts/web-manifest.mjs) and `npm run check-site`. The server has an equivalent in
// apps/server/src/manifest.ts; a unit test makes sure both produce identical output.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Recursively lists files under dir as forward-slash relative paths, sorted by code point. */
export function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** {path: sha256} for every file under dir, keys sorted. */
export function buildManifest(dir) {
  const files = {};
  for (const rel of listFiles(dir)) files[rel] = sha256(readFileSync(join(dir, rel)));
  return files;
}

/** One hash over the whole manifest: sha256 of "path<TAB>sha256<LF>" lines in sorted path order. */
export function manifestHash(files) {
  const lines = Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${k}\t${files[k]}\n`);
  return sha256(lines.join(""));
}

export function webManifest(dir) {
  const files = buildManifest(dir);
  return { files, manifestHash: manifestHash(files) };
}
