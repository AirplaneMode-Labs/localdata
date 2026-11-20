#!/usr/bin/env node
// Decisions of the publish job that are easy to get wrong in shell (Sprint 7 fix round 1; TD-125, TD-121, S1-130).
// Owner-only context: .github/workflows/publish.yml calls this file; nobody on the team runs a publish. Nothing here
// reads the environment: the commit, the version and the repository arrive as arguments (the workflow passes
// "$GITHUB_SHA" and "$VERSION" from its own step env), and the ref that triggered the run is never consulted.
//
//   node scripts/release/publish-guard.mjs semver <version>
//   node scripts/release/publish-guard.mjs tag --version <v> --sha <40 hex> --repo <owner/name>
//   node scripts/release/publish-guard.mjs no-expiry --file <release-manifest.json>
//
// exit 0 passes, 1 refuses (a reason on stderr), 2 is a usage error.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The very pattern of spec/manifest.ts SEMVER_PATTERN (test/publish-guard.test.ts compares them): strict SemVer 2.0, no build metadata. */
export const GUARD_SEMVER_SOURCE =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?$';
const SEMVER = new RegExp(GUARD_SEMVER_SOURCE);
const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A version that may be written to GITHUB_ENV: strict SemVer (JS `$` without the m flag does not match before a trailing line feed). */
export function assertStrictSemver(version) {
  if (typeof version !== 'string' || !SEMVER.test(version))
    throw new Error(
      `not strict SemVer 2.0 without build metadata: ${JSON.stringify(String(version))}`,
    );
}

/**
 * The commit that tag v<version> resolves to. `api(path)` returns the parsed JSON of GET repos/<repo>/<path>. A lightweight tag
 * points at a commit; an annotated tag points at a tag object that is dereferenced (a short chain, never a loop) until a
 * commit is reached. Anything else is an error.
 */
export function resolveTagCommit(version, api) {
  assertStrictSemver(version);
  let obj = api(`git/ref/tags/v${version}`)?.object;
  for (let hops = 0; hops < 4; hops++) {
    if (!obj || typeof obj.type !== 'string' || !SHA40.test(String(obj.sha)))
      throw new Error(`tag v${version}: the answer does not name an object`);
    if (obj.type === 'commit') return obj.sha;
    if (obj.type !== 'tag')
      throw new Error(`tag v${version} points at a ${obj.type}, not a commit`);
    obj = api(`git/tags/${obj.sha}`)?.object;
  }
  throw new Error(`tag v${version}: too many nested tag objects`);
}

/** Refuses unless tag v<version> resolves to `sha`. */
export function assertTagResolvesTo(version, sha, api) {
  assertStrictSemver(version);
  if (typeof sha !== 'string' || !SHA40.test(sha))
    throw new Error('the commit must be 40 lowercase hex characters');
  const got = resolveTagCommit(version, api);
  if (got !== sha) throw new Error(`tag v${version} points at ${got}, not at ${sha}`);
}

/** TD-121 / R5: a release manifest carries no expiresAt member (the owner signs with cp-sign sign --no-expiry). */
export function assertNoExpiresAt(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new Error('the manifest is not JSON');
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m))
    throw new Error('the manifest is not a JSON object');
  if (Object.hasOwn(m, 'expiresAt'))
    throw new Error(
      'the release manifest has an expiresAt member: sign again with cp-sign sign --no-expiry (TD-121)',
    );
}

function ghApi(repo) {
  return (path) =>
    JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
}

function opts(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) return undefined;
    o[args[i].slice(2)] = args[i + 1];
  }
  return o;
}

/** The command line. `ctx` injects the registry api, the file reader and the output streams (tests). Returns the exit code. */
export function guardMain(argv, ctx = {}) {
  const stdout = ctx.stdout ?? ((s) => process.stdout.write(s));
  const stderr = ctx.stderr ?? ((s) => process.stderr.write(s));
  const readFile = ctx.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const [cmd, ...rest] = argv;
  const usage = (m) => {
    stderr(`usage: ${m}\n`);
    return 2;
  };
  const refuse = (e) => {
    stderr(`refused: ${e.message}\n`);
    return 1;
  };
  if (cmd === 'semver') {
    if (rest.length !== 1) return usage('publish-guard semver <version>');
    try {
      assertStrictSemver(rest[0]);
      stdout('ok\n');
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  if (cmd === 'tag') {
    const o = opts(rest);
    if (!o || o.version === undefined || o.sha === undefined || o.repo === undefined)
      return usage('publish-guard tag --version <v> --sha <sha> --repo <owner/name>');
    if (!REPO.test(o.repo)) return usage('--repo must be owner/name');
    try {
      assertTagResolvesTo(o.version, o.sha, ctx.api ?? ghApi(o.repo));
      stdout(`ok: tag v${o.version} resolves to ${o.sha}\n`);
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  if (cmd === 'no-expiry') {
    const o = opts(rest);
    if (!o || o.file === undefined) return usage('publish-guard no-expiry --file <manifest>');
    try {
      assertNoExpiresAt(readFile(o.file));
      stdout('ok: no expiresAt\n');
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  return usage('publish-guard semver|tag|no-expiry ...');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = guardMain(process.argv.slice(2));
