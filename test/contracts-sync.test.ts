import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONTRACTS,
  findSpecLanded,
  parseLanded,
  sync,
  vendoredBody,
} from '../scripts/sync-contracts.mjs';

const siblingPresent = CONTRACTS.every((c: { source: string }) => existsSync(c.source));
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const scratch: string[] = [];
function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `localdata-sync-${label}-`));
  scratch.push(d);
  return d;
}
afterAll(() => {
  // Only the mkdtemp directories this file created, each holding two tiny files.
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

const STORAGE_SRC = '// synthetic storage-api\nexport const STORAGE = 1;\n';
const EVENT_SRC = '// synthetic event\nexport const EVENT = 2;\n';

/** A fake spec directory with synthetic contract files and the matching landed map. */
function fixture(): { specDir: string; outDir: string; landed: Map<string, string> } {
  const specDir = tempDir('spec');
  const outDir = tempDir('out');
  writeFileSync(join(specDir, 'storage-api.ts'), STORAGE_SRC);
  writeFileSync(join(specDir, 'event.ts'), EVENT_SRC);
  const landed = new Map([
    ['storage-api.ts', sha(STORAGE_SRC)],
    ['event.ts', sha(EVENT_SRC)],
  ]);
  return { specDir, outDir, landed };
}

describe('vendored contracts', () => {
  it('vendor storage-api.ts @ 0.1.0 and event.ts @ 0.1.2, each with its own version header', () => {
    expect(CONTRACTS.map((c: { target: string }) => c.target.split(/[\\/]/).pop())).toEqual([
      'storage-api.ts',
      'event.ts',
    ]);
    const headers = (CONTRACTS as Array<{ header: string }>).map((c) => c.header);
    expect(headers[0]).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/storage-api.ts @ 0.1.0; source of truth is runtime/spec; do not edit here\n',
    );
    expect(headers[1]).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/event.ts @ 0.1.2; source of truth is runtime/spec; do not edit here\n',
    );
  });

  it('carry the vendoring header pointing at runtime/spec', () => {
    for (const c of CONTRACTS as Array<{ target: string; header: string }>) {
      const text = readFileSync(c.target, 'utf8');
      expect(text.startsWith('// Vendored from AirplaneMode-Labs/runtime spec/')).toBe(true);
      expect(text.split('\n')[0]).toContain('source of truth is runtime/spec');
      expect(text.startsWith(c.header)).toBe(true);
    }
  });

  it.skipIf(!siblingPresent)(
    'match ../runtime/spec byte for byte (run `npm run sync-contracts` on drift)',
    () => {
      for (const c of CONTRACTS as Array<{ source: string; target: string }>) {
        const src = readFileSync(c.source, 'utf8');
        const vendored = vendoredBody(readFileSync(c.target, 'utf8'));
        expect(vendored, `drift in ${resolve(c.target)}`).toBe(src);
      }
    },
  );
});

describe('parseLanded', () => {
  it('keys each line by its listed path, so a basename shared by two directories does not collide', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const map = parseLanded(
      `${a}  neg-bad-spec.json\n${b}  vectors/neg-bad-spec.json\nnot a line\n`,
    );
    expect(map.get('neg-bad-spec.json')).toBe(a);
    expect(map.get('vectors/neg-bad-spec.json')).toBe(b);
    expect(map.size).toBe(2);
  });
});

describe('sync() gated on SPEC-LANDED.txt', () => {
  it('copies both contracts with their headers when every sha256 matches, then reports in-sync', () => {
    const { specDir, outDir, landed } = fixture();
    const first = sync({ specDir, outDir, landed });
    expect(first.map((r: { status: string }) => r.status)).toEqual(['updated', 'updated']);
    expect(readFileSync(join(outDir, 'storage-api.ts'), 'utf8')).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/storage-api.ts @ 0.1.0; source of truth is runtime/spec; do not edit here\n' +
        STORAGE_SRC,
    );
    expect(readFileSync(join(outDir, 'event.ts'), 'utf8')).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/event.ts @ 0.1.2; source of truth is runtime/spec; do not edit here\n' +
        EVENT_SRC,
    );
    const second = sync({ specDir, outDir, landed });
    expect(second.map((r: { status: string }) => r.status)).toEqual(['in-sync', 'in-sync']);
  });

  it('a tampered hash copies nothing: not even the file whose hash is right', () => {
    const { specDir, outDir, landed } = fixture();
    landed.set('event.ts', sha(EVENT_SRC + 'tampered'));
    const results = sync({ specDir, outDir, landed });
    const byFile = Object.fromEntries(
      (results as Array<{ file: string; status: string }>).map((r) => [r.file, r.status]),
    );
    expect(byFile).toEqual({ 'storage-api.ts': 'blocked', 'event.ts': 'sha-mismatch' });
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('a spec file edited after landing (source differs from its recorded hash) copies nothing', () => {
    const { specDir, outDir, landed } = fixture();
    writeFileSync(join(specDir, 'storage-api.ts'), STORAGE_SRC + '// edited after landing\n');
    const results = sync({ specDir, outDir, landed });
    expect((results as Array<{ status: string }>).some((r) => r.status === 'sha-mismatch')).toBe(
      true,
    );
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('a contract missing from the landed list copies nothing', () => {
    const { specDir, outDir, landed } = fixture();
    landed.delete('event.ts');
    const results = sync({ specDir, outDir, landed });
    expect((results as Array<{ status: string }>).map((r) => r.status)).toEqual([
      'blocked',
      'sha-missing',
    ]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('a missing source file copies nothing', () => {
    const { specDir, outDir, landed } = fixture();
    const empty = tempDir('empty-spec');
    const results = sync({ specDir: empty, outDir, landed });
    expect((results as Array<{ status: string }>).every((r) => r.status === 'source-missing')).toBe(
      true,
    );
    expect(readdirSync(outDir)).toEqual([]);
    expect(specDir).not.toBe(empty);
  });

  it('write: false never writes, and reports drift', () => {
    const { specDir, outDir, landed } = fixture();
    const results = sync({ specDir, outDir, landed, write: false });
    expect((results as Array<{ status: string }>).map((r) => r.status)).toEqual(['drift', 'drift']);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('refuses to follow a landed hash that is not 64 lowercase hex', () => {
    const { specDir, outDir, landed } = fixture();
    landed.set('storage-api.ts', 'SHA256-OF-SOMETHING');
    const results = sync({ specDir, outDir, landed });
    expect((results as Array<{ status: string }>).some((r) => r.status === 'sha-mismatch')).toBe(
      true,
    );
    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe('findSpecLanded lookup order', () => {
  const repo = join('x', 'localdata');
  const evidence = join(repo, '..', 'evidence', 'sprint-3', 'D1', 'SPEC-LANDED.txt');
  const exists = (present: string[]) => (p: string) => present.map((x) => resolve(x)).includes(p);

  it('1. env SPEC_LANDED wins when it names an existing file', () => {
    const r = findSpecLanded({
      env: { SPEC_LANDED: '/elsewhere/SPEC-LANDED.txt' },
      repo,
      exists: exists(['/elsewhere/SPEC-LANDED.txt', evidence]),
    });
    expect(r).toEqual({ path: '/elsewhere/SPEC-LANDED.txt', source: 'env' });
  });

  it('an env SPEC_LANDED that names a missing file is an error, never a silent fall-through', () => {
    const r = findSpecLanded({
      env: { SPEC_LANDED: '/nope/SPEC-LANDED.txt' },
      repo,
      exists: exists([evidence]),
    });
    expect(r).toEqual({ path: '/nope/SPEC-LANDED.txt', source: 'env', missing: true });
  });

  it('2. ../evidence/sprint-3/D1/SPEC-LANDED.txt next', () => {
    const r = findSpecLanded({ env: {}, repo, exists: exists([evidence]) });
    expect(r?.source).toBe('evidence');
    expect(r?.path).toBe(resolve(evidence));
  });

  it('has no third lookup: a scratch-style path alone is not found', () => {
    const r = findSpecLanded({
      env: {},
      repo,
      exists: (p: string) => p.endsWith(join('D1', 'SPEC-LANDED.txt')) && !p.includes('evidence'),
    });
    expect(r).toBeUndefined();
  });

  it('returns undefined when none exists (the spec has not landed)', () => {
    expect(findSpecLanded({ env: {}, repo, exists: () => false })).toBeUndefined();
  });
});
