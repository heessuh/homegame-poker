# Is the site running the code in the repo?

This page is for friends who can read the private GitHub repo (heessuh/homegame-poker) and want to be sure that the Mocha Poker page in their browser is built from exactly that code, and that nobody slipped something in on the way.

## What is proven, and what is not

**Proven (you can check it yourself):**

- Every file your browser downloads from the site (the page, the JavaScript, the styles) is byte-for-byte what you get by building the repo at a specific commit. This covers all the code that runs on your device: the card display, the shuffle verifier, the fairness checks the page does for you.
- That commit is shown in the site footer on the front page (“Build 1a2b3c4”, linked to GitHub), and the server reports it at `/version`.
- Live deploys are made by GitHub Actions from a commit on `main`, not from the owner’s laptop. The Actions tab lists every deploy, and each one records the commit and a fingerprint of the web files.

**Not proven:**

- **The server’s own code.** The poker server runs on Fly.io, and nothing lets an outsider look inside it. `/version` says which commit it claims to be built from, and the deploy workflow builds and deploys that commit, but you are trusting Fly.io and the owner for that part. This is why the fairness design (see `FAIRNESS.md`) lets you verify every shuffle yourself from the outside instead of trusting the server.
- **Third-party files.** The page asks Google Fonts for its fonts. Those files come from Google, not from this repo, and are not covered by the check.
- **Your browser, extensions and network.** The check tells you what the site sends, not what a malicious extension or network does afterward.
- **Someone who controls both the site and the check.** `npm run check-site` compares the live site to the repo on your own machine, so a server that served different files only to some visitors could still fool one visitor. Run the check from a few different places if that worries you, and compare the manifest hash with what others see.

## Checking the live site yourself

You need Node 22 (the repo has an `.nvmrc`), git, and a clone of the repo.

```
git clone https://github.com/heessuh/homegame-poker.git
cd homegame-poker
npm ci
npm run check-site
```

The script:

1. Asks `https://mochapoker.fly.dev/version` which commit is live. If your copy is at a different commit, it stops and prints the exact `git checkout <commit>` to run.
2. Builds the web app from scratch on your machine.
3. Downloads every file the live site serves (it starts at the front page, follows every file that page and the scripts refer to, and also fetches everything `/version` lists), asking the server not to compress anything.
4. Compares the SHA-256 fingerprint of each file with your build and prints a plain report:

```
✓ Your files are exactly commit 1a2b3c4, the commit the live site says it was built from.
✓ 3 files downloaded from the live site are byte-for-byte identical to your build.
✓ The overall manifest hash matches (b37974198547…).

RESULT: ✓ The web code this site sends to your browser is exactly the code in the repository at that commit.
```

Any ✗ line names the file and what is wrong (different bytes, a file the site serves that your build does not have, a missing file, the wrong commit). To check a different address, run `npm run check-site https://example.test`. Add `-- --no-build` after the address to reuse an existing build in `apps/web/dist`.

The “manifest hash” is one fingerprint over the whole list of files: SHA-256 of one line per file, `path<TAB>sha256<newline>`, sorted by path. Two people who see the same manifest hash got the same files.

## Reading the deploy history

1. Open the repo on GitHub, then the **Actions** tab, then the **Deploy** workflow.
2. Each run is one deploy. Open a run and read the **Summary**: it shows the commit (linked), the time in UTC, the manifest hash, and who or what triggered it.
3. A run is only green if the tests passed, the deploy finished, and the live site’s `/version` then reported that same commit and the same manifest hash CI had just built.
4. Each run also keeps a `web-manifest-<commit>` artifact with the full list of file fingerprints.

A deploy that does not appear here did not come from CI. If the owner ever has to deploy from the laptop in an emergency (`npm run deploy -- --from-laptop`), the server will not report a commit, the footer will say “Build: unknown”, and `check-site` will say so.

## Why the build matches every time

For your build to match the one in the Docker image, the build has to be reproducible. What keeps it that way:

- **Pinned toolchain.** `package.json` says Node 22, `.nvmrc` says 22, the Dockerfile uses `node:22-slim` pinned by its SHA-256 digest, and `npm ci` installs exactly the versions in `package-lock.json`.
- **Line endings.** `.gitattributes` forces LF in the repo on every operating system, so Windows and Linux checkouts hold the same bytes.
- **Nothing environmental in the bundle.** No dates, absolute paths or commit ids are baked in. The footer fetches the commit from `/version` at runtime instead, so changing the commit never changes the bundle.
- **Proof in CI.** The CI workflow builds the Docker image on GitHub and compares its web files with a plain `npm ci && npm run build`. The deploy workflow compares the live site to the CI build.

## Owner: one-time setup

Fred does these steps once. Nobody else needs to.

1. Create a deploy-only token for the Fly app:

   ```
   fly tokens create deploy -a mochapoker
   ```

2. Store it as a GitHub secret (paste the token when asked):

   ```
   gh secret set FLY_API_TOKEN --repo heessuh/homegame-poker
   ```

3. Merge the provenance branch to `main` and push. The first push triggers the Deploy workflow. You can also start it any time with `gh workflow run deploy.yml` or the “Run workflow” button.
4. Afterward, `npm run deploy` runs the local tests, checks that `main` is clean and pushed, triggers the workflow, waits for it, and runs the QA plan. `npm run deploy -- --from-laptop` is the emergency escape hatch and prints a loud warning.

Optional hardening: in GitHub, protect `main` (require pull requests or at least block force-pushes) so history cannot be rewritten after the fact, and rotate the Fly token if it is ever exposed.
