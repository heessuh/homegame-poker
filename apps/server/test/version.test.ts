import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/index.js";
import { buildWebManifest } from "../src/manifest.js";
// @ts-expect-error plain JS module shared with scripts/check-site.mjs
import { webManifest as scriptManifest } from "../../../scripts/lib/manifest.mjs";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("GET /version and byte-exact serving", () => {
  const web = mkdtempSync(join(tmpdir(), "hg-web-"));
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    mkdirSync(join(web, "assets"));
    writeFileSync(join(web, "index.html"), '<!doctype html><script src="/assets/app.js"></script>\n');
    writeFileSync(join(web, "assets", "app.js"), "console.log('hi');\n".repeat(200));
    server = await startServer(0, { dataDir: null, webDir: web, commit: COMMIT, builtAt: "2026-01-02T03:04:05Z" });
  });
  afterAll(async () => { await server.close(); });

  it("reports the commit, build time and a manifest of every served file", async () => {
    const r = await fetch(`http://localhost:${server.port}/version`);
    expect(r.status).toBe(200);
    const v = await r.json();
    expect(v.commit).toBe(COMMIT);
    expect(v.builtAt).toBe("2026-01-02T03:04:05Z");
    expect(Object.keys(v.web.files).sort()).toEqual(["assets/app.js", "index.html"]);
    expect(v.web.files["assets/app.js"]).toBe(sha("console.log('hi');\n".repeat(200)));
    expect(v.web.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the manifest builder used by scripts/check-site", () => {
    expect(buildWebManifest(web)).toEqual(scriptManifest(web));
  });

  it("serves exactly the manifest bytes even when the client asks for gzip", async () => {
    const v = await (await fetch(`http://localhost:${server.port}/version`)).json();
    for (const [path, hash] of Object.entries(v.web.files) as [string, string][]) {
      const r = await fetch(`http://localhost:${server.port}/${path}`, { headers: { "accept-encoding": "gzip, br" } });
      expect(r.headers.get("content-encoding")).toBeNull();
      expect(createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex")).toBe(hash);
    }
  });

  it("commit is null when the build did not say", async () => {
    const s = await startServer(0, { dataDir: null, webDir: web, commit: null });
    try {
      const v = await (await fetch(`http://localhost:${s.port}/version`)).json();
      expect(v.commit).toBeNull();
    } finally { await s.close(); }
  });
});
