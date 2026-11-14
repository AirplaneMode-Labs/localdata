// D4-05: the demo's Content-Security-Policy is pinned to one exact string. The only change from
// Sprint 3 is 'wasm-unsafe-eval' on script-src, which lets the page compile the embedded ldvec
// WebAssembly modules from memory; nothing else may be added (no 'unsafe-eval', no 'unsafe-inline', no
// blob:, no worker-src while the kernel runs on the page's own thread, and no new origin).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

function cspOf(html: string): string {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
  expect(m, 'the page has a CSP meta tag').not.toBeNull();
  return m![1]!;
}

describe('demo CSP', () => {
  const pages = [['demo/index.html', join(root, 'demo', 'index.html')]] as const;
  const built = join(root, 'demo', 'dist', 'index.html');

  for (const [name, path] of pages) {
    it(`${name} carries exactly the pinned policy`, () => {
      expect(cspOf(readFileSync(path, 'utf8'))).toBe(CSP);
    });
  }

  it.skipIf(!existsSync(built))('the built demo/dist/index.html carries the same policy', () => {
    expect(cspOf(readFileSync(built, 'utf8'))).toBe(CSP);
  });

  it('adds only wasm-unsafe-eval to the Sprint 3 policy', () => {
    const sprint3 =
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    expect(CSP.replace(" 'wasm-unsafe-eval'", '')).toBe(sprint3);
  });

  it('has no unsafe-eval, unsafe-inline, blob:, worker-src, wildcard or remote origin', () => {
    for (const bad of [
      "'unsafe-eval'",
      "'unsafe-inline'",
      'blob:',
      'worker-src',
      '*',
      'http:',
      'https:',
    ])
      expect(CSP.includes(bad), bad).toBe(false);
  });

  it('the demo page loads only its own script and style (no inline script, no remote asset)', () => {
    const html = readFileSync(join(root, 'demo', 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script type="module" src="./app.js">']);
    expect(/<script\b[^>]*>[^<\s]/.test(html), 'no inline script body').toBe(false);
    for (const m of html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)) {
      // links to other pages are fine; a stylesheet, script or image from elsewhere is not
      const tag = html.slice(Math.max(0, m.index! - 40), m.index!);
      expect(/<(script|link|img)\b[^>]*$/.test(tag), m[1]).toBe(false);
    }
  });

  it('the vendored harness page may compile WebAssembly too, but stays otherwise closed', () => {
    const csp = cspOf(readFileSync(join(root, 'test', 'browser', 'index.html'), 'utf8'));
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });
});
