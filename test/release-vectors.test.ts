// Sprint 7, D4-04 (TD-103, TD-104; S1): the release tool localdata vendors (scripts/release/release-tool.mjs, runtime's
// own verifier bundled) and the release vectors it is held to (scripts/release/vectors/, the spec release 0.6.1 files).
//
//   * the vendored tool and the vendored vectors are what scripts/release/VENDORED.json says (sha256 of the tool,
//     sha256 of the sorted listing of the vectors), read from this checkout alone: no sibling repository
//   * .gitattributes marks them '-text', so a CRLF checkout (core.autocrlf=true) cannot change a digest
//   * every case of release.json runs through the vendored tool in a child process with a scrubbed environment and
//     gives the exit code, the first stderr line and the JSON reason of the vector. Link cases (a symlinked artefact,
//     a symlinked --dir, a subdirectory, and on win32 a junction) are made at test time and FAIL rather than skip
//     when the OS refuses a link
//   * the tool never reads the allow flag from the environment (R3): a variable of that name changes nothing
//
// Written before the files existed (the red run is D4/red/D4-04-*.log in the sprint scratch).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const toolPath = join(root, 'scripts', 'release', 'release-tool.mjs');
const vectors = join(root, 'scripts', 'release', 'vectors');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const tmpRoot = mkdtempSync(join(tmpdir(), 'localdata-relvec-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let counter = 0;
const fresh = (label = 'w'): string => {
  const d = join(tmpRoot, `${label}-${++counter}`);
  mkdirSync(d, { recursive: true });
  return d;
};

interface Vendored {
  source: string;
  specRelease: string;
  sha256: string;
  vectors: { path: string; files: number; listingSha256: string };
}
const vendored = JSON.parse(
  readFileSync(join(root, 'scripts', 'release', 'VENDORED.json'), 'utf8'),
) as Vendored;

/** The sorted listing of a directory: one line per file, '<sha256>  vectors/release/<path>' and an LF. */
function listing(dir: string): { text: string; files: number } {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else
        out.push(
          `${sha(readFileSync(p))}  vectors/release/${relative(dir, p).split(sep).join('/')}`,
        );
    }
  };
  walk(dir);
  out.sort((a, b) => {
    const pa = a.slice(66);
    const pb = b.slice(66);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return { text: out.map((l) => `${l}\n`).join(''), files: out.length };
}

describe('the vendored release tool and vectors are what VENDORED.json says', () => {
  it('records spec release 0.6.1 and the source', () => {
    expect(vendored.specRelease).toBe('0.6.1');
    expect(vendored.source).toBe('AirplaneMode-Labs/runtime spec/tools/release-tool.mjs');
    expect(vendored.vectors.path).toBe('scripts/release/vectors');
  });

  it('the tool file hashes to the recorded sha256 (read from this checkout, no sibling)', () => {
    expect(sha(readFileSync(toolPath))).toBe(vendored.sha256);
    expect(vendored.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the vectors hash to the recorded listing digest and file count', () => {
    const l = listing(vectors);
    expect(l.files).toBe(vendored.vectors.files);
    expect(sha(l.text)).toBe(vendored.vectors.listingSha256);
  });

  it('no file of the tool or the vectors holds a carriage return that the originals do not (LF only, byte for byte)', () => {
    const tool = readFileSync(toolPath);
    expect(tool.includes(0x0d), 'the tool has a CR').toBe(false);
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) =>
        statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
      );
    for (const f of walk(vectors)) {
      if (/\.(bin)$/.test(f)) continue;
      expect(readFileSync(f).includes(0x0d), `${relative(root, f)} has a CR`).toBe(false);
    }
  });

  it("is '-text' in .gitattributes: the tool, VENDORED.json, the vectors and every SHA256SUMS", () => {
    const ga = readFileSync(join(root, '.gitattributes'), 'utf8');
    for (const line of [
      'scripts/release/release-tool.mjs -text',
      'scripts/release/VENDORED.json -text',
      'scripts/release/vectors/** -text',
      '**/SHA256SUMS -text',
    ])
      expect(ga.split('\n'), line).toContain(line);
  });

  it('is excluded from prettier, which would reformat a vendored file', () => {
    const ign = readFileSync(join(root, '.prettierignore'), 'utf8').split('\n');
    expect(ign).toContain('scripts/release/release-tool.mjs');
    expect(ign).toContain('scripts/release/vectors/');
  });

  it('npm pack never ships the tool, the vectors or the rehearsal output (the package files list is closed)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toEqual([
      'dist/index.js',
      'dist/index.d.ts',
      'LICENSE',
      'NOTICE',
      'README.md',
    ]);
  });
});

// ---- every case of release.json -------------------------------------------------------------------

interface Case {
  name: string;
  level: 'manifest' | 'directory';
  command: 'verify' | 'sign';
  dir: string;
  mutation: Record<string, unknown> & { op: string };
  args: string[];
  expect: { exit: number; reason: string | null; testKey?: boolean };
  platform?: string;
}
const cases = JSON.parse(readFileSync(join(vectors, 'release.json'), 'utf8')) as Case[];

function link(kind: 'file' | 'dir', target: string, path: string): void {
  try {
    if (kind === 'dir' && process.platform === 'win32') symlinkSync(target, path, 'junction');
    else symlinkSync(target, path, kind === 'dir' ? 'dir' : 'file');
  } catch (e) {
    throw new Error(
      `cannot create a ${kind} link on ${process.platform} (${(e as NodeJS.ErrnoException).code ?? 'error'}): the not_regular_file case cannot run here and must not be skipped`,
    );
  }
}

/** Copies the case's directory and applies its mutation to the copy; returns the --dir to pass. */
function arrange(c: Case, work: string): string {
  const dest = join(work, 'dir');
  cpSync(join(vectors, c.dir), dest, { recursive: true });
  const m = c.mutation as Record<string, string | number>;
  const file = (n: string) => join(dest, n);
  const textOf = (n: string) => readFileSync(file(n), 'utf8');
  switch (c.mutation.op) {
    case 'none':
      return dest;
    case 'flip-byte': {
      const b = readFileSync(file(String(m['file'])));
      b[Number(m['offset'] ?? 0)]! ^= 0x01;
      writeFileSync(file(String(m['file'])), b);
      return dest;
    }
    case 'truncate': {
      const b = readFileSync(file(String(m['file'])));
      writeFileSync(file(String(m['file'])), b.subarray(0, b.length - Number(m['bytes'] ?? 1)));
      return dest;
    }
    case 'remove':
      rmSync(file(String(m['file'])));
      return dest;
    case 'add-file':
      writeFileSync(file(String(m['file'])), String(m['content']));
      return dest;
    case 'sums-edit': {
      const lines = textOf('SHA256SUMS').split('\n');
      const i = Number(m['line'] ?? 0);
      const l = lines[i]!;
      lines[i] = (l[0] === '0' ? '1' : '0') + l.slice(1);
      writeFileSync(file('SHA256SUMS'), lines.join('\n'));
      return dest;
    }
    case 'sums-crlf':
      writeFileSync(file('SHA256SUMS'), textOf('SHA256SUMS').replace(/\n/g, '\r\n'));
      return dest;
    case 'sums-reorder':
      writeFileSync(
        file('SHA256SUMS'),
        `${textOf('SHA256SUMS').split('\n').filter(Boolean).reverse().join('\n')}\n`,
      );
      return dest;
    case 'manifest-publisher-edit': {
      const mf = JSON.parse(textOf('release-manifest.json')) as { publisher: string };
      mf.publisher = `${mf.publisher} (edited)`;
      writeFileSync(file('release-manifest.json'), `${JSON.stringify(mf, null, 2)}\n`);
      return dest;
    }
    case 'symlink-artifact': {
      const real = join(work, `real-${String(m['file'])}`);
      renameSync(file(String(m['file'])), real);
      link('file', real, file(String(m['file'])));
      return dest;
    }
    case 'junction-artifact': {
      const real = join(work, `real-dir-${String(m['file'])}`);
      mkdirSync(real);
      rmSync(file(String(m['file'])));
      link('dir', real, file(String(m['file'])));
      return dest;
    }
    case 'subdir':
      mkdirSync(file(String(m['name'] ?? 'sub')));
      return dest;
    case 'symlink-dir': {
      const via = join(work, 'via');
      link('dir', dest, via);
      return via;
    }
    default:
      throw new Error(`unknown mutation ${c.mutation.op}`);
  }
}

/** The tool in a child process with an environment that holds nothing from the runner. */
function runTool(args: string[], extraEnv: Record<string, string> = {}) {
  const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return spawnSync(process.execPath, [toolPath, ...args], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
}

const resolveArgs = (c: Case): string[] =>
  c.args.map((a) => (a.startsWith('@') ? join(vectors, a.slice(1)) : a));

describe('every case of release.json through the vendored tool (a child process)', () => {
  it('has the 36 cases of spec release 0.6.1', () => {
    expect(cases).toHaveLength(36);
    expect(new Set(cases.map((c) => c.name)).size).toBe(36);
  });

  for (const c of cases) {
    const applies = c.platform === undefined || c.platform === process.platform;
    it.runIf(applies)(
      `${c.name}: exit ${c.expect.exit}${c.expect.reason ? ` ${c.expect.reason}` : ''}`,
      () => {
        const work = fresh(c.name);
        const dir = arrange(c, work);
        const r = runTool([c.command, '--dir', dir, ...resolveArgs(c)], {
          SOURCE_DATE_EPOCH: '1795132800',
        });
        expect(r.error, 'the tool must run').toBeUndefined();
        expect(r.signal, 'the tool must not be killed').toBeNull();
        expect(r.status, `${c.name}: stderr ${r.stderr.split('\n')[0]}`).toBe(c.expect.exit);
        const first = r.stderr.split('\n')[0] ?? '';
        if (c.expect.exit === 3) {
          expect(first).toBe(`refused: ${c.expect.reason}`);
          expect(JSON.parse(r.stdout)).toMatchObject({
            verdict: 'refused',
            reason: c.expect.reason,
          });
        } else if (c.expect.exit === 2) {
          expect(first.startsWith(`usage: ${c.expect.reason}: `), first).toBe(true);
          expect(r.stdout).toBe('');
        } else {
          expect(c.expect.exit).toBe(0);
          const j = JSON.parse(r.stdout) as { verdict: string; testKey: boolean };
          expect(j.verdict).toBe('ok');
          if (c.expect.testKey !== undefined) expect(j.testKey).toBe(c.expect.testKey);
        }
      },
    );
  }

  it('the platform-gated cases are the junction case on win32 and nothing silently skipped elsewhere', () => {
    const gated = cases.filter((c) => c.platform !== undefined);
    expect(gated.map((c) => [c.name, c.platform])).toEqual([['junction-artifact', 'win32']]);
    // on win32 the case runs; on the others the plain symlink cases already prove the same refusal
    if (process.platform === 'win32') expect(gated.every((c) => c.platform === 'win32')).toBe(true);
  });
});

describe('R3: the allow flag exists only on the command line', () => {
  it('an environment variable named like the flag does not make a test-key verification pass', () => {
    const c = cases.find((x) => x.name === 'test-key-refused-without-flag')!;
    const work = fresh('r3');
    const dir = arrange(c, work);
    for (const env of [
      { ALLOW_TEST_KEY: '1' },
      { allowTestKeys: 'true' },
      { AIRPLANEMODE_ALLOW_TEST_KEY: '1' },
      { TRUST_TEST_KEY: '1', RELEASE_ALLOW_TEST_KEY: '1' },
    ]) {
      const r = runTool([c.command, '--dir', dir, ...resolveArgs(c)], env);
      expect(r.status).toBe(3);
      expect(r.stderr.split('\n')[0]).toBe('refused: test_key_refused');
    }
  });

  it('the tool reads exactly one environment variable, SOURCE_DATE_EPOCH', () => {
    const text = readFileSync(toolPath, 'utf8');
    const reads = text.match(/process\.env\b[^;\n]*/g) ?? [];
    expect(reads.filter((r) => !r.includes('SOURCE_DATE_EPOCH'))).toEqual([]);
    expect(reads.filter((r) => r.includes('SOURCE_DATE_EPOCH')).length).toBe(1);
  });

  it('a symlinked --dir is refused by all four commands (not_regular_file), the one-line proof beside the vector', () => {
    const work = fresh('four');
    const real = join(work, 'real');
    cpSync(join(vectors, 'base'), real, { recursive: true });
    const via = join(work, 'via');
    link('dir', real, via);
    for (const argv of [
      [
        'manifest',
        '--dir',
        via,
        '--id',
        'x-rehearsal',
        '--version',
        '1.0.0',
        '--licence',
        'Apache-2.0',
        '--publisher',
        'rehearsal',
      ],
      ['sums', '--dir', via],
      ['sign', '--dir', via, '--test-key', 'rfc8032-1'],
      [
        'verify',
        '--dir',
        via,
        '--expect-id',
        'example-rehearsal',
        '--trust-test-key',
        '--allow-test-key',
      ],
    ]) {
      const r = runTool(argv);
      expect(r.status, argv[0]).toBe(argv[0] === 'verify' ? 3 : 2);
      expect(r.stderr, argv[0]).toContain('not_regular_file');
    }
    expect(existsSync(via)).toBe(true);
  });
});
