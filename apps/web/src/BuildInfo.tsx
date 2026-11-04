import { useEffect, useState } from "react";

const REPO = "https://github.com/heessuh/homegame-poker";

/** Which commit is running. Fetched at runtime from /version so the commit never changes the bundle's own bytes. */
export function BuildInfo() {
  const [commit, setCommit] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch("/version", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { commit?: unknown } | null) => { if (live) setCommit(typeof v?.commit === "string" && /^[0-9a-f]{7,40}$/i.test(v.commit) ? v.commit : null); })
      .catch(() => { if (live) setCommit(null); });
    return () => { live = false; };
  }, []);
  if (commit === undefined) return null;
  return (
    <footer className="buildinfo">
      {commit ? (
        <>Build <a href={`${REPO}/commit/${commit}`} target="_blank" rel="noreferrer"><code>{commit.slice(0, 7)}</code></a></>
      ) : (
        <>Build: unknown</>
      )}
      {" · "}
      <a href={`${REPO}/blob/main/docs/PROVENANCE.md`} target="_blank" rel="noreferrer">Verify this site</a>
    </footer>
  );
}
