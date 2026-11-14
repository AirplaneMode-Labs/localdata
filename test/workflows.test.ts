// D4-05: the CI rules from the conventions table, as tests. Every `uses:` is a full SHA from the table
// with its tag comment, nothing publishes, `pages: write` and `id-token: write` appear only on the
// deploy job, no pull_request_target, every cargo build, lint or test uses --locked, and the Rust
// toolchain steps are in jobs that only have contents: read.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', '.github', 'workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
const text = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

const TABLE: Record<string, [string, string]> = {
  'actions/checkout': ['3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1'],
  'actions/setup-node': ['949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0'],
  'actions/configure-pages': ['45bfe0192ca1faeb007ade9deae92b16b8254a0d', 'v6.0.0'],
  'actions/upload-pages-artifact': ['fc324d3547104276b827a68afc52ff2a11cc49c9', 'v5.0.0'],
  'actions/deploy-pages': ['368f82528645a54fb793d4d04e342629a3f51346', 'v5.0.1'],
  'dtolnay/rust-toolchain': ['683b588c487a69d01f6c6ddf40f036ff682cc2c8', 'v1'],
  'Swatinem/rust-cache': ['d1527c8f67ef9af357290475d4af4b0fab8f12e0', 'v2.9.3'],
};

/** The job blocks of a workflow: [name, body]. */
function jobs(src: string): Array<[string, string]> {
  const start = src.indexOf('\njobs:\n');
  const body = src.slice(start + 7);
  const parts = body.split(/\n(?=  [a-z][a-z0-9_-]*:\n)/);
  return parts.map((p) => [/^\s*([a-z][a-z0-9_-]*):/.exec(p)![1]!, p]);
}

describe('workflows', () => {
  it('has the three workflows', () => {
    expect(files.sort()).toEqual(['ci.yml', 'pages.yml']);
  });

  it('every uses: line is owner/repo@<40-hex SHA> # <tag> from the conventions table', () => {
    let n = 0;
    for (const [f, src] of text) {
      for (const line of src.split('\n').filter((l) => /\buses:/.test(l))) {
        const m = /uses:\s*([^@\s]+)@([0-9a-f]{40})\s+#\s+(\S+)\s*$/.exec(line);
        expect(m, `${f}: ${line.trim()}`).not.toBeNull();
        const row = TABLE[m![1]!];
        expect(row, `${m![1]} is in the table`).toBeDefined();
        expect(m![2]).toBe(row![0]);
        expect(m![3]).toBe(row![1]);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(12);
  });

  it('adds no action outside the table: only dtolnay/rust-toolchain and Swatinem/rust-cache are new to localdata', () => {
    const used = new Set<string>();
    for (const src of text.values())
      for (const m of src.matchAll(/uses:\s*([^@\s]+)@/g)) used.add(m[1]!);
    for (const u of used) expect(Object.keys(TABLE)).toContain(u);
  });

  it('nothing publishes, releases or registers anything', () => {
    for (const [f, src] of text) {
      for (const bad of [
        'npm publish',
        'cargo publish',
        'maturin publish',
        'twine',
        'gh release',
        'gh api',
        'softprops/action-gh-release',
        'pull_request_target',
        'secrets.',
        'NODE_AUTH_TOKEN',
      ])
        expect(src.includes(bad), `${f}: ${bad}`).toBe(false);
    }
  });

  it('pages: write and id-token: write appear only on the deploy job', () => {
    for (const [f, src] of text) {
      for (const [name, body] of jobs(src)) {
        const writes = /pages:\s*write|id-token:\s*write/.test(body);
        expect(writes, `${f}: ${name}`).toBe(f === 'pages.yml' && name === 'deploy');
      }
    }
  });

  it('every job sets its own permissions, and the build jobs (with the Rust toolchain) only read contents', () => {
    for (const [f, src] of text) {
      expect(src).toMatch(/\npermissions:\n {2}contents: read\n/);
      for (const [name, body] of jobs(src)) {
        expect(/\n {4}permissions:\n/.test(body), `${f}: ${name} has permissions`).toBe(true);
        if (body.includes('rust-toolchain'))
          expect(/contents:\s*read/.test(body) && !/write/.test(body), `${f}: ${name}`).toBe(true);
      }
    }
  });

  it('every cargo build, clippy, test or install uses --locked; and the wasm build script does', () => {
    for (const [f, src] of text)
      for (const line of src
        .split('\n')
        .filter((l) => /run:\s*cargo\s+(build|clippy|test|install)/.test(l)))
        expect(line, `${f}`).toContain('--locked');
    expect(readFileSync(join(dir, '..', '..', 'scripts', 'build-wasm.mjs'), 'utf8')).toContain(
      "'--locked'",
    );
  });

  it('the three-OS check job builds the Rust WebAssembly (build:wasm through npm run ci) on all three runners', () => {
    const ci = text.get('ci.yml')!;
    expect(ci).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    const check = jobs(ci).find(([n]) => n === 'check')![1];
    expect(check).toContain('rust-toolchain');
    expect(check).toContain('wasm32-unknown-unknown');
    expect(check).toContain('cargo test --locked');
    expect(check).toContain('run: npm run ci');
    expect(
      JSON.parse(readFileSync(join(dir, '..', '..', 'package.json'), 'utf8')).scripts.ci,
    ).toMatch(/^npm run build:wasm &&/);
  });

  it('the Pages build job builds the wasm before the demo, and the deploy job has no toolchain', () => {
    const pages = jobs(text.get('pages.yml')!);
    const build = pages.find(([n]) => n === 'build')![1];
    expect(build.indexOf('npm run build:wasm')).toBeGreaterThan(0);
    expect(build.indexOf('npm run build:wasm')).toBeLessThan(build.indexOf('npm run demo:build'));
    const deploy = pages.find(([n]) => n === 'deploy')![1];
    expect(deploy).not.toContain('rust-toolchain');
    expect(deploy).not.toContain('actions/checkout');
  });
});
