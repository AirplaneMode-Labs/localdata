# Releasing @airplanemode/localdata (owner-only steps)

Status: 20 Nov 2026 (Sprint 7, D4-05; TD-103, TD-105, TD-120 to TD-123). Nothing here has been done: no npm name is
reserved, no key exists, no environment, variable or secret exists, nothing is tagged and nothing is published. Every
step below is the owner's. Each says why the team cannot do it. The team's own part is finished and is listed at the end
so that it is not on this list.

The package is `@airplanemode/localdata` (npm only: the Rust crate `ldvec` is `publish = false` and ships inside the
package as WebAssembly), version `0.4.0-alpha.1`, published under the dist-tag `alpha` (derived in shell from the
prerelease identifier). The release workflow is `.github/workflows/publish.yml`. It runs only when started by hand
(`workflow_dispatch`) on `main` in `AirplaneMode-Labs/localdata`, and it has six locks, three bindings, provenance and then
the registry, in that order.

## The owner's steps, in order

1. **Review the candidate commit and decide to release.** Read the diff since the last reviewed commit, the CHANGELOG
   entry for `0.4.0-alpha.1`, `docs/release.md` and the benchmark section of the README. The definition of done also has
   a row for the 8 GB Windows laptop benchmark (`npm run bench:vectors`, `npm run bench:documents`, `npm run bench:ann`
   there); it is the owner's. Commit what those runs write (the CSV rows under `docs/benchmarks/`, with the machine named
   in the index there) before any README 8 GB cell is filled: a figure without its committed row is not done. Why not the team: a release is a decision, and the 8 GB laptop is the owner's.

2. **Reserve the npm scope.** Create the npm organisation `airplanemode` (or the scope you choose; then change the name in
   `package.json`, the README and `publish.yml`, all of which say `@airplanemode/localdata`). Why not the team: registry
   accounts and names belong to the owner, and an agent never creates one.

3. **Make the release key, offline.** On the signing machine: `cp-sign keygen --out <KEYDIR>` (it prints only the keyId;
   `key.secret` is mode 0600). `cp-sign` is built from the private `control-plane` repository; the steps to build it and
   the whole custody design are in `control-plane/docs/RELEASING.md` and `docs/key-custody.md` there. This key signs only
   `-release` ids (rule R4) and is separate from any bundle-signing key. Why not the team: no agent handles a real signing
   key, and it must not exist anywhere an agent or a CI job can reach.

4. **Commit the public key.** Put one entry `{ "keyId": "<hex>", "publicKey": "<canonical base64>" }` into
   `docs/release-keys.json` (it is `"keys": []` today) through a commit you review, on `main`. Optionally add a
   CODEOWNERS line so that only you can change that file. `cp-sign keygen` writes `key.pub` as a comment line and an
   `ed25519-public <hex>` line; this prints the canonical base64 `publicKey` from it (the `keyId` is the one `keygen` printed):

   ```sh
   node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split(/\r?\n/).find(s=>s.startsWith("ed25519-public "));const b=l&&Buffer.from(l.split(/\s+/)[1],"hex");if(!b||b.length!==32){console.error("not a cp-sign public key file");process.exit(1)}console.log(b.toString("base64"))' <KEYDIR>/key.pub
   ```

   Why not the team: it is a trust decision and a trust root.

5. **Create the `release` environment** (the owner as required reviewer, a main-only branch policy, admins cannot bypass).
   With your own id from `gh api user --jq .id`:

   ```sh
   gh api -X PUT repos/AirplaneMode-Labs/localdata/environments/release --input - <<'JSON'
   {
     "reviewers": [{ "type": "User", "id": OWNER_USER_ID }],
     "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true },
     "can_admins_bypass": false
   }
   JSON
   gh api -X POST repos/AirplaneMode-Labs/localdata/environments/release/deployment-branch-policies -f name=main -f type=branch
   ```

   Why not the team: nobody on the team creates or changes a repository setting, and the reviewer is you.

6. **Set the release key id** (lock 6): the same hex keyId as in `docs/release-keys.json`:
   `gh variable set RELEASE_KEY_ID --env release --repo AirplaneMode-Labs/localdata --body <keyId>`. It is a variable of the
   `release` environment, never a repository variable (TD-125). The publish job refuses to run unless it equals the single key
   committed at the commit it publishes. Why not the team: it is a setting of the owner's repository, and the key behind it is the
   owner's.

7. **Commit the dated CHANGELOG heading, and fill the README 8 GB cell only with your own figure.** Change
   `## [0.4.0-alpha.1] - 2026-11-20 (untagged)` in `CHANGELOG.md` to `## [0.4.0-alpha.1] - <date>`, the date you tag,
   without `(untagged)`, and replace "not measured on 8 GB" in the README benchmark tables only with your own measured
   figure from the 8 GB laptop (step 1). Review and commit on `main`. Why not the team: the tag commit must equal the run's
   commit, so this has to land before the tag, and only you choose the release date and hold the 8 GB laptop figure; the team
   writes `(untagged)` and "not measured on 8 GB" until then.

8. **Tag the reviewed commit.** `git tag -s v0.4.0-alpha.1 <sha-on-main>` and push the tag. The publish job checks that the
   tag resolves to the commit it runs on (an annotated tag is dereferenced). Optionally add a tag ruleset for `v*` so that
   only you can create one. Why not the team: nobody on the team pushes or tags.

9. **Dispatch the publish workflow once, and leave its publish job waiting.** On `main`, at the tagged commit:
   `gh workflow run publish.yml --repo AirplaneMode-Labs/localdata --ref main`, then
   `gh run list --workflow publish.yml --repo AirplaneMode-Labs/localdata --limit 1`. The build job rebuilds the candidate (the
   tarball, an unsigned `release-manifest.json` for the id `localdata-release`, and `SHA256SUMS`), runs the dry run and uploads
   it for one day as `release-candidate-localdata-<sha>`. The publish job then waits for your approval of the `release`
   environment; do not approve it yet. Steps 9 to 11 must be done within a day, or the candidate expires and you dispatch
   again. No job-level `if:` reads a variable (a job condition cannot see an environment's variables): the publish job reads
   the arming variable in its first step after checkout, so a run that waits unarmed fails closed. Why not the team: nobody on
   the team runs a publish workflow, and this dispatch is the first act that can end in a publish.

10. **Check the candidate before you sign anything, then sign it offline and publish the signed manifest.**

- Where it came from: `gh run view <run-id> --repo AirplaneMode-Labs/localdata --json event,headBranch,headSha,workflowName,conclusion,jobs`
  must show `workflow_dispatch`, `main`, the workflow `publish`, a successful `build` job and the `headSha` you tagged. Read the
  workflow file at that commit. That shows who built it; it does not show that the bytes are what the source produces.
- What it is: download it with `gh run download <run-id> --repo AirplaneMode-Labs/localdata -n release-candidate-localdata-<sha> -D candidate`,
  and rebuild the same commit independently, on a machine you trust: `git -C <localdata clone> checkout <sha>`, then
  `cd <localdata clone> && SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) node scripts/release/rehearse.mjs` (the
  same epoch the workflow uses). Compare the `.tgz` line of `candidate/SHA256SUMS` with the `.tgz` line of
  `<localdata clone>/dist-release/SHA256SUMS`. The other independent build is the artefact
  `REHEARSAL-test-key-NOT-A-RELEASE-localdata-<os>-<sha>` that the push's `release-rehearsal (<os>)` job uploaded for that commit
  (kept three days): its `dist-release/SHA256SUMS` carries the same line. If the digests differ, extract both tarballs
  (`tar -xzf`) and compare them with `diff -r`: the same contents under a different gzip stream (another zlib) is the same
  artefact, and the signature will bind the candidate's bytes; different contents are a reason to stop. Re-hash every file in
  `candidate/` with `shasum -a 256` against `SHA256SUMS`. The rehearsal signs with the published test key, but only
  in its own directory and only to prove refusals; nothing it makes is ever attached to the release.
- Read what you are about to vouch for: `cp-sign canonical candidate/release-manifest.json` (the id is `localdata-release`,
  the publisher exactly `Airplane Mode Labs`, the version is `package.json`'s, no `expiresAt`, one entry per artefact).
- Sign it on the offline machine, never with a test key and never with `--allow-test-key`:
  `cp-sign sign --key <KEYDIR>/key.secret --no-expiry candidate/release-manifest.json --out signed/release-manifest.json`
  (a release manifest carries no `expiresAt`, TD-121; the publish job refuses one that does).
- Verify it twice: `cp-sign verify --pub <KEYDIR>/key.pub --expect-id localdata-release signed/release-manifest.json`, and with
  the repository's own copy of the verifier, in a directory that holds the candidate files and the signed manifest:
  `node scripts/release/release-tool.mjs verify --dir <that directory> --expect-id localdata-release --trust-file docs/release-keys.json`.
- Attach only the signed manifest to a GitHub release for the tag (the asset must be named `release-manifest.json`):
  `gh release create v0.4.0-alpha.1 --repo AirplaneMode-Labs/localdata --verify-tag --prerelease --title "0.4.0-alpha.1" --notes-file <your notes> signed/release-manifest.json`.
  Why not the team: the signature is your vouching, made with the key of step 3 on a machine no agent reaches, and the
  release is a public act. The digest comparison is what makes that vouching informed: `gh run view` shows who built the
  candidate, an independent build shows what it contains.

11. **Create the registry token as an environment secret.** On npmjs.com make a granular access token limited to the
    package `@airplanemode/localdata` (read and write), with an expiry of 7 days or less, and, if the account requires
    two-factor authentication for publishing, the "bypass 2FA" option that automation needs. Store it only in the
    environment, from the prompt so it never reaches a command line or your shell history:
    `gh secret set NPM_TOKEN --env release --repo AirplaneMode-Labs/localdata`. Never as a repository or organisation secret.
    Why not the team: no agent creates a credential. (Moving to npm trusted publishing needs npm 11.5.1 or later, which Node
    22's bundled npm is not; that is decided after the first publish, TD-122, and is not built.)

12. **Arm the workflow just before you approve, then approve the waiting job.** Arm only now, after the dispatch (step 9), the
    candidate check and signing (step 10) and the token (step 11):
    `gh variable set RELEASE_PUBLISH_ARMED --env release --body true --repo AirplaneMode-Labs/localdata`.
    Then open the waiting run of step 9 (`gh run view <run-id> --web`), read what it is about to do, and approve the `release`
    environment. The publish job reads the variable only after your approval, in its first step after checkout. It then
    checks, in order: the arming variable, the key id against `docs/release-keys.json`, your signed manifest from the GitHub
    release against that file (no test key is ever accepted), that the manifest carries no `expiresAt`, that the manifest version
    equals `package.json`'s (a strict SemVer without build metadata) and that its id is `localdata-release`, that the tag
    resolves to this commit, and that the registry does not already hold the version; it then attests the tarball's provenance
    and runs `npm publish "./$TARBALL" --provenance --access public --ignore-scripts --tag alpha` on the exact tarball the
    verified manifest names, which is the one of the same run you signed in step 10. Any failed check stops it before the
    registry is touched. Why not the team: the approval is yours, and nobody on the team runs a publish workflow.

13. **Revoke the npm token and disarm the workflow.** Revoke the npm token at once (npmjs.com, Access Tokens), then:
    `gh secret delete NPM_TOKEN --env release --repo AirplaneMode-Labs/localdata` and
    `gh variable delete RELEASE_PUBLISH_ARMED --env release --repo AirplaneMode-Labs/localdata` (disarm); check the result
    (`npm view @airplanemode/localdata@0.4.0-alpha.1` and an install into an empty directory). Why not the team: they are your
    credentials and your settings.

14. **Finish and post the write-up.** `docs/writeup-0.4.0-alpha.1-draft.md` is a draft, not published; finishing it waits for
    the 8 GB figure. Posting it, and any announcement, is yours (nothing is posted, filed or announced by the team). Why
    not the team: publishing and announcing are the owner's.

## Settings the owner may want (recommended, not required by the workflow)

A tag ruleset for `v*`; branch protection on `main`; secret-scanning push protection; private vulnerability reporting (it is
what `SECURITY.md` points to); CODEOWNERS for `docs/release-keys.json`. Why not the team: repository settings.

## What the team already did, so that it is not on this list

- The vendored release tool (`scripts/release/release-tool.mjs`, runtime's own verifier, sha256 in `scripts/release/VENDORED.json`)
  and every case of the shared release vectors through it (`test/release-vectors.test.ts`).
- The clean-install and test-key rehearsal in CI on Linux, macOS and Windows (job `release-rehearsal (<os>)`,
  `scripts/release/rehearse.mjs`): it installs the packed tarball into a fresh directory, makes asserted calls including an
  HNSW query, signs a `localdata-rehearsal` manifest with the published RFC 8032 TEST 1 key, verifies it with the explicit
  flags, and proves each refusal by exact exit code and first stderr line. The rehearsal artefacts are kept three days and are
  named as rehearsals.
- The publish workflow and its policy test (`test/workflows-release.test.ts`): `workflow_dispatch` only, no `inputs`, no
  `pull_request_target`, `permissions: {}` at the top and per job, `id-token` and `attestations` only on the publish job,
  `NPM_TOKEN` only in the step env of the one publish step, the download from the same run only, the exact tarball path
  (written `"./$TARBALL"`: a bare relative path would be read as a GitHub shorthand), `persist-credentials: false` on every
  checkout, the arming variable read only in the first step after checkout and no variable in any job-level `if:` (TD-125),
  a refusal of a manifest that carries `expiresAt` (TD-121), a strict SemVer check before the version reaches `GITHUB_ENV`,
  and the tag-to-commit binding made by `scripts/release/publish-guard.mjs` with the commit passed as an argument and never
  read from the ref (`test/publish-guard.test.ts`, with a mutation proof for each rule).
- `docs/release-keys.json` exists with `"keys": []`: a verifier trusts nothing until the owner adds the key.
- Nothing in the team's work makes a publish possible: the workflow cannot start from a push, a pull request, a fork or a
  schedule, and no step of it has ever run.
