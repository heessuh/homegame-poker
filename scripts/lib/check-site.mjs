// Logic behind `npm run check-site`: no process or network access of its own (fetch is passed in), so it can be unit-tested.
import { manifestHash, sha256 } from "./manifest.mjs";

/** Normalizes a URL found in a page or script to a manifest-style path ("assets/x.js"), or null if it points off-site. */
export function toSitePath(ref, baseUrl) {
  if (!ref || /^(data:|blob:|mailto:|#)/i.test(ref)) return null;
  let u;
  try { u = new URL(ref, baseUrl); } catch { return null; }
  if (u.origin !== new URL(baseUrl).origin) return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
  p = p.replace(/^\/+/, "");
  return p === "" ? "index.html" : p;
}

/** Same-origin files an HTML page references through src/href attributes. */
export function htmlRefs(html, baseUrl) {
  const out = new Set();
  for (const m of html.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) {
    const p = toSitePath(m[1], baseUrl);
    if (p && p !== "index.html") out.add(p);
  }
  return out;
}

const ASSET_EXT = "js|mjs|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico|json|webmanifest|wasm|mp3|ogg|wav|map";

/** Same-origin files a CSS or JS file mentions: url(...) in CSS, quoted relative or root paths and "assets/..." strings in JS. */
export function assetRefs(text, fromPath, baseUrl) {
  const out = new Set();
  const here = new URL(fromPath, new URL("/", baseUrl)).href;
  const add = (r, base) => {
    const p = toSitePath(r, base);
    if (p && /\.[a-z0-9]{1,8}$/i.test(p)) out.add(p);
  };
  for (const m of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) add(m[1], here);
  const rel = new RegExp(`["'\`]((?:\\.{1,2}/|/)[\\w./@-]+\\.(?:${ASSET_EXT}))["'\`]`, "g");
  for (const m of text.matchAll(rel)) add(m[1], here);
  for (const m of text.matchAll(/["'`](assets\/[\w./-]+\.[a-z0-9]+)["'`]/gi)) add("/" + m[1], baseUrl);
  return out;
}

const TEXTY = /\.(html?|css|m?js)$/i;

/**
 * Downloads index.html, follows every same-origin asset reference (HTML, then CSS/JS), and also fetches everything
 * the /version manifest lists. Returns {served: {path: sha256}, errors: {path: reason}, discovered: [paths found by following references]}.
 */
export async function crawlSite({ baseUrl, manifestPaths, fetchFn }) {
  const base = baseUrl.replace(/\/+$/, "") + "/";
  const served = {};
  const errors = {};
  const queue = ["index.html", ...manifestPaths];
  const seen = new Set(queue);
  const discovered = [];
  while (queue.length) {
    const path = queue.shift();
    let res;
    try {
      res = await fetchFn(new URL(path === "index.html" ? "" : path, base).href, { headers: { "accept-encoding": "identity", "cache-control": "no-cache" } });
    } catch (e) {
      errors[path] = `could not be downloaded (${e.message})`;
      continue;
    }
    if (!res.ok) {
      errors[path] = `the server answered ${res.status}`;
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    served[path] = sha256(bytes);
    if (TEXTY.test(path)) {
      const text = new TextDecoder().decode(bytes);
      const refs = /\.html?$/i.test(path) ? htmlRefs(text, base) : assetRefs(text, path, base);
      for (const r of refs) {
        if (!seen.has(r)) {
          seen.add(r);
          queue.push(r);
          discovered.push(r);
        }
      }
    }
  }
  return { served, errors, discovered };
}

/**
 * Compares everything. Returns {ok, checks: [{ok, text}]}. Inputs:
 *  version: parsed /version JSON; local: {path: sha}; served/errors from crawlSite;
 *  git: {head, dirty} or null if this is not a git checkout.
 */
export function evaluate({ version, local, served, errors, git }) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  const remoteFiles = version.web?.files ?? {};
  const short = (c) => c.slice(0, 7);

  if (!version.commit) add(false, "The server did not say which commit it was built from, so it cannot be tied to the repository.");
  else if (!git) add(false, "This folder is not a git checkout, so I cannot tell whether it matches the live commit.");
  else if (git.head !== version.commit) add(false, `Your files are at ${short(git.head)} but the live site was built from ${short(version.commit)}. Run: git checkout ${version.commit}`);
  else if (git.dirty) add(false, `Your files are at the live commit (${short(version.commit)}) but have uncommitted changes, so the comparison is not meaningful. Run: git stash`);
  else add(true, `Your files are exactly commit ${short(version.commit)}, the commit the live site says it was built from.`);

  if (Object.keys(remoteFiles).length === 0) add(false, "The server's /version lists no web files.");
  else if (version.web?.manifestHash) {
    const ok = manifestHash(remoteFiles) === version.web.manifestHash;
    add(ok, ok ? "The server's file list adds up to the manifest hash it reports." : "The server's file list does not add up to the manifest hash it reports.");
  }

  for (const p of Object.keys(errors).sort()) add(false, `${p}: ${errors[p]}.`);

  const localPaths = Object.keys(local);
  let same = 0;
  for (const p of Object.keys(served).sort()) {
    if (!(p in local)) add(false, `${p}: the live site serves this file but your build does not contain it.`);
    else if (served[p] !== local[p]) add(false, `${p}: the bytes the live site serves differ from your build.`);
    else same++;
    if (p in remoteFiles && remoteFiles[p] !== served[p]) add(false, `${p}: the bytes served do not match what /version claims.`);
  }
  if (same) add(true, `${same} file${same === 1 ? "" : "s"} downloaded from the live site ${same === 1 ? "is" : "are"} byte-for-byte identical to your build.`);

  for (const p of localPaths.sort()) {
    if (!(p in served) && !errors[p]) add(false, `${p}: part of your build, but the live site did not serve it and does not list it.`);
  }
  for (const p of Object.keys(remoteFiles).sort()) {
    if (!(p in local)) add(false, `${p}: listed by the live site's /version but not in your build.`);
  }

  if (version.web?.manifestHash) {
    const localHash = manifestHash(local);
    const ok = localHash === version.web.manifestHash;
    add(ok, ok ? `The overall manifest hash matches (${localHash.slice(0, 12)}…).` : `The overall manifest hash differs: yours is ${localHash.slice(0, 12)}…, the live site's is ${version.web.manifestHash.slice(0, 12)}….`);
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export function formatReport(url, result) {
  const lines = [`Checked ${url}`, ""];
  for (const c of result.checks) lines.push(`${c.ok ? "✓" : "✗"} ${c.text}`);
  lines.push("");
  lines.push(result.ok
    ? "RESULT: ✓ The web code this site sends to your browser is exactly the code in the repository at that commit."
    : "RESULT: ✗ Something does not match. Look at the lines marked ✗. Until they are resolved, this site is not proven to match the repository.");
  return lines.join("\n");
}
