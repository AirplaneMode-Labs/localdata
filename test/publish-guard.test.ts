// Fix round 1 (D4 copy of runtime's test/publish-guard.test.ts), TD-125 and S1-130: scripts/release/publish-guard.mjs holds the publish job's decisions that are easy to get
// wrong in shell: the strict SemVer check before a version reaches GITHUB_ENV, the tag-to-commit binding (a lightweight tag,
// an annotated tag dereferenced, a mismatch refused, GITHUB_REF never used) and the no-expiresAt rule for release manifests
// (TD-121 / R5). The registry and GitHub are injected, so nothing here touches a network.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUARD_SEMVER_SOURCE,
  assertStrictSemver,
  assertTagResolvesTo,
  assertNoExpiresAt,
  resolveTagCommit,
  guardMain,
  // @ts-expect-error: plain ESM script
} from '../scripts/release/publish-guard.mjs';

const repoDir = resolve(import.meta.dirname, '..');

/**
 * The very pattern of runtime's spec/manifest.ts SEMVER_PATTERN (strict SemVer 2.0, no build metadata), copied here because
 * localdata does not vendor manifest.ts and no test reads a sibling repository. runtime's own test checks the same
 * constant of the same script against its spec file.
 */
const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?$';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAG_OBJ = 'c'.repeat(40);

type Api = (path: string) => unknown;
const apiFor = (table: Record<string, unknown>): Api => {
  return (path: string) => {
    if (!(path in table)) throw new Error(`unexpected api path ${path}`);
    return table[path];
  };
};

describe('publish-guard: strict SemVer before GITHUB_ENV', () => {
  it('uses the SemVer 2.0 pattern of the spec manifest (copied above)', () => {
    expect(GUARD_SEMVER_SOURCE).toBe(SEMVER_PATTERN);
  });
  it('accepts plain, prerelease versions and refuses build metadata, leading zeros, newlines and injection', () => {
    for (const v of ['0.3.0-beta.2', '1.0.0', '1.0.0-rc.1', '10.20.30'])
      expect(() => assertStrictSemver(v), v).not.toThrow();
    for (const v of [
      '1.0.0+build',
      '01.0.0',
      '1.0',
      '1.0.0\n',
      '1.0.0\nEVIL=1',
      '1.0.0 ',
      '',
      'v1.0.0',
      '1.0.0-beta.2\r',
    ])
      expect(() => assertStrictSemver(v), JSON.stringify(v)).toThrow(/SemVer/);
  });
});

describe('publish-guard: the tag v<version> resolves to the commit the run builds', () => {
  const lightweight = apiFor({
    'git/ref/tags/v1.2.3': { object: { type: 'commit', sha: SHA } },
  });
  const annotated = apiFor({
    'git/ref/tags/v1.2.3': { object: { type: 'tag', sha: TAG_OBJ } },
    [`git/tags/${TAG_OBJ}`]: { object: { type: 'commit', sha: SHA } },
  });

  it('a lightweight tag at the commit passes', () => {
    expect(resolveTagCommit('1.2.3', lightweight)).toBe(SHA);
    expect(() => assertTagResolvesTo('1.2.3', SHA, lightweight)).not.toThrow();
  });
  it('an annotated tag is dereferenced to its commit and passes', () => {
    expect(resolveTagCommit('1.2.3', annotated)).toBe(SHA);
    expect(() => assertTagResolvesTo('1.2.3', SHA, annotated)).not.toThrow();
  });
  it('a tag at another commit is refused, lightweight and annotated', () => {
    expect(() => assertTagResolvesTo('1.2.3', OTHER, lightweight)).toThrow(/not at/);
    expect(() => assertTagResolvesTo('1.2.3', OTHER, annotated)).toThrow(/not at/);
  });
  it('an annotated tag whose object is not a commit (a tag of a tree or of another tag chain) is refused', () => {
    const tree = apiFor({
      'git/ref/tags/v1.2.3': { object: { type: 'tag', sha: TAG_OBJ } },
      [`git/tags/${TAG_OBJ}`]: { object: { type: 'tree', sha: SHA } },
    });
    expect(() => assertTagResolvesTo('1.2.3', SHA, tree)).toThrow();
    const loop = apiFor({
      'git/ref/tags/v1.2.3': { object: { type: 'tag', sha: TAG_OBJ } },
      [`git/tags/${TAG_OBJ}`]: { object: { type: 'tag', sha: TAG_OBJ } },
    });
    expect(() => assertTagResolvesTo('1.2.3', SHA, loop)).toThrow();
  });
  it('a missing tag (the api throws) is refused, never passed', () => {
    const missing: Api = () => {
      throw new Error('HTTP 404');
    };
    expect(() => assertTagResolvesTo('1.2.3', SHA, missing)).toThrow();
  });
  it('a malformed answer or a malformed expected commit is refused', () => {
    expect(() =>
      assertTagResolvesTo('1.2.3', SHA, apiFor({ 'git/ref/tags/v1.2.3': {} })),
    ).toThrow();
    expect(() => assertTagResolvesTo('1.2.3', 'not-a-sha', lightweight)).toThrow(/commit/);
    expect(() => assertTagResolvesTo('1.2.3', SHA.toUpperCase(), lightweight)).toThrow(/commit/);
    expect(() => assertTagResolvesTo('1.2.3+x', SHA, lightweight)).toThrow(/SemVer/);
  });
  it('the guard never reads GITHUB_REF, GITHUB_REF_NAME or any ref from the environment', () => {
    const src = readFileSync(resolve(repoDir, 'scripts/release/publish-guard.mjs'), 'utf8');
    expect(src).not.toMatch(/GITHUB_REF/);
    expect(src).not.toMatch(/process\.env/);
  });
  it('guardMain tag-sha takes the commit from its arguments only and returns 1 on a mismatch', () => {
    const io = { out: '', err: '' };
    const ctx = {
      api: annotated,
      stdout: (s: string) => (io.out += s),
      stderr: (s: string) => (io.err += s),
    };
    expect(guardMain(['tag', '--version', '1.2.3', '--sha', SHA, '--repo', 'o/r'], ctx)).toBe(0);
    expect(guardMain(['tag', '--version', '1.2.3', '--sha', OTHER, '--repo', 'o/r'], ctx)).toBe(1);
    expect(io.err).toMatch(/not at/);
    expect(guardMain(['tag', '--version', '1.2.3'], ctx)).toBe(2);
    expect(guardMain(['tag', '--version', '1.2.3', '--sha', SHA, '--repo', 'bad repo!'], ctx)).toBe(
      2,
    );
    expect(guardMain(['bogus'], ctx)).toBe(2);
  });
});

describe('publish-guard: a release manifest carries no expiresAt (TD-121, R5)', () => {
  it('passes without the member and refuses with it, even when null or empty', () => {
    expect(() => assertNoExpiresAt('{"id":"x-release","entries":[]}')).not.toThrow();
    for (const v of ['"2027-01-01T00:00:00Z"', 'null', '""', '0'])
      expect(() => assertNoExpiresAt(`{"id":"x-release","expiresAt":${v}}`), v).toThrow(
        /expiresAt/,
      );
  });
  it('a manifest that is not a JSON object is refused', () => {
    for (const t of ['[]', 'null', '"x"', '{', '']) expect(() => assertNoExpiresAt(t), t).toThrow();
  });
  it('guardMain no-expiry reads the file given and exits 1 on a manifest with expiresAt', () => {
    const files: Record<string, string> = {
      'ok.json': '{"id":"x-release"}',
      'bad.json': '{"id":"x-release","expiresAt":"2027-01-01T00:00:00Z"}',
    };
    const ctx = {
      api: () => ({}),
      readFile: (p: string) => files[p] ?? '',
      stdout: () => {},
      stderr: () => {},
    };
    expect(guardMain(['no-expiry', '--file', 'ok.json'], ctx)).toBe(0);
    expect(guardMain(['no-expiry', '--file', 'bad.json'], ctx)).toBe(1);
    expect(guardMain(['no-expiry'], ctx)).toBe(2);
  });
});
