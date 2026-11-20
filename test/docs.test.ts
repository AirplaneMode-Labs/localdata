// Sprint 7, D4-06 to D4-08: what the documents of this repository must say about the release path, so that none of
// it can drift. Written before the documents existed (the red run is D4/red/D4-08-*.log in the sprint scratch).
//   * the write-up draft is marked "draft, not published", names the committed files its figures come from, and reads
//     "not measured on 8 GB" for every laptop figure; docs/release.md says finishing it waits on the 8 GB figure
//   * docs/RELEASING.md lists only owner steps (each with its reason), in order, with the exact gh commands for the
//     environment, its secret and variables, and never a test key
//   * every README keeps the lines the whole project promises: the live demo link, "not measured on 8 GB" and
//     "nothing is published"
//   * the issue forms carry the required no-real-documents checkbox and the SECURITY.md link; blank issues are off
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const text = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('the write-up draft (D4-08)', () => {
  const file = join('docs', 'writeup-0.4.0-alpha.1-draft.md');

  it('exists and is marked "draft, not published" in its first lines', () => {
    expect(existsSync(join(root, file))).toBe(true);
    const t = text(file);
    expect(t.split('\n').slice(0, 6).join('\n')).toContain('draft, not published');
  });

  it('cites committed files for its figures: every docs/benchmarks file it names exists, and it names ann.csv and ann-duplicates.csv', () => {
    const t = text(file);
    const named = [...t.matchAll(/docs\/benchmarks\/([A-Za-z0-9_.-]+\.(?:csv|json))/g)].map(
      (m) => m[1]!,
    );
    expect(named).toContain('ann.csv');
    expect(named).toContain('ann-duplicates.csv');
    for (const n of new Set(named))
      expect(existsSync(join(root, 'docs', 'benchmarks', n)), n).toBe(true);
  });

  it('says "not measured on 8 GB" and claims nothing published, audited, compliant or signed with a real key', () => {
    const t = text(file);
    expect(t).toContain('not measured on 8 GB');
    expect(t.toLowerCase()).toContain('what did not hold up');
    for (const bad of [
      /\bpublished on npm\b/i,
      /\baudited\b/i,
      /\bcompliant\b/i,
      /\bcost[- ]saving\b/i,
    ])
      expect(t, String(bad)).not.toMatch(bad);
  });

  it('docs/release.md says a draft exists and finishing it waits on the 8 GB figure (owner)', () => {
    expect(text('docs', 'release.md')).toContain(
      'Draft exists; finishing it waits on the 8 GB figure (owner)',
    );
  });
});

describe('docs/RELEASING.md (D4-05)', () => {
  const t = text('docs', 'RELEASING.md');

  it('has the owner steps numbered in order, each with a reason the team cannot do it', () => {
    const steps = [...t.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect(steps).toEqual(steps.map((_, i) => i + 1));
    const bodies = t.split(/^\d+\. \*\*/m).slice(1);
    for (const b of bodies.slice(0, 11))
      expect(b, b.slice(0, 40)).toMatch(/Why not the team|Why not/);
  });

  it('carries the exact gh commands: environment (reviewer, main-only branch policy, admins cannot bypass), secret, variables', () => {
    expect(t).toContain('gh api -X PUT repos/AirplaneMode-Labs/localdata/environments/release');
    expect(t).toContain('"can_admins_bypass": false');
    expect(t).toContain('deployment-branch-policies -f name=main -f type=branch');
    expect(t).toContain('gh secret set NPM_TOKEN --env release --repo AirplaneMode-Labs/localdata');
    expect(t).toContain('gh variable set RELEASE_KEY_ID --env release');
    expect(t).toContain('gh variable set RELEASE_PUBLISH_ARMED');
    expect(t).toContain('gh run view');
    expect(t).toContain('cp-sign canonical');
    expect(t).toContain('--no-expiry');
    expect(t).toContain('--trust-file docs/release-keys.json');
    expect(t).toContain('--expect-id localdata-release');
  });

  it('names token scope and expiry, and the revoke step', () => {
    expect(t).toMatch(/7 days or less/);
    expect(t).toMatch(/Revoke the npm token/);
  });

  it('never tells the owner to use a test key or the allow flag', () => {
    const sentence = 'never with a test key and never with `--allow-test-key`';
    expect(t).toContain(sentence);
    expect(t.replace(sentence, '')).not.toMatch(/--allow-test-key|--trust-test-key|rfc8032-1/);
  });

  it('TD-125: both variables are environment variables set with --env release; the workflow is armed just before approving and disarmed after; no repository variable', () => {
    const lines = t.split('\n').filter((l) => /gh variable (set|delete) /.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(3); // RELEASE_KEY_ID, RELEASE_PUBLISH_ARMED set, RELEASE_PUBLISH_ARMED delete
    for (const l of lines) expect(l, l).toContain('--env release');
    for (const name of ['RELEASE_KEY_ID', 'RELEASE_PUBLISH_ARMED'])
      expect(
        lines.some((l) => l.includes(name)),
        name,
      ).toBe(true);
    expect(t).toMatch(/no job-level `if:` reads a variable/i);
    expect(t).toMatch(/just before you approve/i);
    expect(t).toMatch(/disarm/i);
    // order: dispatch, then candidate check and signing, then arm, then approve, then revoke and disarm
    const at = (re: RegExp): number => {
      const m = re.exec(t);
      expect(m, String(re)).not.toBeNull();
      return m!.index;
    };
    const dispatch = at(/gh workflow run publish\.yml/);
    const check = at(
      /SOURCE_DATE_EPOCH=\$\(git log -1 --pretty=%ct\) node scripts\/release\/rehearse\.mjs/,
    );
    const sign = at(/cp-sign sign /);
    const arm = at(/gh variable set RELEASE_PUBLISH_ARMED/);
    const revoke = at(/Revoke the npm token/);
    expect(dispatch).toBeLessThan(check);
    expect(check).toBeLessThan(sign);
    expect(sign).toBeLessThan(arm);
    expect(arm).toBeLessThan(revoke);
  });

  it('S1-135: before signing, the owner compares the candidate tarball digest with an independent build of the same commit, not only gh run view metadata', () => {
    const step = t.split(/^\d+\. \*\*/m).find((b) => b.startsWith('Check the candidate'))!;
    expect(step, 'a step that checks the candidate').toBeDefined();
    expect(step).toContain('gh run view');
    expect(step).toContain(
      'SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) node scripts/release/rehearse.mjs',
    );
    expect(step).toMatch(/\.tgz` line of `candidate\/SHA256SUMS`/);
    expect(step).toMatch(/dist-release\/SHA256SUMS/);
    expect(step).toMatch(/REHEARSAL-test-key-NOT-A-RELEASE/); // the other independent build: the push CI's rehearsal artefact
    expect(step).toMatch(/diff -r/);
    // the independent build is made with the test key only to rebuild bytes; the candidate itself is never signed with it
    expect(step).toMatch(/Why not the team/);
  });

  it('BUG-T3-S7-22: a dated-CHANGELOG step comes before the tag and the dispatch, with its reason', () => {
    const steps = t.split(/^\d+\. \*\*/m).slice(1);
    const at = (head: string) => steps.findIndex((b) => b.startsWith(head));
    const changelog = at('Commit the dated CHANGELOG heading');
    const tag = at('Tag the reviewed commit');
    const dispatch = at('Dispatch the publish workflow');
    expect(changelog, 'the step exists').toBeGreaterThanOrEqual(0);
    expect(changelog).toBeLessThan(tag);
    expect(tag).toBeLessThan(dispatch);
    const b = steps[changelog]!.replace(/\s+/gu, ' ');
    expect(b).toContain('## [0.4.0-alpha.1] - <date>');
    expect(b).toContain('(untagged)');
    expect(b).toMatch(/README 8 GB cell/u);
    expect(b).toMatch(/only with your own measured figure/u);
    expect(b).toMatch(/tag commit must equal the run's commit/u);
    expect(b).toMatch(/only you choose the release date and hold the 8 GB laptop figure/u);
    expect(b).toMatch(/Why not the team/u);
    // the step numbers quoted in later steps still point at the right steps
    const num = (head: string) => at(head) + 1;
    expect(t).toContain(`after the dispatch (step ${num('Dispatch the publish workflow')})`);
    expect(t).toContain(`candidate check and signing (step ${num('Check the candidate')})`);
    expect(t).toContain(`and the token (step ${num('Create the registry token')})`);
  });

  it("BUG-T3-S7-16: step 3 or 4 carries the key.pub to base64 command, and it turns cp-sign's key.pub into the canonical publicKey", () => {
    const cmd = /^ *(node -e '.*' <KEYDIR>\/key\.pub)$/mu.exec(t)?.[1];
    expect(cmd, 'the command is in RELEASING.md').toBeDefined();
    expect(t.indexOf(cmd!)).toBeGreaterThan(t.indexOf('3. **Make the release key'));
    expect(t.indexOf(cmd!)).toBeLessThan(t.indexOf('5. **Create the `release` environment'));
    const vec = JSON.parse(text('scripts', 'release', 'vectors', 'keys', 'test-key.json')) as {
      keys: Array<{ keyId: string; publicKey: string }>;
    };
    const pubB64 = vec.keys[0]!.publicKey;
    const hex = Buffer.from(pubB64, 'base64').toString('hex');
    expect(hex).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const dir = mkdtempSync(join(tmpdir(), 'ld-keypub-'));
    try {
      writeFileSync(join(dir, 'key.pub'), `# cp-sign Ed25519 public key.\ned25519-public ${hex}\n`);
      const out = execFileSync(
        'node',
        [
          '-e',
          cmd!.slice("node -e '".length, cmd!.lastIndexOf("' <KEYDIR>")),
          join(dir, 'key.pub'),
        ],
        {
          encoding: 'utf8',
        },
      );
      expect(out.trim()).toBe(pubB64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is only owner steps: the closing section is what the team already did, and nothing there is a step', () => {
    const tail = t.slice(t.indexOf('## What the team already did'));
    expect(tail).not.toMatch(/^\d+\. /m);
  });
});

describe('READMEs and issue forms (TD-116, TD-117)', () => {
  it("README: 'Live demo:' within the first 12 lines, 'not measured on 8 GB', 'Nothing is published'", () => {
    const r = text('README.md');
    expect(r.split('\n').slice(0, 12)).toContain(
      'Live demo: https://airplanemode-labs.github.io/localdata/',
    );
    expect(r).toContain('not measured on 8 GB');
    expect(r).toContain('Nothing is published');
  });

  it('bug_report.yml and feature_request.yml carry the required no-real-documents checkbox', () => {
    for (const f of ['bug_report.yml', 'feature_request.yml']) {
      const t = text('.github', 'ISSUE_TEMPLATE', f);
      expect(t, f).toContain(
        'I have not attached any real, confidential or personal document (bank, legal, medical, identity). Any sample is synthetic or public.',
      );
      expect(t, f).toMatch(/required: true/);
      expect(t, f).toContain('SECURITY.md');
    }
    expect(text('.github', 'ISSUE_TEMPLATE', 'bug_report.yml')).toMatch(/redact/i);
  });

  it('config.yml turns blank issues off and links SECURITY.md', () => {
    const t = text('.github', 'ISSUE_TEMPLATE', 'config.yml');
    expect(t).toContain('blank_issues_enabled: false');
    expect(t).toContain('https://github.com/AirplaneMode-Labs/localdata/blob/main/SECURITY.md');
    expect(readdirSync(join(root, '.github', 'ISSUE_TEMPLATE')).sort()).toEqual([
      'bug_report.yml',
      'config.yml',
      'feature_request.yml',
    ]);
  });

  it('SECURITY.md says to report privately and never in a public issue', () => {
    const t = text('SECURITY.md');
    expect(t).toMatch(/privately and never in a public issue/);
  });

  it('CONTRIBUTING.md exists and points at SECURITY.md for vulnerabilities', () => {
    const t = text('CONTRIBUTING.md');
    expect(t).toContain('SECURITY.md');
    expect(t).toMatch(/real document/i);
  });
});
