#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const BEN_PUBKEY = '971615b70ad9ec896f8d5ba0f2d01652f1dfe5f9ced81ac9469ca7facefad68b';
export const HASHTAGS = ['LightningPiggy', 'bitcoin', 'nostr'];
export const MAX_CHARS = 4000;
export const releaseUrl = (tag) =>
  `https://github.com/LightningPiggy/lightning-piggy-mobile/releases/tag/${tag}`;
export const ZAPSTORE_URL = 'https://zapstore.dev/apps/com.lightningpiggy.app';

export function plainText(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^\n]+?)\*\*|__([^\n]+?)__/g, (_, a, b) => a ?? b)
    .replace(/(^|[\s(])[_*]([^\n]+?)[_*](?=[\s).,!:;]|$)/gm, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The notes file is written for TestFlight testers; its "What to test" title
// doesn't belong in a public announcement.
const TESTER_HEADING = /^[ \t]*#{1,6}[ \t]+What to test\b.*$/gim;

export function formatReleaseNote({ tag, notes: rawNotes }) {
  const notes = rawNotes.replace(TESTER_HEADING, '');
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) {
    throw new Error('Tag must look like vX.Y.Z (optionally with a prerelease suffix).');
  }
  const url = releaseUrl(tag);
  const headline = `Lightning Piggy ${tag} is out ⚡🐷`;
  const footer = `Install\nZapstore (Android): ${ZAPSTORE_URL}\nAndroid APK: ${url}\niOS TestFlight: https://testflight.apple.com/join/bzfvEecu\nWebsite: https://lightningpiggy.com/app\n\n${HASHTAGS.map((t) => `#${t}`).join(' ')}`;
  const text = plainText(notes);
  const render = (body) => `${headline}\n\n${body}\n\n${footer}`;
  if (render(text).length <= MAX_CHARS) return render(text);

  // Preserve section headings and distribute the budget across each section's
  // first bullet before including later bullets, rather than losing the tail.
  const clean = notes.replace(/<!--[\s\S]*?-->/g, '');
  const sections = [];
  for (const line of clean.split('\n')) {
    if (/^\s*#{1,6}\s/.test(line)) {
      sections.push({ heading: plainText(line), bullets: [] });
    } else if (/^\s*[-*+]\s/.test(line)) {
      if (!sections.length) sections.push({ heading: '', bullets: [] });
      sections.at(-1).bullets.push(plainText(line));
    }
  }
  const hint = `Full notes: ${url}`;
  const headingsSize = sections.reduce((sum, section) => sum + section.heading.length + 2, 0);
  const bulletCount = sections.filter((section) => section.bullets.length).length;
  const budget = MAX_CHARS - render(hint).length - headingsSize - bulletCount * 2 - 2;
  const share = Math.max(0, Math.floor(budget / Math.max(1, bulletCount)));
  const shorten = (value, length) => {
    if (value.length <= length) return value;
    // Don't split a surrogate pair at the truncation boundary.
    let cut = value.slice(0, Math.max(0, length - 1));
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  const summary = sections
    .map(({ heading, bullets }) =>
      [heading, bullets.length && share > 1 ? shorten(bullets[0], share) : '']
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n');
  const available = MAX_CHARS - render(hint).length - 2;
  return render(`${shorten(summary || text, available)}\n\n${hint}`);
}

export function buildReleaseEvent({ tag, notes, createdAt = Math.floor(Date.now() / 1000) }) {
  return {
    kind: 1,
    pubkey: BEN_PUBKEY,
    created_at: createdAt,
    tags: [...HASHTAGS.map((t) => ['t', t]), ['r', releaseUrl(tag)]],
    content: formatReleaseNote({ tag, notes }),
  };
}

// Read only Git objects from the data checkout; never execute its scripts.
export function gitHistoryNotes(repoDir, tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error('Invalid release tag.');
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const commit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  let previous;
  try {
    previous = git(['describe', '--tags', '--abbrev=0', `${commit}^`]);
  } catch {
    // First release: use at most the last 50 commits ending at the release tag.
  }
  const subjects = git([
    'log',
    '--pretty=format:%s',
    ...(previous ? [`${previous}..${commit}`] : ['-50', commit]),
  ]);
  const bullets = subjects.split('\n').flatMap((subject) => {
    const match = subject.match(/^(?:feat|fix|perf)(?:\([^)]+\))?!?:\s*(.+?)(?:\s*\(#\d+\))?$/i);
    return match ? [`- ${match[1]}`] : [];
  });
  return [...new Set(bullets)].join('\n') || 'Bug fixes and improvements.';
}

function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      'notes-file': { type: 'string' },
      'repo-dir': { type: 'string' },
      event: { type: 'boolean' },
    },
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const notesFile = values['notes-file'] && path.resolve(values['notes-file']);
  let notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';
  // Generated notes may be prose (including the default summary), not bullets.
  // Only absent, empty, or comment-only input needs the Git-history fallback.
  if (!plainText(notes)) {
    notes = gitHistoryNotes(path.resolve(values['repo-dir'] || root), values.tag);
  }
  const input = { tag: values.tag, notes };
  console.log(values.event ? JSON.stringify(buildReleaseEvent(input)) : formatReleaseNote(input));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
