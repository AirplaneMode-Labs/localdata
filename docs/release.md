# Release status: 0.3.0-alpha.0

Alpha = locally built, untagged `0.3.0-alpha.0` (Sprint 5; the architect dates the CHANGELOG entry at wrap-up). Nobody tags, publishes, reserves a registry name or
changes a GitHub setting from this repository: the owner reviews, pushes and tags. This page is the
definition of done for a release, row by row, with its status today.

| Definition-of-done row                    | Status                                    | Evidence or what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests first                               | Done                                      | Red then green logs: `evidence/sprint-5/D4/red/D4-0x*.log` and the matching `green/D4-0x*.log` (Sprint 4: `evidence/sprint-4/D4/red-D4-01.log` to `red-D4-03.log` and the matching `green-D4-0x.log`) (Rust: `cargo test --locked`; TypeScript: Vitest and Playwright). The README Benchmarks blocks are checked against the CSVs by `test/readme-bench.test.ts` and `test/readme-docs-bench.test.ts`.                                                                                                                                                                                                                                                                       |
| CI green on Linux, macOS and Windows      | Pushed head green; Sprint 5 awaits push   | `.github/workflows/ci.yml` runs fmt, clippy, `cargo test --locked`, `npm run ci` (which builds the WebAssembly first), `pack:check`, the demo build and `npm pack --dry-run` on `ubuntu-latest`, `macos-latest` and `windows-latest`; a `doc` job runs `cargo doc -D warnings`; a Chrome job runs the browser specs; every `npm ci` is `--ignore-scripts`. Pushed 15 Nov 2026 at 39d59a0; CI at that head green on all three OSes. The Sprint 5 changes are awaiting the owner's push and no Sprint 5 CI run has been read: it needs the owner's push. Tests-first evidence Done (red/green logs); local macOS green; CI on three OSes configured, pending the owner's push. |
| Benchmark on an 8 GB laptop in the README | Open, owner                               | The README has the benchmark from an Apple M5 Pro 48 GB and says "not measured on 8 GB". The owner's runbook (`npm run bench:vectors` and `npm run bench:documents` on the 8 GB Windows laptop) is in the repository PLAN.md; every 8 GB cell reads "not measured" until it exists.                                                                                                                                                                                                                                                                                                                                                                                          |
| README limitations section                | Done                                      | Plainly: single writer per namespace, stale readers, no HNSW, no compaction (deleteDocument hides, only clear(ns) removes), no encryption at rest, f32 only, CRC-32C is not tamper-proofing, data unencrypted in the origin, flat-index poisoning, eviction removes the whole origin, WebAssembly memory does not shrink, the IndexedDB fallback as measured, nothing measured on 8 GB.                                                                                                                                                                                                                                                                                      |
| Signed artifacts and manifest             | Open, owner key                           | No release manifest exists. Signing needs the owner's ed25519 key, which nobody else generates or holds. `*.tgz` and `release-manifest*.json` are never committed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| CHANGELOG and semver tag                  | CHANGELOG Done; tag Open, owner           | `CHANGELOG.md` has `## [0.2.0-alpha.0] - 2026-11-14 (untagged)` and the Sprint 5 work under `## [Unreleased]` until the architect dates it `0.3.0-alpha.0`. The owner creates the tag after review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Installable from a clean machine          | Local tarball proven; publish Open, owner | `npm run pack:check`: `npm pack`, offline install into a fresh empty directory from an empty cache, then a key-value round trip, `putVectors` of three rows with a `query`, and a document put, `queryChunks`, `deleteDocument` and a per-document `clear` run from the installed copy (log: `evidence/sprint-5/D4/green/D4-05-pack-check.log`; Sprint 4: `evidence/sprint-4/D4/pack/`). No registry has the package: the npm scope `@airplanemode` is a placeholder until the owner reserves it.                                                                                                                                                                            |
| Short write-up                            | Open                                      | Not written (the plan's drop order drops the write-up before tests and the benchmark).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Verify it yourself

```sh
npm ci --ignore-scripts
npm run ci                      # build:wasm, fmt:check, typecheck, vitest (about 400 tests), build
cargo test --locked && cargo clippy --locked --workspace --all-targets -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --locked
npm run test:browser            # installed Chrome: drivers, install, the vector, documents and hardening suites on OPFS and IndexedDB
npm run bench:vectors           # about a minute and a half; rewrites docs/benchmarks/vector-index.csv
npm run bench:readme            # regenerates the README Benchmarks block from that CSV, nothing else
npm run bench:documents         # about half a minute; rewrites docs/benchmarks/documents.csv
npm run bench:docs-readme       # regenerates the README documents block from that CSV, nothing else
npm run pack:check              # the tarball, the embedded modules, a fresh-directory install
npm run demo:build              # the Pages demo into demo/dist
```

The 8 GB Windows laptop measurement is the same `npm run bench:vectors` and `npm run bench:documents` run there; the CSV's `machine`
column is generated from the operating system, so a row from another machine cannot be mistaken for the
Apple M5 Pro rows.

## What a release must not claim

- That the figures are 8 GB figures. They are from an Apple M5 Pro with 48 GB.
- That CRC-32C makes the index tamper-proof. It detects accidental corruption only.
- That the index is encrypted, compacted, approximate or multi-writer beyond one writer at a time.
- That `deleteDocument` erases bytes: it hides them from every query; `clear(ns)` removes them from the driver.
- Any audit, compliance or model-inventory property.

## History

Four commits (e65ad81, 6df969d, 2782679, dd4844e), all dated 2026-11-09, carry attribution trailers. They
sit only on `origin/dependabot/npm_and_yarn/*` branches, not on `main`. Deleting those remote branches is an
owner step; nobody here pushes or deletes remote branches.
