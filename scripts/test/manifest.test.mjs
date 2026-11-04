import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, manifestHash, sha256, webManifest } from "../lib/manifest.mjs";

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "mf-"));
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), "<html></html>");
  writeFileSync(join(d, "assets", "b.js"), "b");
  writeFileSync(join(d, "assets", "a.css"), "a");
  return d;
}

test("manifest lists nested files with forward slashes, sorted, with sha256 of exact bytes", () => {
  const m = buildManifest(fixture());
  assert.deepEqual(Object.keys(m), ["assets/a.css", "assets/b.js", "index.html"]);
  assert.equal(m["assets/a.css"], sha256("a"));
  assert.equal(m["index.html"], sha256("<html></html>"));
});

test("manifestHash is sha256 of sorted path<TAB>hash lines and ignores key order", () => {
  const files = { b: sha256("1"), a: sha256("2") };
  const expected = sha256(`a\t${sha256("2")}\nb\t${sha256("1")}\n`);
  assert.equal(manifestHash(files), expected);
  assert.equal(manifestHash({ a: files.a, b: files.b }), expected);
});

test("one changed byte (even a CRLF) changes the file hash and the manifest hash", () => {
  const d = fixture();
  const before = webManifest(d);
  writeFileSync(join(d, "index.html"), "<html>\r\n</html>");
  const after = webManifest(d);
  assert.notEqual(before.files["index.html"], after.files["index.html"]);
  assert.notEqual(before.manifestHash, after.manifestHash);
  assert.equal(before.files["assets/b.js"], after.files["assets/b.js"]);
});
