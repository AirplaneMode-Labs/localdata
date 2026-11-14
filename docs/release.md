# Release status: 0.2.0-alpha.0

Alpha = locally built, untagged `0.2.0-alpha.0`. Nobody tags, publishes, reserves a registry name or
changes a GitHub setting from this repository: the owner reviews, pushes and tags. This page is the
definition of done for a release, row by row, with its status today.

| Definition-of-done row                    | Status                                    | Evidence or what is missing                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tests first                               | Done                                      | Red then green logs: `evidence/sprint-4/D4/red-D4-01.log` to `red-D4-03.log` and the matching `green-D4-0x.log` (Rust: `cargo test --locked`; TypeScript: Vitest and Playwright). The README Benchmarks block is checked against the CSV by `test/readme-bench.test.ts`.                                                                                                                         |
| CI green on Linux, macOS and Windows      | Configured, pending the owner's push      | `.github/workflows/ci.yml` runs fmt, clippy, `cargo test --locked`, `npm run ci` (which builds the WebAssembly first), `pack:check`, the demo build and `npm pack --dry-run` on `ubuntu-latest`, `macos-latest` and `windows-latest`; a Chrome job runs the browser specs. Tests-first evidence Done (red/green logs); local macOS green; CI on three OSes configured, pending the owner's push. |
| Benchmark on an 8 GB laptop in the README | Open, owner                               | The README has the benchmark from an Apple M5 Pro 48 GB and says "not measured on 8 GB". The owner's runbook (`npm run bench:vectors` on the 8 GB Windows laptop) is in the repository PLAN.md; every 8 GB cell reads "not measured" until it exists.                                                                                                                                            |
| README limitations section                | Done                                      | Plainly: single writer per namespace, stale readers, no compaction, f32 only, CRC-32C is not tamper-proofing, data unencrypted in the origin, flat-index poisoning, eviction removes the whole origin, WebAssembly memory does not shrink, the IndexedDB fallback as measured, nothing measured on 8 GB.                                                                                         |
| Signed artifacts and manifest             | Open, owner key                           | No release manifest exists. Signing needs the owner's ed25519 key, which nobody else generates or holds. `*.tgz` and `release-manifest*.json` are never committed.                                                                                                                                                                                                                               |
| CHANGELOG and semver tag                  | CHANGELOG Done; tag Open, owner           | `CHANGELOG.md` has `## [0.2.0-alpha.0] - 2026-11-14 (untagged)`. The owner creates the tag after review.                                                                                                                                                                                                                                                                                         |
| Installable from a clean machine          | Local tarball proven; publish Open, owner | `npm run pack:check`: `npm pack`, offline install into a fresh empty directory from an empty cache, then `putVectors` of three rows and a `query` from the installed copy print the keys (log under `evidence/sprint-4/D4/pack/`). No registry has the package: the npm scope `@airplanemode` is a placeholder until the owner reserves it.                                                      |
| Short write-up                            | Open                                      | Not written in Sprint 4 (cut to Sprint 5 by the plan's drop order; tests and the benchmark are never dropped).                                                                                                                                                                                                                                                                                   |

## Verify it yourself

```sh
npm ci
npm run ci                      # build:wasm, fmt:check, typecheck, vitest (about 300 tests), build
cargo test --locked && cargo clippy --locked --workspace --all-targets -- -D warnings
npm run test:browser            # installed Chrome: drivers, install, and the vector suite on OPFS and IndexedDB
npm run bench:vectors           # about a minute and a half; rewrites docs/benchmarks/vector-index.csv
npm run bench:readme            # regenerates the README Benchmarks block from that CSV, nothing else
npm run pack:check              # the tarball, the embedded modules, a fresh-directory install
npm run demo:build              # the Pages demo into demo/dist
```

The 8 GB Windows laptop measurement is the same `npm run bench:vectors` run there; the CSV's `machine`
column is generated from the operating system, so a row from another machine cannot be mistaken for the
Apple M5 Pro rows.

## What a release must not claim

- That the figures are 8 GB figures. They are from an Apple M5 Pro with 48 GB.
- That CRC-32C makes the index tamper-proof. It detects accidental corruption only.
- That the index is encrypted, compacted, approximate or multi-writer beyond one writer at a time.
- Any audit, compliance or model-inventory property.

## History

Four commits (e65ad81, 6df969d, 2782679, dd4844e), all dated 2026-11-09, carry attribution trailers. They
sit only on `origin/dependabot/npm_and_yarn/*` branches, not on `main`. Deleting those remote branches is an
owner step; nobody here pushes or deletes remote branches.
