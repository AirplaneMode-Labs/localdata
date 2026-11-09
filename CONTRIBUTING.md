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

## Licence of contributions

By contributing you agree that your contributions are licensed under the Apache License, Version 2.0,
the licence of this repository. See `LICENSE` and `NOTICE`.

## Security issues

Please do not open public issues for security problems; see `SECURITY.md`.
