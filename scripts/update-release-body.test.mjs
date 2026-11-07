import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { replaceSection } from './update-release-body.mjs';

const { parse } = createRequire(import.meta.url)('yaml');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = parse(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
const nostr = parse(
  fs.readFileSync(path.join(root, '.github/workflows/release-nostr-note.yml'), 'utf8'),
);
const step = (workflow, job, name) => workflow.jobs[job].steps.find((s) => s.name === name);
// The Release page (only) also says which per-ABI APK to download.
const androidDownloads = (tag) =>
  `### Android download\n\n- **Most phones:** \`lightning-piggy-${tag}-arm64-v8a.apk\`\n` +
  `- **Older 32-bit phones** (if that one won't install): \`lightning-piggy-${tag}-armeabi-v7a.apk\`\n\n` +
  'The APKs appear under Assets once the Android build finishes.';
const withDownloads = (notes) => `${notes.trim()}\n\n${androidDownloads('v1.0.0')}`;

function fixture(t, initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-body-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ body: 'Human notes\n', tag: 'v1.0.0', ...initial }));
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== 'release') process.exit(2);
if (args[1] === 'list') console.log(state.tag);
else if (args[1] === 'view') {
  if (args[2] !== state.tag) process.exit(1);
  const field = args[args.indexOf('--json') + 1];
  if (field === 'body') {
    // An edit made after content generation must survive the final re-read.
    if (state.pendingHumanEdit) {
      state.body += state.pendingHumanEdit;
      delete state.pendingHumanEdit;
      fs.writeFileSync(file, JSON.stringify(state));
    }
    console.log(state.body);
  } else if (field === 'isPrerelease') console.log(Boolean(state.prerelease));
  else if (field === 'tagName') console.log(state.tag);
  else process.exit(2);
} else if (args[1] === 'edit' && args[2] === state.tag) {
  state.body = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
  fs.writeFileSync(file, JSON.stringify(state));
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  return {
    dir,
    state: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    calls: () =>
      fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse),
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_STATE: state,
      FAKE_LOG: path.join(dir, 'calls'),
      RUNNER_TEMP: dir,
      RELEASE_REF: 'v1.0.0',
      TAG: 'v1.0.0',
      GITHUB_ENV: path.join(dir, 'env'),
      GITHUB_OUTPUT: path.join(dir, 'output'),
      GITHUB_REPOSITORY: 'LightningPiggy/lightning-piggy-mobile',
    },
  };
}

for (const order of [
  ['generated-notes', 'nostr-link'],
  ['nostr-link', 'generated-notes'],
]) {
  test(`both workflow updates preserve human notes and each other: ${order.join(' then ')}`, (t) => {
    const f = fixture(t, { pendingHumanEdit: '\nLast-minute human edit\n' });
    fs.writeFileSync(path.join(f.dir, 'release-notes.md'), '### Fixed\n- A shipped fix\n');
    fs.writeFileSync(path.join(f.dir, 'nostr-link.txt'), 'https://njump.me/nevent1example\n');
    const commands = {
      'generated-notes': step(release, 'release-notes', 'Append generated notes to GitHub Release')
        .run,
      'nostr-link': step(nostr, 'publish', 'Append note link to GitHub Release').run,
    };
    for (const section of order) {
      execFileSync('bash', ['-e', '-c', commands[section]], { cwd: root, env: f.env });
    }
    const body = f.state().body;
    assert.ok(body.startsWith('Human notes\n\nLast-minute human edit\n'));
    assert.ok(
      body.includes(
        `<!-- generated-notes -->\n${withDownloads('### Fixed\n- A shipped fix')}\n<!-- /generated-notes -->`,
      ),
    );
    assert.ok(
      body.includes(
        '<!-- nostr-link -->\nNostr release note: https://njump.me/nevent1example\n<!-- /nostr-link -->',
      ),
    );
    const calls = f.calls();
    assert.deepEqual(
      calls.map((args) => args[1]),
      ['view', 'edit', 'view', 'edit'],
    );
    // Retries refresh only the owned section and do not add another link or notes block.
    fs.writeFileSync(path.join(f.dir, 'release-notes.md'), 'Corrected notes\n');
    execFileSync('bash', ['-e', '-c', commands['generated-notes']], { cwd: root, env: f.env });
    assert.equal(
      f.state().body,
      replaceSection(body, 'generated-notes', withDownloads('Corrected notes')),
    );
    execFileSync('bash', ['-e', '-c', commands['nostr-link']], { cwd: root, env: f.env });
    assert.equal(
      f.state().body,
      replaceSection(body, 'generated-notes', withDownloads('Corrected notes')),
    );
    assert.equal(f.calls().at(-1)[1], 'view'); // Idempotent retry makes no write.
  });
}

test('section replacement leaves all bytes outside its block intact', () => {
  const body =
    'Human prefix\n<!-- generated-notes -->\nOld\n<!-- /generated-notes -->\nHuman suffix\n<!-- nostr-link -->\nKeep\n<!-- /nostr-link -->\n';
  assert.equal(replaceSection(body, 'generated-notes', 'New'), body.replace('\nOld\n', '\nNew\n'));
  assert.throws(
    () => replaceSection('<!-- generated-notes -->\nHuman text', 'generated-notes', 'New'),
    /Unclosed/,
  );
});

test('automatic Nostr updates follow successful Release completion and share the body lock', () => {
  assert.equal(nostr.on.release, undefined);
  assert.deepEqual(nostr.on.workflow_run, { workflows: ['Release'], types: ['completed'] });
  assert.ok(nostr.jobs.publish.if.includes("github.event.workflow_run.conclusion == 'success'"));
  assert.ok(nostr.jobs.publish.if.includes("github.event.workflow_run.event == 'release'"));
  assert.deepEqual(nostr.jobs.publish.concurrency, release.jobs['release-notes'].concurrency);
  assert.equal(nostr.jobs.publish.concurrency['cancel-in-progress'], false);
  assert.equal(step(nostr, 'publish', 'Checkout automation').with.ref, 'main');
  assert.equal(
    step(nostr, 'publish', 'Check secrets').if,
    "steps.release.outputs.enabled == 'true'",
  );
});

for (const scenario of [
  {
    name: 'completed tag run',
    branch: 'v1.0.0',
    manual: '',
    prerelease: false,
    enabled: true,
    fallback: false,
  },
  {
    name: 'branch payload falls back to latest published release',
    branch: 'main',
    manual: '',
    prerelease: false,
    enabled: true,
    fallback: true,
  },
  {
    name: 'empty branch falls back to latest published release',
    branch: '',
    manual: '',
    prerelease: false,
    enabled: true,
    fallback: true,
  },
  {
    name: 'automatic prerelease remains excluded',
    branch: 'v1.0.0',
    manual: '',
    prerelease: true,
    enabled: false,
    fallback: false,
  },
  {
    name: 'manual prerelease remains supported',
    branch: 'main',
    manual: 'v1.0.0',
    prerelease: true,
    enabled: true,
    fallback: false,
  },
]) {
  test(`tag resolution: ${scenario.name}`, (t) => {
    const f = fixture(t, { prerelease: scenario.prerelease });
    execFileSync('bash', ['-e', '-c', step(nostr, 'publish', 'Resolve release tag').run], {
      cwd: root,
      env: { ...f.env, MANUAL_TAG: scenario.manual, RUN_BRANCH: scenario.branch },
    });
    assert.equal(fs.readFileSync(f.env.GITHUB_ENV, 'utf8'), 'TAG=v1.0.0\n');
    assert.equal(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), `enabled=${scenario.enabled}\n`);
    assert.equal(
      f.calls().some((args) => args[1] === 'list'),
      scenario.fallback,
    );
  });
}
