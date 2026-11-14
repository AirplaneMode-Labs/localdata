// T3-S3-001: public code and tests must not hard-code a sprint scratch path, so a hosted Linux
// runner, Windows and any contributor's machine can run `npm run pack:check` and `npm run
// test:browser`. These checks are static; the behavioural proof is running both commands with
// TMPDIR pointed at a fresh directory (see README Develop).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '..');
// Built from pieces so this file does not match its own scan.
const FORBIDDEN = [
  ['/private', '/tmp'].join(''),
  ['airplanemode', '-team'].join(''),
  ['/Users', '/'].join(''),
  ['C:', '\\\\Users'].join(''),
];
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(repo, p).split(sep).join('/');
    if (
      /^(node_modules|dist|demo\/dist|test\/browser\/dist|test-results|\.git|evidence)(\/|$)/.test(
        rel,
      )
    )
      continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?[jt]s|json|md|yml|html|css)$/.test(name) && name !== 'package-lock.json')
      out.push(rel);
  }
  return out;
}

describe('no sprint-scratch or developer-machine paths in public files', () => {
  const files = walk(repo);
  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });
  it('none of src, scripts, test, demo, README, CHANGELOG, package.json names a scratch or home path (0 occurrences)', () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(repo, f), 'utf8');
      for (const needle of FORBIDDEN) if (text.includes(needle)) hits.push(`${f}: ${needle}`);
    }
    expect(hits).toEqual([]);
  });
  it('sync-contracts has no scratch lookup', () => {
    const text = readFileSync(join(repo, 'scripts/sync-contracts.mjs'), 'utf8');
    expect(text).not.toContain('SPEC_LANDED_SCRATCH');
    expect(text).not.toContain("source: 'scratch'");
  });
});

describe('pack-check and the install spec', () => {
  const packCheck = readFileSync(join(repo, 'scripts/pack-check.mjs'), 'utf8');
  const installSpec = readFileSync(join(repo, 'test/browser/install.spec.ts'), 'utf8');

  it('pack-check defaults to a mkdtemp under os.tmpdir() and takes --out', () => {
    expect(packCheck).toMatch(/mkdtempSync\(\s*join\(tmpdir\(\)/);
    expect(packCheck).toContain('--out');
    expect(packCheck).not.toMatch(/startsWith\(['"]\/private/);
  });

  it('pack-check spawns npm in a Windows-safe way (npm_execpath through node, else npm.cmd with a shell)', () => {
    expect(packCheck).toContain('npm_execpath');
    expect(packCheck).toContain('npm.cmd');
    expect(packCheck).not.toMatch(/execFileSync\(\s*['"]npm['"]/);
    expect(packCheck).not.toMatch(/\brun\(\s*['"]npm['"]/);
  });

  it('pack-check does not shell out to tar (GNU tar on Windows reads C: as a host)', () => {
    expect(packCheck).not.toMatch(/['"]tar['"]/);
  });

  it('install.spec uses a mkdtemp scratch and removes only that directory', () => {
    expect(installSpec).toMatch(/mkdtempSync\(\s*join\(tmpdir\(\)/);
    expect(installSpec).toContain('--out');
    expect(installSpec).not.toMatch(/SCRATCH\s*=\s*['"]\//);
  });

  it('install.spec serves files with a separator-safe containment check', () => {
    expect(installSpec).not.toContain("FRESH + '/'");
    expect(installSpec).toMatch(/relative\(/);
  });
});
