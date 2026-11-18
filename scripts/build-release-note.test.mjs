import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BEN_PUBKEY,
  gitHistoryNotes,
  MAX_CHARS,
  buildReleaseEvent,
  formatReleaseNote,
  plainText,
  releaseUrl,
  ZAPSTORE_URL,
} from './build-release-note.mjs';

const tag = 'v1.4.2';
test('markdown headings, bold, italics, code and links become plain text', () => {
  assert.equal(
    plainText('### New\n\n- **Bold** and _italic_ with `code` and [help](https://example.com)'),
    'New\n\n• Bold and italic with code and help (https://example.com)',
  );
});
test('multiline HTML comments disappear, including commented bullets', () => {
  assert.equal(plainText('<!-- instructions\n- hidden\n-->\n- Visible'), '• Visible');
});
test('headline, four install links and matching hashtags', () => {
  const note = formatReleaseNote({ tag, notes: '- A fix' });
  assert.ok(note.startsWith('Lightning Piggy v1.4.2 is out ⚡🐷'));
  for (const value of [
    `Install\nZapstore (Android): ${ZAPSTORE_URL}\nAndroid APK: ${releaseUrl(tag)}`,
    'iOS TestFlight: https://testflight.apple.com/join/bzfvEecu',
    'Website: https://lightningpiggy.com/app',
    '#LightningPiggy #bitcoin #nostr',
  ])
    assert.ok(note.includes(value));
});
test('long notes preserve headings and first bullets across all sections', () => {
  const notes = ['New', 'Improved', 'Fixed']
    .map((heading) => `### ${heading}\n- First ${heading}\n- ${'Later '.repeat(400)}`)
    .join('\n\n');
  const note = formatReleaseNote({ tag, notes });
  assert.ok(note.length <= MAX_CHARS);
  for (const heading of ['New', 'Improved', 'Fixed']) {
    assert.ok(note.includes(`${heading}\n• First ${heading}`));
  }
  assert.ok(note.includes(`Full notes: ${releaseUrl(tag)}`));
});
test('an oversized first bullet remains bounded, even with emoji', () => {
  const note = formatReleaseNote({ tag, notes: `### New\n- ${'🐷'.repeat(5000)}` });
  assert.ok(note.length <= MAX_CHARS);
  assert.ok(note.includes('Full notes:'));
  assert.ok(!/[\uD800-\uDBFF]…/.test(note));
});
test('unsigned event uses Ben, kind 1, time, t tags and release r tag', () => {
  const event = buildReleaseEvent({ tag, notes: '- Fix', createdAt: 123 });
  assert.equal(event.pubkey, BEN_PUBKEY);
  assert.equal(event.kind, 1);
  assert.equal(event.created_at, 123);
  assert.equal(event.sig, undefined);
  assert.deepEqual(event.tags, [
    ['t', 'LightningPiggy'],
    ['t', 'bitcoin'],
    ['t', 'nostr'],
    ['r', releaseUrl(tag)],
  ]);
  assert.equal(event.content, formatReleaseNote({ tag, notes: '- Fix' }));
});
test('CLI event mode reads generated notes and emits unsigned JSON with current time', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notesFile = path.join(dir, 'notes.md');
  fs.writeFileSync(notesFile, '### Fixed\n\n- Restore sync (#1440)\n');
  const before = Math.floor(Date.now() / 1000);
  const event = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./build-release-note.mjs', import.meta.url)),
        '--tag',
        tag,
        '--notes-file',
        notesFile,
        '--event',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(event.pubkey, BEN_PUBKEY);
  assert.ok(event.created_at >= before && event.created_at <= Math.floor(Date.now() / 1000));
  assert.equal(event.sig, undefined);
  assert.match(event.content, /Restore sync \(#1440\)/);
});
test('invalid tags fail before constructing a release URL', () => {
  assert.throws(() => formatReleaseNote({ tag: '../main', notes: '- Fix' }), /Tag must/);
});

test('drops the TestFlight "What to test" title but keeps the sections', () => {
  const note = formatReleaseNote({
    tag,
    notes: '## What to test in the next release\n\n### New\n\n- **Shop.** Sell things.\n',
  });
  assert.doesNotMatch(note, /What to test/);
  assert.match(note, /^New\n\n• Shop\. Sell things\.$/m);
});

test('empty tag notes use tagged Git history without executing tag scripts', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-data-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Offline Test');
  git('config', 'user.email', 'offline@example.invalid');
  git('commit', '--allow-empty', '-qm', 'feat: Older release');
  git('tag', 'v1.4.1');
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.writeFileSync(path.join(repo, 'docs/RELEASE_NOTES_NEXT.md'), '<!-- - hidden -->');
  const marker = path.join(repo, 'executed');
  fs.writeFileSync(
    path.join(repo, 'scripts/build-testflight-changelog.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unsafe');`,
  );
  git('add', '.');
  git('commit', '-qm', 'fix: Tagged release fix (#123)');
  git('tag', tag);
  git('commit', '--allow-empty', '-qm', 'feat: After the release');
  const note = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('./build-release-note.mjs', import.meta.url)),
      '--tag',
      tag,
      '--repo-dir',
      repo,
      '--notes-file',
      path.join(repo, 'docs/RELEASE_NOTES_NEXT.md'),
    ],
    { encoding: 'utf8' },
  );
  assert.match(note, /• Tagged release fix/);
  assert.doesNotMatch(note, /Older release|After the release|hidden/);
  assert.equal(fs.existsSync(marker), false);
});

test('Git fallback for a first release ends at its tag and rejects invalid tags', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-history-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Offline Test');
  git('config', 'user.email', 'offline@example.invalid');
  git('commit', '--allow-empty', '-qm', 'feat: First release');
  git('tag', 'v1.0.0');
  git('commit', '--allow-empty', '-qm', 'fix: Future fix');
  assert.equal(gitHistoryNotes(repo, 'v1.0.0'), '- First release');
  assert.throws(() => gitHistoryNotes(repo, '--all'), /Invalid release tag/);
});
