import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WebManifest {
  files: Record<string, string>;
  manifestHash: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort(cmp);
}

/** sha256 of every file under dir (the files express.static serves), plus one hash over the list. Same format as scripts/lib/manifest.mjs. */
export function buildWebManifest(dir: string): WebManifest {
  const files: Record<string, string> = {};
  for (const rel of listFiles(dir)) files[rel] = sha256(readFileSync(join(dir, rel)));
  const lines = Object.keys(files).sort(cmp).map((k) => `${k}\t${files[k]}\n`);
  return { files, manifestHash: sha256(lines.join("")) };
}

export const emptyWebManifest = (): WebManifest => ({ files: {}, manifestHash: sha256("") });
