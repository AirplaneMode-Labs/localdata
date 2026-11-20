# Contributing to localdata

Thank you for considering a contribution. This repository is part of Airplane Mode Labs, an
open-core, offline-first, browser-native AI infrastructure lab.

## Ground rules

- Tests first. Every behavioural change starts with a failing case in `test/storage.behaviour.ts`
  (shared by the memory, OPFS and IndexedDB drivers) or in a focused unit test, committed before the
  implementation that makes it pass.
- Zero runtime dependencies. A new dependency needs a one-line justification in `CHANGELOG.md`.
- Keep the Storage API contract vendored, never edited here: `src/contracts/storage-api.ts` is a copy
  of `runtime/spec/storage-api.ts`. Propose contract changes in the `runtime` repository; then run
  `npm run sync-contracts`.
- Run `npm run sync-contracts` whenever `runtime/spec` changes (the sibling checkout at
  `../runtime` is the source); `test/contracts-sync.test.ts` fails `npm run ci` on any drift.
- British spelling in prose, no emojis.
- Run `npm run ci` (format check, typecheck, unit tests, build) and `npm run test:browser` (Playwright
  on installed Chrome) before opening a pull request.

## No real documents

This library is built for sensitive document workflows, so nothing in an issue, a pull request, a test or a benchmark
may be a real document (bank, legal, medical, identity) or anything derived from one. Inputs are synthetic (the
integer-only generator of `bench/synth.ts`, hand-written vectors) or clearly public and openly licensed, with the
licence recorded; no committed input is over 5 MB.

## Before you open a pull request

- `npm run ci` (build of the WebAssembly kernel, format check, typecheck, unit tests, build), and
  `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked`
  and `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --locked` when you touch `crates/ldvec`.
- The README section "Try it in two minutes" is executed by `test/quickstart.test.ts`: if you change what it shows, the
  test shows you what to update. Benchmark blocks in the README are generated from `docs/benchmarks/*.csv`
  (`npm run bench:readme`, `npm run bench:ann-readme`); never edit a figure by hand.
- The release path is rehearsed, never run, by `node scripts/release/rehearse.mjs` (it signs with the published RFC
  8032 test key and publishes nothing). Releasing is the owner's: see `docs/RELEASING.md`. A pull request does not tag,
  publish, change a repository setting or touch `docs/release-keys.json`.
- Good first issues are drafted in the Airplane Mode Labs workspace; if one is filed here it names the file to start in.

## Licence of contributions

By contributing you agree that your contributions are licensed under the Apache License, Version 2.0,
the licence of this repository. See `LICENSE` and `NOTICE`.

## Security issues

Please do not open public issues for security problems; see `SECURITY.md`.
