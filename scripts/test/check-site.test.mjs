import test from "node:test";
import assert from "node:assert/strict";
import { assetRefs, crawlSite, evaluate, formatReport, htmlRefs, toSitePath } from "../lib/check-site.mjs";
import { manifestHash, sha256 } from "../lib/manifest.mjs";

const BASE = "https://site.test/";
const enc = (s) => new TextEncoder().encode(s);

// A fake site: path -> text. Records the headers of every request.
function fakeSite(files, seen = []) {
  return async (url, init) => {
    seen.push({ url, headers: init?.headers });
    const p = new URL(url).pathname.replace(/^\//, "") || "index.html";
    if (!(p in files)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = enc(files[p]);
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
}
const hashes = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(enc(v))]));

const SITE = {
  "index.html": '<link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script><a href="https://elsewhere.test/x.js">x</a>',
  "assets/app.css": "body{background:url(/assets/bg.png)}",
  "assets/app.js": 'import("./chunk.js");const f="assets/font.woff2";',
  "assets/chunk.js": "export default 1",
  "assets/bg.png": "PNG",
  "assets/font.woff2": "FONT",
};

test("toSitePath keeps same-origin paths and drops off-site, data and fragment refs", () => {
  assert.equal(toSitePath("/assets/a.js", BASE), "assets/a.js");
  assert.equal(toSitePath("https://site.test/", BASE), "index.html");
  assert.equal(toSitePath("https://other.test/a.js", BASE), null);
  assert.equal(toSitePath("data:text/plain,hi", BASE), null);
  assert.equal(toSitePath("#top", BASE), null);
});

test("htmlRefs and assetRefs find assets, relative imports and url()", () => {
  assert.deepEqual([...htmlRefs(SITE["index.html"], BASE)].sort(), ["assets/app.css", "assets/app.js"]);
  assert.deepEqual([...assetRefs(SITE["assets/app.js"], "assets/app.js", BASE)].sort(), ["assets/chunk.js", "assets/font.woff2"]);
  assert.deepEqual([...assetRefs(SITE["assets/app.css"], "assets/app.css", BASE)], ["assets/bg.png"]);
});

test("crawlSite follows references beyond the manifest and asks for identity encoding", async () => {
  const seen = [];
  const { served, errors, discovered } = await crawlSite({ baseUrl: BASE, manifestPaths: ["assets/app.js"], fetchFn: fakeSite(SITE, seen) });
  assert.deepEqual(Object.keys(served).sort(), Object.keys(SITE).sort());
  assert.deepEqual(errors, {});
  assert.ok(discovered.includes("assets/bg.png"));
  assert.ok(seen.every((r) => r.headers["accept-encoding"] === "identity"));
});

const version = (files, commit = "a".repeat(40)) => ({ commit, builtAt: null, web: { files: hashes(files), manifestHash: manifestHash(hashes(files)) } });
const clean = { head: "a".repeat(40), dirty: false };

async function run(live, local = SITE, v = version(local), git = clean) {
  const crawl = await crawlSite({ baseUrl: BASE, manifestPaths: Object.keys(v.web.files), fetchFn: fakeSite(live) });
  return evaluate({ version: v, local: hashes(local), served: crawl.served, errors: crawl.errors, git });
}

test("identical live site and local build passes", async () => {
  const r = await run(SITE);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.match(formatReport(BASE, r), /RESULT: ✓/);
});

test("a tampered live file is reported by name", async () => {
  const r = await run({ ...SITE, "assets/app.js": SITE["assets/app.js"] + "//evil" });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok && c.text.startsWith("assets/app.js:") && /differ/.test(c.text)));
  assert.match(formatReport(BASE, r), /✗ assets\/app\.js/);
});

test("a file the live site serves that is not in the local build is reported", async () => {
  const live = { ...SITE, "index.html": SITE["index.html"] + '<script src="/assets/extra.js"></script>', "assets/extra.js": "steal()" };
  const r = await run(live);
  assert.ok(r.checks.some((c) => !c.ok && c.text.startsWith("assets/extra.js:") && /does not contain/.test(c.text)));
});

test("a missing file is reported", async () => {
  const live = { ...SITE };
  delete live["assets/bg.png"];
  const r = await run(live);
  assert.ok(r.checks.some((c) => !c.ok && c.text.startsWith("assets/bg.png:") && /404/.test(c.text)));
});

test("wrong commit tells the friend the exact git checkout", async () => {
  const r = await run(SITE, SITE, version(SITE, "b".repeat(40)));
  assert.ok(r.checks[0].text.includes(`git checkout ${"b".repeat(40)}`));
  assert.equal(r.ok, false);
});

test("dirty tree, missing commit and not-a-checkout all fail", async () => {
  assert.equal((await run(SITE, SITE, version(SITE), { ...clean, dirty: true })).ok, false);
  assert.equal((await run(SITE, SITE, version(SITE, null))).ok, false);
  assert.equal((await run(SITE, SITE, version(SITE), null)).ok, false);
});

test("a server whose manifestHash does not match its own file list fails", async () => {
  const v = version(SITE);
  v.web.manifestHash = "0".repeat(64);
  assert.equal((await run(SITE, SITE, v)).ok, false);
});
